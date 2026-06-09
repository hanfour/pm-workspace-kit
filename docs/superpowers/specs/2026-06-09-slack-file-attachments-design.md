# Slack File Attachments — Design

**Date:** 2026-06-09
**Status:** Draft (awaiting user review)
**Component:** `packages/cli` gateway (Slack adapter)

## Problem

The gateway bot is text-only: the Slack message/app_mention handlers read only
`event.text` and ignore `event.files`. When a user uploads documents (PDFs,
markdown, code) with a caption, the bot sees only the caption and replies as if
the message were incomplete ("did you mean to attach something?"). Users cannot
give the bot reference documents to reason over.

## Goal

Let users attach files to a DM or channel @-mention and have the bot read them
as reference context for the rest of that thread's conversation. Supported file
types: **text/markdown/code, PDF, and images** (PNG/JPEG/GIF/WebP via Claude's
native vision). Attached content persists for the **whole thread** so follow-up
turns can reference it without re-uploading.

## Approach (chosen: B — dedicated attachment pipeline, separated context)

A standalone `attachments/` subsystem, kept separate from conversation messages.
Each file is downloaded, extracted to a **canonical text representation** at
ingestion time (PDF → text, image → one-time vision-generated description,
text → itself), and stored in a per-thread `attachments.jsonl` that is distinct
from `session.json`. Each turn, the stored attachments are re-assembled into an
"attachment context" and injected into the LLM call as a prefix (alongside the
existing `retrievalPrefix` atoms) — never merged into `session.messages`.

Rationale for B over inlining into the session: clean separation of reference
docs from dialogue, a typed extractor registry that is easy to extend, and a
uniform text representation that slots into the existing message-prefix
mechanism. The cost (a small assembly layer) is acceptable.

## Module structure

```
src/gateway/attachments/
  types.ts          — Attachment / ExtractedAttachment / AttachmentExtractor interfaces
  download.ts       — fetchSlackFile(file, botToken) → Buffer (url_private_download + Bearer auth)
  registry.ts       — pick extractor by mimetype/filetype (allowlist; unknown → unsupported)
  extractors/
    text.ts         — text/markdown/code → string (UTF-8 direct)
    pdf.ts          — PDF Buffer → string (unpdf, pure JS; ESM → dynamic import())
    image.ts        — image Buffer → text description (Claude vision, one call)
  store.ts          — per-thread attachment store: append/load attachments.jsonl
  assemble.ts       — build the attachment-context message from stored attachments (capped)
  ingest.ts         — orchestrator: event.files → download → extract → store → summary
```

### Storage location (per-thread, aligned with v0.21.3 thread-keying)

- DM: `~/.pmk/gateway/slack/users/<userId>/threads/<sessionThreadTs>/attachments.jsonl`
- Channel: `~/.pmk/gateway/slack/channels/<channelId>/threads/<sessionThreadTs>/attachments.jsonl`

`sessionThreadTs` is the same key the session uses (`thread_ts ?? event.ts`),
so attachments live beside the thread session they belong to. The `threadKey`
passed through the pipeline is a discriminated descriptor — `{ kind: "dm",
userId, threadTs }` or `{ kind: "channel", channelId, threadTs }`.

