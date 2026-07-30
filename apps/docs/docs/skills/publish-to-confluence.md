---
sidebar_position: 6
---

# Skill: publish-to-confluence

Publish a markdown doc (PRD / requirement card / spec) to Confluence, write the returned page id back into the source front-matter, and set an initial status label.

## When to use

- PRD / spec / requirement card is ready for review by non-engineering stakeholders
- You want Confluence as the review surface but Git as source of truth

## Pipeline position

Terminal step of the PRD pipeline. Pairs with `confluence-sync.js` (see [Confluence Sync guide](../guides/confluence-sync)) which pulls comments and status-label changes back into Git.

## Prerequisites

- Browser logged into Confluence **or** an HTTP client with API token
- Source file has a `doc_id` front-matter

## Skill body

````markdown
---
name: publish-to-confluence
description: Publish a markdown doc to Confluence; write back the page id to front-matter; set initial status-draft label
---

# Publish to Confluence

## Prerequisites

- Confluence login in the current browser session (or API token in env)
- Source file with `doc_id` front-matter and at least `title` + `status`

## Target

- Space key: `<your-space>` (replace)
- Page title format: `[<doc_id>] <title>` e.g. `[PRD-2026-0015] Self-serve onboarding`

## API calls (browser JS)

Create page:

```javascript
fetch("/wiki/rest/api/content", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({
    type: "page",
    title: pageTitle,
    space: { key: "YOUR_SPACE" },
    body: { storage: { value: htmlContent, representation: "storage" } },
  }),
});
```

Update existing page:

```javascript
// first fetch current version
const current = await fetch("/wiki/rest/api/content/{pageId}?expand=version");
const version = current.version.number;

fetch("/wiki/rest/api/content/{pageId}", {
  method: "PUT",
  body: JSON.stringify({
    type: "page",
    title: pageTitle,
    space: { key: "YOUR_SPACE" },
    version: { number: version + 1 },
    body: { storage: { value: htmlContent, representation: "storage" } },
  }),
});
```

Add status label:

```javascript
fetch("/wiki/rest/api/content/{pageId}/label", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify([{ prefix: "global", name: "status-draft" }]),
});
```

## After publishing — MANDATORY write-back

1. Read the source markdown
2. Update front-matter `related.confluence_page_id` with the returned id:
   ```yaml
   related:
     confluence_page_id: "123456789"
   ```
3. Save back
4. Report to the user:
   - File path
   - Confluence URL: `https://your-org.atlassian.net/wiki/spaces/YOUR_SPACE/pages/<id>`
   - Title

If `confluence_page_id` is already set in the source, use the **update** flow, not create. Don't create duplicate pages.

## Label convention (enables confluence-sync)

After publishing, add one `status-*` label. The `confluence-sync.js` cron reads these and updates front-matter `status`:

| Label | Status |
|---|---|
| `status-draft` | Draft |
| `status-in-review` | In Review |
| `status-approved` | Approved |
| `status-deprecated` | Deprecated |

New pages default to `status-draft`. Reviewers change the label in Confluence UI; the Git `status` field updates within 30 minutes.

## Next step

1. Notify reviewers via the relevant channel
2. For PRD: reviewers change label to `status-in-review` in Confluence
3. Subsequent edits: use the **update** flow (requires `version + 1`)
````

## Companion: automatic back-sync

See the [Confluence Sync guide](../guides/confluence-sync). Once a page is published + labeled, the cron job (`scripts/confluence-sync.js`) will:

- Pull new comments into a `## Confluence Comments` section of the source markdown
- Map the Confluence `status-*` label into the source's `front-matter.status`
- Auto-open a PR if anything changed

The publish step is what gets the page id recorded; the sync step is what keeps the two in step over time.
