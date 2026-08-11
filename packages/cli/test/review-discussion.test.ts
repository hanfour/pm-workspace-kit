import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildGhArgs_listPrDiscussion, listPrDiscussion, markPriorReviewComments } from "../src/adapters/github";
import { buildReviewMraArgs } from "../src/gateway/slack/review-backend";

/**
 * A reviewer replied to an MRA finding with a substantiated rebuttal and the
 * next review never saw it. mra's analysis stage runs with no GitHub
 * credential — deliberately — so it cannot go and look. Only this side can
 * fetch the discussion, and only this side knows which comments it posted
 * itself: mra reviews under the operator's own account, so authorship alone
 * identifies nothing.
 */

const exec = (byArgs: Record<string, string>) => async (_bin: string, args: readonly string[]) => {
  const key = args.find((a) => a.startsWith("repos/")) ?? "";
  const stdout = byArgs[key];
  if (stdout === undefined) throw new Error(`unexpected endpoint: ${key}`);
  return { stdout, stderr: "", code: 0 };
};

test("the discussion endpoints are addressed by slug and PR number", () => {
  const args = buildGhArgs_listPrDiscussion("acme/web", 879, "inline");
  assert.ok(args.includes("repos/acme/web/pulls/879/comments"), args.join(" "));
  assert.ok(args.includes("--paginate"), "must page — a rebuttal is the newest item");
});

test("inline replies keep the id and the comment they answer", async () => {
  const items = await listPrDiscussion(
    { slug: "acme/web", pr: 1 },
    {
      findBinary: () => "gh",
      exec: exec({
        "repos/acme/web/pulls/1/comments": JSON.stringify([
          { id: 10, in_reply_to_id: null, user: { login: "op" }, path: "a.ts", line: 5, body: "[HIGH] finding", created_at: "2026-08-11T01:00:00Z" },
          { id: 11, in_reply_to_id: 10, user: { login: "ryan" }, path: "a.ts", line: 5, body: "no — the premise is wrong", created_at: "2026-08-11T01:09:00Z" },
        ]),
        "repos/acme/web/issues/1/comments": "[]",
        "repos/acme/web/pulls/1/reviews": "[]",
      }),
    },
  );
  assert.equal(items.length, 2);
  const reply = items.find((i) => i.id === 11);
  assert.equal(reply?.inReplyToId, 10, "without this a rebuttal is unreadable as a rebuttal");
  assert.equal(reply?.path, "a.ts");
  assert.equal(reply?.line, 5);
  assert.equal(reply?.body, "no — the premise is wrong", "the body must arrive whole");
});

test("a failed fetch yields nothing rather than throwing", async () => {
  const items = await listPrDiscussion(
    { slug: "acme/web", pr: 1 },
    { findBinary: () => "gh", exec: async () => { throw new Error("network"); } },
  );
  assert.deepEqual(items, [], "a review must still run when the discussion cannot be read");
});

test("our own findings need both our identity and our format", () => {
  const raw = [
    { id: 1, inReplyToId: null, author: "op", kind: "inline" as const, path: "a.ts", line: 1, body: "[HIGH] ours", createdAt: "1" },
    { id: 2, inReplyToId: null, author: "op", kind: "comment" as const, path: "", line: null, body: "merging after CI", createdAt: "2" },
    { id: 3, inReplyToId: null, author: "ryan", kind: "inline" as const, path: "b.ts", line: 2, body: "[HIGH] imitating the format", createdAt: "3" },
    { id: 4, inReplyToId: null, author: "op", kind: "review" as const, path: "", line: null, body: "summary\n\nMRA artifact: deadbeef", createdAt: "4" },
  ];
  const marked = markPriorReviewComments(raw, "op");
  assert.equal(marked.find((i) => i.id === 1)?.isPriorReview, true);
  assert.equal(marked.find((i) => i.id === 2)?.isPriorReview, false, "an ordinary remark from the same account is not a finding");
  assert.equal(marked.find((i) => i.id === 3)?.isPriorReview, false, "another account using the format is not us");
  assert.equal(marked.find((i) => i.id === 4)?.isPriorReview, true, "our review summary carries the artifact marker");
  assert.notEqual(marked, raw, "marking must not mutate the caller's array");
  assert.equal((raw[0] as { isPriorReview?: boolean }).isPriorReview, undefined, "the input must be left untouched");
});

test("an unknown identity marks nothing rather than guessing", () => {
  const raw = [{ id: 1, inReplyToId: null, author: "op", kind: "inline" as const, path: "a.ts", line: 1, body: "[HIGH] x", createdAt: "1" }];
  assert.equal(markPriorReviewComments(raw, undefined)[0]?.isPriorReview, false);
});

test("the discussion reaches mra through the request", () => {
  const discussion = [
    { id: 1, inReplyToId: null, author: "op", kind: "inline" as const, path: "a.ts", line: 1, body: "[HIGH] x", createdAt: "1", isPriorReview: true },
  ];
  const args = buildReviewMraArgs({
    reviewWorkspace: "/ws", project: "web", pr: 1, strategy: "standard",
    head: { sha: "abc", title: "t", body: "b", updatedAt: "u" },
    baseRef: "main", signal: new AbortController().signal,
    discussion,
  });
  assert.deepEqual(args.prContext?.discussion, discussion);
  assert.equal(args.prContext?.title, "t", "the existing scope context is not displaced");
});

test("no discussion supplied leaves the request exactly as it was", () => {
  const args = buildReviewMraArgs({
    reviewWorkspace: "/ws", project: "web", pr: 1, strategy: "standard",
    head: { sha: "abc", title: "t" }, baseRef: "main", signal: new AbortController().signal,
  });
  assert.equal(args.prContext?.discussion, undefined);
});
