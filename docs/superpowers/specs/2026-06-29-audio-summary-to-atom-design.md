# Audio summary → knowledge atom (react to save) — Design

**Date:** 2026-06-29
**Status:** Approved (design) + revised after a 6-agent design panel (6/6 APPROVE-WITH-CHANGES). Spec for implementation.

## Goal

Make Slack audio **meeting summaries searchable** via the pmk knowledge base. Today a summary is posted only to its thread (no atom), so `mra-ask` can't find it and there's no durable link back. This adds an opt-in path: a user reacts on a posted summary → the summary becomes an **approved** knowledge atom (with a Slack thread permalink, stored for audit) that `mra-ask` retrieves like any other atom.

Deferred sub-project flagged when the audio feature shipped (v0.28.0/v0.28.1).

## Context (how atoms work today — grounded)

- **Atom** = markdown + YAML at `~/.pmk/knowledge/<scope>/<id>.md`. Type `KnowledgeAtom` (`knowledge.ts:33`): `{ id, createdAt, scope, question, answer, summary?, tags[], source{threadKey, contributorUserId}, status?: "pending"|"approved", expiresAt?, approval? }`.
- **Curation gate:** atoms start `pending` (invisible to retrieval, 24h TTL) → `approved` via ✅-reaction / CLI / TTL auto-promote. **Only `approved` atoms are retrieved** (`searchAtoms`, `knowledge.ts:454`).
- **Retrieval (mra-ask):** `searchAtoms(text, {limit:3})` per free-chat turn (`free-chat-turn.ts:161`), approved-only, scoped to repo, BM25/TF-IDF when corpus ≥50 else keyword+tag scoring; injected via `formatAtomsForInjection` (`knowledge.ts:533`). **Top-3 injection slots are shared across all atoms.**
- **Permalink:** no field yet; `web.chat.getPermalink()` already used in the issue flow (`escalation.ts:167`).
- **No dedup; in-place `saveAtom` write.** `redactSecrets` (`audio/redact.ts`) currently only catches OpenAI `sk-*`, Slack `xox*`, and URLs.
- **Audio summary today:** `coordinator.ts` `post(summary.text)` + `appendAttachment` (raw transcript). `summarize.ts` returns `{ text, mode }`.
- **threadKey serialization:** the coordinator holds a typed `ThreadKey`; atoms store `"<channelId>:<threadTs>"`. The existing serializer used by `appendAttachment` is the single source of truth — the marker and the atom MUST use it.

## Decisions (post-panel)

