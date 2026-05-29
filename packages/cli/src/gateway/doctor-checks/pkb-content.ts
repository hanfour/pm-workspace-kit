import type { DoctorCheckResult, DoctorContext } from "../doctor";

// PKB content pre-flight (FR2 #6).
//
// v0.16 hardening (M6): the original check only inspected config shape,
// so a gateway pointed at an mra workspace with zero repos passed as a
// soft WARN and `doctor` exited 0 — an "empty PKB" failure mode slipped
// through. We now count the approved atoms actually on disk (read-only)
// and only treat an empty PKB as a fatal FAIL when its source provably
// cannot fill it. A fresh-but-viable install (atoms=0, repos≥1) stays a
// WARN because the PKB seeds on the first turn.
export async function pkbContentCheck(
  ctx: DoctorContext,
): Promise<DoctorCheckResult> {
  const ingest = ctx.config?.defaultIngest;
  const workspace = ctx.config?.mraWorkspace;
  const hasIngest = !!ingest;
  const hasWorkspace = !!workspace;

  // No source at all — PKB is empty and nothing will ever fill it.
  if (!hasIngest && !hasWorkspace) {
    return {
      name: "pkb-content",
      severity: "fail",
      message: "no PKB source: neither defaultIngest nor mraWorkspace is set",
      hint: "set defaultIngest=mra:--all in gateway.json (or set mraWorkspace)",
    };
  }

  const atoms = await ctx.runners.atomCount();
  if (atoms > 0) {
    return {
      name: "pkb-content",
      severity: "pass",
      message: `PKB has ${atoms} approved atom(s) on disk`,
    };
  }

  // From here the PKB is empty. Distinguish "fresh but viable" (WARN)
  // from "empty and the source can't fill it" (FAIL). For an mra-backed
  // source we can verify viability read-only by listing its repos.
  const sourceIsMra = !hasIngest || ingest!.startsWith("mra:");

  if (sourceIsMra && !hasWorkspace) {
    return {
      name: "pkb-content",
      severity: "fail",
      message: `defaultIngest="${ingest}" needs an mraWorkspace but none is set; PKB is empty`,
      hint: "set mraWorkspace so the mra: ingest spec can resolve at runtime",
    };
  }

  if (sourceIsMra && hasWorkspace) {
    const res = await ctx.runners.mraList(workspace!);
    if (res.ok && res.repos.length > 0) {
      return {
        name: "pkb-content",
        severity: "warn",
        message: `PKB empty now; ${res.repos.length} mra repo(s) will seed it on first turn (unverified until then)`,
        hint: hasIngest
          ? "trigger one turn (or `pmk ask`), then re-run doctor to confirm atoms populate"
          : 'set defaultIngest="mra:--all" so the first turn auto-seeds the PKB',
      };
    }
    return {
      name: "pkb-content",
      severity: "fail",
      message: "PKB is empty and its mra source has no repos to ingest",
      hint: `register repos in ${workspace} (.collab/repos.json), then re-run doctor`,
    };
  }

  // Non-mra ingest spec with an empty PKB — we can't verify the source
  // read-only at preflight, so warn rather than block.
  return {
    name: "pkb-content",
    severity: "warn",
    message: `PKB empty; defaultIngest="${ingest}" is non-mra and can't be verified at preflight`,
    hint: "trigger one ingest, then re-run doctor to confirm atoms populate",
  };
}
