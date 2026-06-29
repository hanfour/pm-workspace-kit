# Audio summary → knowledge atom (react ✅ to save) — Design

**Date:** 2026-06-29
**Status:** Approved (design); spec for implementation

## Goal

Make Slack audio **meeting summaries searchable** via the pmk knowledge base. Today a summary is posted only to its thread (no atom), so `mra-ask` can't find it and there's no durable link back. This adds an opt-in path: a user reacts ✅ on a posted summary → the summary becomes an **approved** knowledge atom (with a Slack thread permalink) that `mra-ask` retrieves like any other atom.

This is the deferred sub-project flagged when the audio feature shipped (v0.28.0/v0.28.1).

## Context (how atoms work today — grounded)

- **Atom** = markdown + YAML front-matter at `~/.pmk/knowledge/<scope>/<id>.md`. Type `KnowledgeAtom` in `packages/cli/src/gateway/knowledge.ts:33`: `{ id, createdAt, scope, question, answer, summary?, tags[], source{threadKey, contributorUserId}, status?: "pending"|"approved", expiresAt?, approval?{channelId, messageTs} }`.
- **Curation gate:** atoms start `pending` (invisible to retrieval, 24h TTL) and become `approved` via ✅-reaction (`slack/index.ts` `handleReactionAdded`), CLI (`pmk gateway atoms approve`), or TTL auto-promote. **Only `approved` atoms are retrieved** (`searchAtoms`, `knowledge.ts:454`).
- **Retrieval (mra-ask):** `searchAtoms(text, {limit:3})` on every free-chat turn (`free-chat-turn.ts:161`), approved-only, scoped to repo, BM25/TF-IDF when corpus ≥50 else keyword+tag scoring; injected as ground truth via `formatAtomsForInjection` (`knowledge.ts:533`).
- **Permalink:** no `permalink` field on atoms yet, but `web.chat.getPermalink()` is already used in the issue-candidate flow (`escalation.ts:167`).
- **No dedup:** `saveAtom` overwrites by id; distinct ids never merge.
- **Audio summary today:** `coordinator.ts` posts the summary via `post(summary.text)` and stores the raw transcript via `appendAttachment` (thread context, not an atom). `summarize.ts` returns `{ text, mode }`.

## Decisions

