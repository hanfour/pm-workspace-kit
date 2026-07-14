// packages/core/test/confluence-sync.test.js
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const matter = require("gray-matter");

const {
  authHeader,
  apiGet,
  fetchLabels,
  fetchComments,
  extractPlainText,
  statusFromLabels,
  applyStatusChange,
  appendComments,
} = require("../src/confluence-sync.js");

describe("statusFromLabels", () => {
  it("maps a known label to its status", () => {
    assert.equal(statusFromLabels(["status-approved"]), "Approved");
    assert.equal(statusFromLabels(["status-in-review"]), "In Review");
    assert.equal(statusFromLabels(["status-deprecated"]), "Deprecated");
    assert.equal(statusFromLabels(["status-draft"]), "Draft");
  });
  it("honours precedence when several status labels are present", () => {
    // approved is first in LABEL_TO_STATUS, so it wins over draft
    assert.equal(statusFromLabels(["status-draft", "status-approved"]), "Approved");
  });
  it("returns null when no status label is present", () => {
    assert.equal(statusFromLabels(["some-other-label"]), null);
    assert.equal(statusFromLabels([]), null);
  });
});

describe("applyStatusChange", () => {
  const makeFile = (status) => {
    const data = { doc_id: "PRD-1", title: "T", status };
    return { data, content: "body text\n" };
  };

  it("reports no change when nextStatus is null", () => {
    assert.deepEqual(applyStatusChange(makeFile("Draft"), null), { changed: false });
  });

  it("reports no change when the status already matches", () => {
    assert.deepEqual(applyStatusChange(makeFile("Approved"), "Approved"), {
      changed: false,
    });
  });

  it("rewrites the front-matter status and preserves the body", () => {
    const file = makeFile("Draft");
    const res = applyStatusChange(file, "Approved");
    assert.equal(res.changed, true);
    assert.equal(res.previous, "Draft");
    assert.equal(res.next, "Approved");
    const reparsed = matter(res.content);
    assert.equal(reparsed.data.status, "Approved");
    assert.equal(reparsed.data.doc_id, "PRD-1");
    assert.match(reparsed.content, /body text/);
  });

  it("does not mutate the input file's data (immutability)", () => {
    const file = makeFile("Draft");
    applyStatusChange(file, "Approved");
    assert.equal(file.data.status, "Draft");
  });
});

describe("appendComments", () => {
  const comment = (over = {}) => ({
    id: "c1",
    kind: "inline",
    author: "u123",
    createdAt: "2026-01-01T00:00:00Z",
    text: "looks good",
    resolved: false,
    ...over,
  });

  it("reports no change for an empty comment list", () => {
    const res = appendComments("existing\n", []);
    assert.deepEqual(res, { changed: false, content: "existing\n" });
  });

  it("appends a new section at EOF when none exists", () => {
    const res = appendComments("# Doc\n\nbody\n", [comment()]);
    assert.equal(res.changed, true);
    assert.match(res.content, /## Confluence 意見彙總/);
    assert.match(res.content, /\*\*\[inline\]\*\*/);
    assert.match(res.content, /author `u123`/);
    assert.match(res.content, /> looks good/);
  });

  it("inserts under an existing section header instead of duplicating it", () => {
    const existing = "# Doc\n\n## Confluence 意見彙總\n\n- old comment\n";
    const res = appendComments(existing, [comment({ id: "c2", text: "new one" })]);
    assert.equal(res.changed, true);
    // exactly one section header
    const headers = res.content.match(/## Confluence 意見彙總/g);
    assert.equal(headers.length, 1);
    assert.match(res.content, /new one/);
    assert.match(res.content, /old comment/);
  });

  it("marks resolved comments and indents multi-line bodies", () => {
    const res = appendComments("body\n", [
      comment({ resolved: true, text: "line1\nline2" }),
    ]);
    assert.match(res.content, /\*\(resolved\)\*/);
    assert.match(res.content, /> line1\n {2}> line2/);
  });
});

describe("extractPlainText", () => {
  it("returns empty string for null / undefined body", () => {
    assert.equal(extractPlainText(null), "");
    assert.equal(extractPlainText(undefined), "");
  });

  it("walks an atlas_doc_format ProseMirror tree and joins text nodes", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
      ],
    };
    const body = { atlas_doc_format: { value: JSON.stringify(adf) } };
    assert.equal(extractPlainText(body), "Hello world");
  });

  it("returns empty string for malformed atlas_doc_format JSON", () => {
    const body = { atlas_doc_format: { value: "{not json" } };
    assert.equal(extractPlainText(body), "");
  });

  it("walks a raw ProseMirror object when atlas_doc_format is absent", () => {
    const body = { type: "doc", content: [{ type: "text", text: "raw" }] };
    assert.equal(extractPlainText(body), "raw");
  });
});