1. **Curation = react-to-save.** Nothing on disk until the save reaction; on react the atom is created **directly `approved`** (no pending/TTL). Marker-then-react (below), unanimously preferred over reusing pending-atom + `approveAtom` (the 24h auto-promote can't be suppressed without invasive `loadAtoms` surgery that breaks the "nothing approved without an explicit react" invariant).
2. **Save reaction = 📚 (`:books:`), not ✅.** ✅ already means "approve a pending atom" in this codebase; overloading it on summary messages is ambiguous and risks mis-routing. 📚 on an audio-summary message = "save to knowledge base." *(One deviation from the originally-picked ✅ — see panel rationale; flagged for confirmation.)*
3. **Granularity = one atom per meeting.** Decomposition into per-decision atoms deferred (YAGNI).
4. **Authority = uploader or `config.admins`.** A non-authorized reactor gets a **mandatory** ephemeral note ("只有上傳者或管理員能存入知識庫"), never a silent no-op. A separate `config.atomApprovers` role is deferred.
5. **Permalink = stored in front-matter for CLI/audit only; NOT injected** into `formatAtomsForInjection`. Injecting a private-channel permalink would disclose the channel's existence/ts to non-members who match a query. (Resolves the retrieval-panel "cite source" wish against the security-panel disclosure risk — safety wins for v1.)

## Architecture & components

### 1. `summarize.ts` — emit retrieval-tuned title + tags
Return `{ text, mode, title, tags }`, produced in the **existing** summarize LLM call (no extra token cost):
- `title` (≤120 chars, the atom's `question`): MUST pack 2–3 key **decision/topic noun phrases**, not a generic meeting-type label ("週會"). Title is the highest-weighted retrieval field (3 pts keyword / BM25 chunk head) — a bland title retrieves poorly.
- `tags`: 3–6 lowercase keywords.
- The atom's `summary` field is set from a **dense, keyword-rich** one-liner (key decision + owner + topic). On parse failure, degrade: `title` = first non-empty summary line (truncated), `tags` = `[]`, `summary` omitted.

### 2. `knowledge.ts` — permalink (audit-only), atomic write, dedup
- Add `source.permalink?: string` to `KnowledgeAtom`; serialize/round-trip in YAML front-matter. **Do NOT render it in `formatAtomsForInjection`** (audit/CLI only).
- `saveAtom`: write to `<id>.md.tmp` then `fs.renameSync` → `<id>.md` (atomic; a mid-write crash never leaves a half-file the loader skips forever).
- Dedup: at the one call site, `loadAtoms({scope})` filtered by `source.threadKey === key` across **ALL statuses** (inline; no new export unless a 2nd caller appears).

### 3. `audio/atom-marker.ts` — ephemeral save record + mutex
On summary post, write `~/.pmk/gateway/audio-atom/<channelId>-<summaryTs>.json`:
```
{ threadKey, channelId, summaryTs, uploaderId, scope, title, tags, summaryText, at }
```
- `threadKey` serialized with the **same** util as `appendAttachment` (dedup breaks silently on a format mismatch).
- **Mutex on save:** the save path renames the marker to `<...>.saving` with `flag:"wx"` (atomic create) BEFORE the `await getPermalink`; `EEXIST` → another reaction is mid-save → skip. This closes the two-concurrent-📚 race that a plain `loadAtoms+filter` (sync) followed by `await` cannot.
- **retry hygiene:** before writing a new marker for a `threadKey`, delete any existing marker with the same `threadKey` (a `retry` posts a new summary; otherwise the stale first-run summary stays 📚-able and could canonicalize the worse summary).
- **Sweep:** `sweepStaleAudioAtomMarkers()` deletes markers older than **7 days**; **wired at gateway startup alongside `sweepStaleAudioClaims`** (covers orphan-on-crash). Hint text says "(7 天內有效)" so a late 📚 isn't a silent surprise.

### 4. `coordinator.ts` — write marker + hint
- `scope` arrives as a new `AudioRunArgs` field, resolved by the caller (the handler/free-chat owns scope resolution); coordinator does not re-resolve.
- On the success path only (after `post(summary.text)` with a known summary message ts): write the marker and append `_📚 對此摘要按 📚 可加進知識庫(之後 mra-ask 找得到,7 天內有效)_`. Failure paths write no marker.

### 5. `slack/index.ts` reaction handler → `AudioCoordinator.fromApproval()`
The handler stays a thin dispatcher (matching `review.fromReaction` / issue flows). On a 📚 reaction it calls `AudioCoordinator.fromApproval({ channelId, messageTs, reactorUserId })`, which:
1. Loads the `audio-atom` marker for `(channelId, messageTs)`; miss → return false (not our message).
2. Guard: reactor is `uploaderId` or in `config.admins`; else post the mandatory ephemeral note and stop.
3. Acquire the marker mutex (rename `.saving wx`; EEXIST → skip).
4. Dedup by `threadKey` (all statuses) → exists → reply "已在知識庫了 (id: …)", delete marker, stop.
5. `getPermalink` (degrade to none on failure) → build atom (`question=title`, `answer=summaryText` run through expanded `redactSecrets`, `summary`, `tags`, `scope`, `status:"approved"`, `source{threadKey, contributorUserId: uploaderId, permalink}`) → `saveAtom`.
6. Reply in thread `已加進知識庫 🔎 (id: \`${atom.id}\`)`; delete the marker/`.saving` file.

### 6. `audio/redact.ts` — broaden before content enters shared ground truth
A meeting summary becomes cross-user `mra-ask` ground truth, so `redactSecrets` (applied to `answer` on save) is widened beyond the current 3 patterns to also cover: emails, phone numbers, and common credential prefixes `AKIA…`, `gh[opsr]_…`, `glpat-…`, `AIza…`. Add a high-entropy-token **warning** (logged on save) when the count exceeds a threshold; hard-block deferred.

## Data flow

```
audio success → post(summary + 📚 hint) → write atom-marker(summaryTs → {threadKey, uploaderId, scope, title, tags, summaryText})
   → user reacts 📚
   → handler → AudioCoordinator.fromApproval: load marker → guard(uploader|admin, else ephemeral)
     → marker mutex (.saving wx) → dedup(threadKey, all statuses)
     → getPermalink → redact(answer) → saveAtom(approved, atomic tmp+rename, +permalink in front-matter)
     → reply "已加進知識庫 (id)" → delete marker
   → later: searchAtoms() retrieves it (approved); permalink stays out of the injected block
```

## Error handling

- Two concurrent 📚 → marker mutex (`wx`) admits one; the other skips.
- `getPermalink` fails → save atom without permalink (degrade, log).
- Marker missing (restart/swept/not a summary) → 📚 is a no-op; thread summary remains; audio re-runnable via `retry`.
- `summarize` title/tags parse failure → degrade (see §1); atom still saveable.
- `saveAtom` write failure → soft error reply; leave the marker (rename `.saving` back) so a retry 📚 can succeed.
- `retry` posts a new summary → old same-threadKey marker deleted at new-marker write; dedup also guards.

## Testing

- `summarize`: returns `title`+`tags`; title carries topic nouns; dense `summary`; degrades on malformed output.
- `knowledge`: atom with `source.permalink` round-trips; permalink **absent** from `formatAtomsForInjection`; atomic tmp+rename write; dedup by threadKey across statuses.
- `atom-marker`: write/read/delete/sweep; mutex (second `.saving` create → EEXIST); same-threadKey stale-marker deletion on new write; path-segment safety; shared threadKey serializer.
- `fromApproval` (mocked `web`): 📚 by uploader → `saveAtom` approved + permalink + correct mapping; non-uploader/non-admin → ephemeral note, no save; double-📚 / concurrent → one atom; marker missing → no-op; getPermalink failure → atom saved without permalink; reply includes atom id.
- `redact`: new patterns (email/phone/AKIA/gh_/glpat-/AIza) stripped from `answer`; high-entropy warning fires.
- `coordinator`: success writes marker + 📚 hint; failure paths write no marker; `scope` taken from `AudioRunArgs`.

## Scope / YAGNI — deferred

- **Per-decision decomposition** (one atom per meeting in v1).
- **LLM "sanitizer" pass** against prompt-injection persistence into atom ground truth. NOTE: this is a **system-wide** property — the existing escalation→atom flow shares it — not specific to audio; the human 📚 gate is the v1 mitigation. Track as separate KB hardening.
- **Membership-gated retrieval / `config.atomApprovers`** higher-stakes role. Also system-wide (the whole atom corpus retrieves regardless of querier); v1 keeps repo-scope + uploader/admin authority.
- **Audience-tier filtering** on atoms; **audio metadata** (duration/participants) fields.
- **Hint one-time-suppress** (suppress after a channel's first save) — v1 keeps a concise, time-bounded hint on each summary.
- **High-entropy hard-block** (v1 warns only).

## Panel review (2026-06-29)

6 agents (retrieval, curation-UX, architecture, failure-modes, security, product/YAGNI): **6/6 APPROVE-WITH-CHANGES**, no REWORK. Core (react-to-save marker, one-atom-per-meeting, summarize title+tags, threadKey dedup) unanimously endorsed. Changes above incorporate every HIGH/MED finding except the two flagged system-wide security items (sanitizer pass, membership-gated retrieval), deferred with rationale. Conflicts resolved: permalink → front-matter-only (security > retrieval citation); authority → uploader/admin kept (security > wider curation), with mandatory feedback to others.