1. **Curation = react-to-save.** Nothing enters the KB until a ✅. On ✅ the atom is created **directly `approved`** (the ✅ *is* the approval — no 24h TTL pending state). No ✅ → nothing stored on disk (only a short-lived marker, auto-swept).
2. **Granularity = one atom per meeting.** The whole summary is one atom. Decomposing into per-decision atoms is deferred (YAGNI).
3. **Who can save = the uploader or a configured admin** (`config.admins`). Mirrors the escalation flow's "reactor must be the contributor" guard, widened to admins.
4. **❌ = no-op in v1** (just don't react). No reject path needed since nothing is pre-created.

## Architecture & components

### 1. `summarize.ts` — emit title + tags
Extend the summary result to `{ text, mode, title, tags }`:
- `title`: ≤120-char meeting topic (the atom's `question`).
- `tags`: 3–6 lowercase keywords (the atom's `tags`).

Produced in the **existing** summarize LLM call (no extra token cost). On parse failure, degrade: `title` = first non-empty summary line (truncated), `tags` = `[]`.

### 2. `knowledge.ts` — add permalink
- Add `source.permalink?: string` to `KnowledgeAtom` and persist/round-trip it (YAML front-matter).
- `formatAtomsForInjection` includes the permalink when present (so mra-ask answers can cite "出處: <link>").
- New helper `findAtomByThreadKey(threadKey, scope)` for dedup (or reuse `loadAtoms` + filter).

### 3. New marker — `audio-atom` pending-save record
When the coordinator posts a summary, write `~/.pmk/gateway/audio-atom/<channelId>-<summaryTs>.json`:
```
{ threadKey, channelId, summaryTs, uploaderId, scope, title, tags, summaryText, at }
```
This maps the ✅-able message (`summaryTs`) to everything needed to build the atom — so the reaction handler needs no LLM call and no thread re-fetch. New module `audio/atom-marker.ts` (write/read/delete/sweep), mirroring `audio/claim.ts`. Path-segment-safe (`assertSafeSegment`). Swept on startup: markers older than **7 days** are deleted (a ✅ that hasn't happened in a week won't).

`scope` is resolved the same way a free-chat turn resolves its repo scope for the channel/user (the coordinator already has `channelId`/`userId`/`tier`); default `"general"` when none. Computed once at marker-write time so the ✅ path doesn't re-resolve.

### 4. `coordinator.ts` — write the marker + hint
After `await post(summary.text + extra)` (only on the success path, when an `ackTs`/summary message exists), write the marker and append the hint line `_✅ 對此摘要按讚即可加進知識庫(之後 mra-ask 找得到)_` to the posted text.

### 5. `slack/index.ts` `handleReactionAdded` — the ✅ → save path
On a ✅ reaction:
1. Look up an `audio-atom` marker by `(channelId, messageTs)`. Miss → fall through to existing reaction handling (escalation approval etc.).
2. Guard: reactor is the marker's `uploaderId` **or** in `config.admins`. Else ignore (optionally a quiet ephemeral note).
3. Dedup: if an approved atom already exists with `source.threadKey === marker.threadKey`, skip creating a second; confirm "已在知識庫了" and delete the marker.
4. Build `KnowledgeAtom`: `question=title`, `answer=summaryText`, `summary`=first non-empty line/sentence of `summaryText` (≤200 chars; omit if not cleanly derivable — the field is optional), `tags`, `scope`, `status:"approved"`, `source:{threadKey, contributorUserId: uploaderId, permalink}`.
5. `web.chat.getPermalink({channel, message_ts: threadTs})` for the permalink (degrade to no permalink on failure).
6. `saveAtom(atom)`; reply in thread `已加進知識庫 🔎`; delete the marker.

## Data flow

```
audio job success → post(summary + hint) → write audio-atom marker(summaryTs → {threadKey, uploaderId, title, tags, summaryText, scope})
   → user reacts ✅ on the summary message
   → handleReactionAdded: find marker → guard(uploader|admin) → dedup(threadKey)
   → getPermalink → saveAtom(approved, +permalink) → reply "已加進知識庫" → delete marker
   → later: mra-ask searchAtoms() retrieves it (approved) → formatAtomsForInjection cites the permalink
```

## Error handling

- `getPermalink` fails → save the atom **without** a permalink (degrade, log).
- Marker missing (gateway restarted, marker swept, or message isn't a summary) → ✅ is a no-op for this path; the thread summary is still there and the audio can be re-run via `retry`.
- `summarize` title/tags parse failure → degrade as above; the atom is still saveable.
- Double ✅ / two users ✅ → dedup by `threadKey` yields one atom.
- `saveAtom` write failure → reply with a soft error; leave the marker so a retry ✅ can succeed.

## Testing

- `summarize`: returns `title` + `tags`; degrades on malformed LLM output.
- `knowledge`: atom with `source.permalink` round-trips through save/load; `formatAtomsForInjection` includes the permalink; `findAtomByThreadKey` dedup.
- `atom-marker`: write/read/delete/sweep; path-segment safety.
- reaction → save (unit, mocked `web`): ✅ by uploader → `saveAtom` called with approved + permalink + correct mapping; ✅ by non-uploader/non-admin → no save; double-✅ → one atom; marker missing → no-op; getPermalink failure → atom saved without permalink.
- coordinator: success path writes the marker + appends the hint; failure paths write **no** marker.

## Scope / YAGNI (deferred)

- No decomposition into per-decision atoms (one atom per meeting).
- No audience-tier filtering on atoms (atoms remain tier-agnostic, as today).
- No audio metadata fields (duration/participants) on the atom beyond the permalink.
- Channel (non-DM) audio is out of scope for the save path in v1 if the audio feature itself is DM/thread-scoped; revisit if channel audio lands.
- No edit-before-save UI; curate later via `pmk gateway atoms edit`.
