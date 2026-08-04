/**
 * Whether a review may START right now, given what is already running.
 *
 * Three independent limits: total concurrency, per-actor concurrency, and
 * one-review-per-repo (a repo has a single review workspace, so two at once
 * would collide). They were a single `||` chain inside `runOne`, reachable
 * only by driving the runner with a populated in-flight set — so which
 * limit fired was never asserted anywhere.
 *
 * The decision is pure: a snapshot of what is in flight plus the request. It
 * takes an iterable rather than the runner's Set so it never sees, and
 * cannot touch, the live collection.
 */

/** The in-flight facts admission needs. Deliberately narrower than InFlightReview. */
export interface InFlightSnapshot {
  actorUserId: string;
  projectKey: string;
}

export type AdmissionRefusal =
  | { limit: "global"; active: number; max: number }
  | { limit: "per-user"; active: number; max: number }
  | { limit: "same-repo"; projectKey: string };

export interface AdmissionRequest {
  actorUserId: string;
  projectKey: string;
  maxConcurrent: number;
  maxConcurrentPerUser: number;
}

/**
 * The reason this review may not start, or undefined to admit it.
 *
 * Order matches the original short-circuit — global, then per-actor, then
 * per-repo — so when several apply the reported cause stays the outermost one.
 */
export function admissionRefusal(
  inFlight: Iterable<InFlightSnapshot>,
  req: AdmissionRequest,
): AdmissionRefusal | undefined {
  const running = [...inFlight];

  if (running.length >= req.maxConcurrent) {
    return { limit: "global", active: running.length, max: req.maxConcurrent };
  }

  const byActor = running.filter((r) => r.actorUserId === req.actorUserId).length;
  if (byActor >= req.maxConcurrentPerUser) {
    return { limit: "per-user", active: byActor, max: req.maxConcurrentPerUser };
  }

  if (running.some((r) => r.projectKey === req.projectKey)) {
    return { limit: "same-repo", projectKey: req.projectKey };
  }

  return undefined;
}

/**
 * What to tell the user.
 *
 * The previous text named all three causes joined by "或", whichever one had
 * actually fired — so someone blocked by their own still-running review of the
 * same repo was told the system was busy, and waited on the wrong thing. The
 * caller already knows which limit it was; saying so costs nothing.
 */
export function admissionRefusalMessage(refusal: AdmissionRefusal): string {
  switch (refusal.limit) {
    case "global":
      return (
        `:hourglass: 目前有 ${refusal.active} 個 review 正在執行（上限 ${refusal.max}），` +
        "請稍後重試。"
      );
    case "per-user":
      return (
        `:hourglass: 你已經有 ${refusal.active} 個 review 正在執行（每人上限 ${refusal.max}），` +
        "請等其中一個完成後再發。"
      );
    case "same-repo":
      return (
        `:hourglass: \`${refusal.projectKey}\` 已經有一個 review 正在執行，` +
        "同一個 repo 一次只能跑一個；請等它完成後再發。"
      );
  }
}