describe("authHeader", () => {
  const saved = {};
  beforeEach(() => {
    saved.email = process.env.CONFLUENCE_EMAIL;
    saved.token = process.env.CONFLUENCE_API_TOKEN;
  });
  afterEach(() => {
    if (saved.email === undefined) delete process.env.CONFLUENCE_EMAIL;
    else process.env.CONFLUENCE_EMAIL = saved.email;
    if (saved.token === undefined) delete process.env.CONFLUENCE_API_TOKEN;
    else process.env.CONFLUENCE_API_TOKEN = saved.token;
  });

  it("throws when credentials are missing", () => {
    delete process.env.CONFLUENCE_EMAIL;
    delete process.env.CONFLUENCE_API_TOKEN;
    assert.throws(() => authHeader(), /Missing CONFLUENCE_EMAIL/);
  });

  it("builds a Basic auth header from email:token", () => {
    process.env.CONFLUENCE_EMAIL = "me@example.com";
    process.env.CONFLUENCE_API_TOKEN = "secret";
    const expected = "Basic " + Buffer.from("me@example.com:secret").toString("base64");
    assert.equal(authHeader(), expected);
  });
});

describe("Confluence API (mocked fetch)", () => {
  const savedEnv = {};
  let savedFetch;
  beforeEach(() => {
    savedEnv.base = process.env.CONFLUENCE_BASE_URL;
    savedEnv.email = process.env.CONFLUENCE_EMAIL;
    savedEnv.token = process.env.CONFLUENCE_API_TOKEN;
    process.env.CONFLUENCE_BASE_URL = "https://example.atlassian.net/wiki";
    process.env.CONFLUENCE_EMAIL = "me@example.com";
    process.env.CONFLUENCE_API_TOKEN = "secret";
    savedFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = savedFetch;
    for (const [k, v] of [
      ["CONFLUENCE_BASE_URL", savedEnv.base],
      ["CONFLUENCE_EMAIL", savedEnv.email],
      ["CONFLUENCE_API_TOKEN", savedEnv.token],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("apiGet throws when CONFLUENCE_BASE_URL is missing", async () => {
    delete process.env.CONFLUENCE_BASE_URL;
    await assert.rejects(() => apiGet("/api/v2/pages/1/labels"), /Missing CONFLUENCE_BASE_URL/);
  });

  it("apiGet builds the URL, sends auth, and returns parsed JSON", async () => {
    let seenUrl, seenAuth;
    global.fetch = async (url, opts) => {
      seenUrl = url;
      seenAuth = opts.headers.Authorization;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ results: [] }) };
    };
    const data = await apiGet("/api/v2/pages/42/labels");
    assert.equal(seenUrl, "https://example.atlassian.net/wiki/api/v2/pages/42/labels");
    assert.match(seenAuth, /^Basic /);
    assert.deepEqual(data, { results: [] });
  });

  it("apiGet throws on a non-ok response", async () => {
    global.fetch = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
    await assert.rejects(() => apiGet("/api/v2/pages/1/labels"), /Confluence API 404 Not Found/);
  });

  it("fetchLabels maps results to label names", async () => {
    global.fetch = async () => ({
      ok: true, status: 200, statusText: "OK",
      json: async () => ({ results: [{ name: "status-approved" }, { name: "team-fin" }] }),
    });
    assert.deepEqual(await fetchLabels("42"), ["status-approved", "team-fin"]);
  });

  it("fetchComments normalises inline + footer comments and resolves text", async () => {
    const adf = JSON.stringify({ type: "doc", content: [{ type: "text", text: "hi" }] });
    global.fetch = async (url) => {
      const isInline = url.includes("inline-comments");
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({
          results: isInline
            ? [{
                id: 1,
                version: { authorId: "a1", createdAt: "2026-01-01T00:00:00Z" },
                body: { atlas_doc_format: { value: adf } },
                resolutionStatus: "resolved",
              }]
            : [{ id: 2, body: { atlas_doc_format: { value: adf } } }],
        }),
      };
    };
    const comments = await fetchComments("42");
    assert.equal(comments.length, 2);
    const inline = comments.find((c) => c.kind === "inline");
    assert.equal(inline.id, "1");
    assert.equal(inline.author, "a1");
    assert.equal(inline.text, "hi");
    assert.equal(inline.resolved, true);
    const footer = comments.find((c) => c.kind === "footer");
    assert.equal(footer.id, "2");
    assert.equal(footer.author, "unknown"); // no version block
    assert.equal(footer.resolved, false);
  });

  it("fetchComments tolerates an endpoint that rejects (returns the other kind)", async () => {
    global.fetch = async (url) => {
      if (url.includes("inline-comments")) throw new Error("network");
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => ({ results: [{ id: 9, body: null }] }),
      };
    };
    const comments = await fetchComments("42");
    assert.equal(comments.length, 1);
    assert.equal(comments[0].kind, "footer");
    assert.equal(comments[0].text, ""); // null body → empty text
  });
});