**Path safety (finding #6):** `userDir`/`channelDir` in `session-store.ts` are
private and already apply `assertSafeSegment` to every Slack-ID path segment (the
v0.19.1 path-traversal guard). The attachment store MUST NOT hand-roll an
unsanitised path. Resolution: export a shared `attachmentLogPath(threadKey)` from
`session-store.ts` (reusing its `assertSafeSegment` + `userDir`/`channelDir`), and
have `store.ts` call it. Every `userId` / `channelId` / `threadTs` segment passes
through `assertSafeSegment` — no exception.

**Store idempotency (finding #7):** `store.append(threadKey, attachment)` is
idempotent per `fileId` within a thread — appending a `fileId` already present is
a no-op (skip, not duplicate). `ingest` checks the store for an existing `fileId`
BEFORE downloading or running vision, so a Slack event retry (`retry_num > 0`), a
daemon restart mid-turn, or a user re-sending the same file does not re-download,
re-pay the image-vision cost, or duplicate the attachment context. (Slack
`file.id` is stable per uploaded file.)

## Data flow

1. A Slack `message` (DM, subtype `file_share`) or `app_mention` (channel) event
   arrives carrying `event.files[]`.
2. **Empty-text guard bypass (finding #1):** the current handlers bail on empty
   text (`if (!text) return;` at index.ts:402 for DM, :519 for channel after
   stripping the mention). A file-only upload has no caption, so the guard MUST
   be relaxed to `if (!text && files.length === 0) return;`. When text is empty
   but files exist, the turn runs with a synthetic prompt: `「(使用者上傳了檔案但沒有
   附訊息) 請先讀附件,簡述每份內容並問使用者想用它做什麼。」`.
3. **Ingestion point (finding #3):** ingestion runs at the start of the shared
   `FreeChatTurnRunner.run()`, which receives `files` + `threadKey`. For DM,
   `handleDmMessage` always reaches it. For channels, `ChannelMentionHandler.run()`
   calls `freeChatTurn.run()` ONLY in the non-case branch (`!meta.activeCase`,
   channel-mention.ts:89) — so an active-case channel never downloads or persists
   attachments (it posts a short "attachments aren't supported in case mode" note
   and proceeds with the case turn). This keeps case-mode genuinely out of scope.
   The run calls `ingestAttachments({ files, threadKey, botToken, llm })`.
4. `ingest.ts`, per file (skipping any `fileId` already in the thread's store — see
   idempotency, finding #7):
   - `registry.pick(mimetype/filetype)` → extractor or `unsupported`.
   - `download.fetchSlackFile(file, botToken)` → Buffer (reject if `file.size > MAX_FILE_BYTES`).
   - `extractor.extract(buf, { llm })` → canonical text (capped to `FILE_EXTRACT_CAP`).
     For images, this makes one Claude vision call to produce a description.
   - `store.append(threadKey, { fileId, name, mimetype, text, at })` → `attachments.jsonl`.
   - Collect per-file status: `ok` / `unsupported` / `failed` (+reason).
5. `ingest` returns a summary of which files were read vs skipped/failed. Failures
   are surfaced to the user (never silently dropped).
6. The turn calls `assemble.loadAttachmentContext(threadKey)` → an attachment-context
   message (capped to `MAX_ATTACHMENT_CONTEXT_CHARS`).
7. LLM messages = `[retrievalPrefix (atoms)] + [attachment context] + [conversation history] + [new message]`.

**Injection point:** the attachment context is a new per-turn prefix loaded
fresh from `attachments.jsonl` at LLM-call time — analogous to the existing
`retrievalPrefix`. It is NOT written into `session.messages`. This keeps
reference docs separate from dialogue and automatically inherits the per-thread
keying.

**Context budgeting & retry (finding #4):** the attachment prefix MUST be counted
in the pre-call token budget, not just appended at assembly. Concretely:
`pruneSessionIfNeeded` (free-chat-turn.ts:162) already takes `extra` — the
attachment prefix is added to that `extra` so the pre-call budget sees it, AND
the same prefix is passed to BOTH the first-call and the mra **synthesise** call
(currently synthesise only re-uses session.messages). Under a context-too-long
retry, `chatWithContextRetry` can only prune `session.messages`; an oversized
attachment prefix it cannot fix would loop. So the prune/drop order is defined:
(1) `assemble` first truncates the attachment context to `MAX_ATTACHMENT_CONTEXT_CHARS`;
(2) if a context-too-long error still fires, the retry path additionally halves
the attachment-context cap for that call (down to a floor) before pruning session
messages — so a doc-heavy turn degrades gracefully instead of dead-ending. A
`message.capped kind=attachment` event records any truncation.

**Timing:** ingestion (download + extract + store) completes before the turn
assembles context. A single message may carry multiple files.

**Dependency:** `ingest` needs the `llm` provider only for the image-vision
extraction step (see Provider capability below); text and PDF need no LLM.

## Extractor registry

| Category | Match | Extractor |
|----------|-------|-----------|
| Text | `text/*`, `application/json`, Slack `filetype` ∈ {markdown, text, code languages} | `text.ts` |
| PDF | `application/pdf` | `pdf.ts` |
| Image | `image/png` \| `image/jpeg` \| `image/gif` \| `image/webp` (Claude vision formats) | `image.ts` |
| Other | docx/xlsx/zip/svg/tiff/… | → `unsupported` (clear per-file message) |

### Extractors

- **text.ts** — `buf.toString("utf8")`, reject if the content looks binary (e.g.
  contains NUL bytes / a high ratio of non-printable bytes), cap to `FILE_EXTRACT_CAP`.
- **pdf.ts** — `await import("unpdf")` then `extractText`; an encrypted or
  empty/no-text PDF returns a clear reason rather than throwing; cap output.
- **image.ts** — validate format + size (`MAX_IMAGE_BYTES`); call the provider's
  `describeImage()` capability (see below) with the prompt "Describe this image's
  content for use as reference context; transcribe any text verbatim." Returns the
  description, capped. If the active provider lacks `describeImage`, the file is
  reported `unsupported` with a clear "image reading needs the ANTHROPIC_API_KEY
  provider" message — text/PDF are unaffected.

### Provider capability for vision (finding #2)

The current contract is text-only: `ChatMessage.content` is `string`
(packages/shared/src/index.ts:40) and `LlmProvider.chat()` takes `ChatMessage[]`
(packages/cli/src/llm/provider.ts:14). Rather than broadly multimodalising
`ChatMessage`, add a narrow, OPTIONAL capability to the provider interface:

```ts
// provider.ts
describeImage?(
  image: { data: Buffer; mimetype: string },
  prompt: string,
  opts?: ChatOptions,
): Promise<string>;
```

- `AnthropicApiKeyProvider` (anthropic-api.ts) implements it via
  `messages.create` with an `{ type: "image", source: { type: "base64", … } }`
  content block — vision-capable.
- `ClaudeAgentProvider` (claude-agent.ts) leaves it undefined for the MVP (the
  Claude Code SDK `query()` image path is not plumbed here).
- The image extractor checks `typeof llm.describeImage === "function"`; if absent,
  images fall to the `unsupported` path above. So when only the claude-login
  provider is active, text + PDF still work and images degrade gracefully with a
  clear message — no broad refactor, no crash.

## Limits (constants; reuse `capMessageContent` + `message.capped` events)

| Constant | Default | Purpose |
|----------|---------|---------|
| `MAX_FILE_BYTES` | 10 MB | reject download by `file.size` before fetching |
| `MAX_IMAGE_BYTES` | 5 MB (decoded) | Anthropic vision's documented per-image limit is 5 MB; we cap the decoded file bytes conservatively at 5 MB and reject over (NO native downscaling lib). (Request-level cap is 32 MB, not relevant for our single-image-per-call describeImage.) |
| `MAX_FILES_PER_MESSAGE` | 10 | cap files processed per message |
| `FILE_EXTRACT_CAP` | 30_000 chars | per-file canonical text cap |
| `MAX_ATTACHMENT_CONTEXT_CHARS` | 60_000 chars | total assembled context cap (drop oldest / truncate over) |

New dependency: **`unpdf`** (pure JS, no native build; ESM-only → loaded via
dynamic `import()` from the CJS build). Fallback if ESM interop bites:
`pdfjs-dist` legacy build.

## Error handling (fail-soft, explicit, never silent)

| Situation | Behaviour |
|-----------|-----------|
| Download 403 (scope missing / no access) | One clear message: the Slack app needs `files:read` — update + reinstall. (403 distinguished from other errors.) |
| Unsupported file type | "I can't read `.xlsx` yet; supported: text/markdown/code, PDF, PNG/JPEG/GIF/WebP." Skip that file, continue others. |
| Image, but active provider has no `describeImage` (claude-login only) | "I can read this image's text only with the ANTHROPIC_API_KEY provider; skipped `<name>`." Text/PDF unaffected. |
| File too large | "`<name>` exceeds the 10 MB limit — skipped." |
| Extraction failure (corrupt/encrypted PDF, bad image) | "Couldn't extract `<name>` (encrypted PDF?) — skipped." Continue others. |
| Partial success | Use what was read; the reply carries a compact summary line: `_read: a.md, spec.pdf · skipped: x.xlsx (unsupported)_`. |
| No files / all unsupported | Fall through to the normal text turn; existing behaviour unchanged. |

**No-leak:** download/extract error messages MUST NOT contain the bot token or
the signed `url_private` URL. Host-side log gets detail; the user sees a friendly
message only.

## Slack scope prerequisite (hard)

- Add `files:read` to `manifest.template.json` bot scopes.
- This is a NEW scope → the host must **update + reinstall the Slack app**. Without
  it every download returns 403 (handled by the friendly message above).
- Extend the event interfaces: both `MessageEvent` and `AppMentionEvent` gain
  `files?: SlackFile[]` (DM uploads arrive as `message` + `file_share` subtype;
  channel uploads as `app_mention` with `files`).
- Document the reinstall in `apps/docs/docs/gateway/onboarding.md`.

## Testing (TDD)

**Unit (per module, injected deps):**
- `text.ts`: md/code buffer → string; binary buffer → rejected + reason; cap applies.
- `pdf.ts`: small PDF fixture → extracted text contains a known string; encrypted/empty → reason.
- `image.ts`: fake llm (scripted vision) → description; oversized → reject; unsupported format → reason.
- `registry.ts`: table-driven mimetype/filetype → correct extractor or unsupported.
- `download.ts`: mock fetch — 200 → Buffer; **403 → scope error**; size > cap → rejected.
- `store.ts`: append + load round-trip (per-thread `attachments.jsonl`, JSONL atomic append).
- `assemble.ts`: load → context message; **total-cap truncation**; empty → no prefix.
- `ingest.ts`: injected deps; multi-file mixed outcomes (ok/unsupported/failed) → correct store writes + summary; **no-leak assertion** (error strings never contain token / url_private).

**Integration (slack-adapter harness; extend `dmMessagePayload`/`appMentionPayload`
with `files` + a fake download):**
- DM/app_mention with files → the LLM call's messages include the attachment context (e.g. extracted "Onetoken" text).
- A follow-up turn in the same thread (no new files) STILL sees the attachment context (whole-thread persistence).
- **File-only DM (empty caption) → ingests + runs the synthetic-prompt turn, not dropped** (finding #1).
- **Mention-only channel upload (caption is just `<@bot>`) → ingests, not dropped** (finding #1).
- **Active-case channel upload → attachments ignored (no download/persist), case turn runs** (finding #3).
- **Image when provider lacks `describeImage` → unsupported/fallback message, text/PDF still read** (finding #2).
- **Doc-heavy turn → attachment prefix counted in budget; context-too-long retry shrinks the attachment cap and still answers** (finding #4).
- **Duplicate `fileId` (Slack retry / resend) → ingested once; no second download or vision call** (finding #7).
- 403 download → friendly `files:read` message, no crash.
- Unsupported-only message → normal text turn.

**Fixtures:** a tiny valid PDF (with a known string) and a small PNG in `test/fixtures/`.
Caps and no-leak pinned by tests. Target ≥80% coverage on new modules.

## Out of scope

- **Channel case-mode** (`/pmk open <case>`) attachments — ingestion hooks into the
  free-chat path only (DM + channel-without-active-case). Case mode has its own
  message/persistence model; attachments there are a later, separate decision.
- OCR / non-Claude vision (images use Claude's native vision only).
- Office formats (docx/xlsx/pptx), archives.
- Persisting attachments into PKB knowledge (atoms) — the chosen lifetime is
  whole-thread, not permanent/global.
- Image downscaling (oversized images are rejected, not resized).
- Re-sending raw image bytes every turn (images persist as a text description
  after the first vision call).
