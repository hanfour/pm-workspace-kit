import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { println } from "../../io";
import { type GatewayDeployEvent } from "../../gateway/events";
import { buildRelease, type BuildDeps, type BuildResult } from "../../gateway/deploy/build";
import { activateRelease, rollbackRelease, type ActivateDeps, type ActivateResult } from "../../gateway/deploy/activate";
import { pruneReleases } from "../../gateway/deploy/prune";
import { readLink, readReleaseInfo, releaseDir, releasesRoot } from "../../gateway/deploy/paths";
import { realDeps } from "./deploy-deps";
export { plistRunsCurrent, readPlistXml } from "./deploy-deps";

const USAGE = "usage: pmk gateway deploy <ref> [--repo <path>] [--no-activate]\n" +
  "<ref> is a branch, tag or full/short sha (forms like HEAD~1 are not accepted)";
const LINKS_ONLY_REASON = "links only: service not restarted — LaunchAgent does not run releases/current";
export interface DeployDeps {
  build: BuildDeps;
  activate: ActivateDeps;
  record: (e: GatewayDeployEvent) => void;
  print: (line: string) => void;
  prune?: (root: string) => string[];
}

export function parseDeployArgs(rest: string[]): { ref: string; repo?: string; activate: boolean } {
  const positional: string[] = [];
  let repo: string | undefined;
  let activate = true;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--no-activate") activate = false;
    else if (a === "--repo") {
      repo = rest[++i];
      if (!repo) throw new Error(USAGE);
    } else positional.push(a);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  return { ref: positional[0], repo, activate };
}

/** Records outcomes; `onSuccess` is "gateway.rollback" for operator rollback. */
export function settle(
  root: string,
  r: ActivateResult,
  sha: string,
  ref: string | undefined,
  d: DeployDeps,
  onSuccess: GatewayDeployEvent["type"] = "gateway.deployed",
): number {
  d.print(r.message);
  const live = r.outcome === "activated" ? r.release
    : r.outcome === "rolled-back" ? r.previous
    : r.outcome === "failed" ? readLink(root, "current") : undefined;
  const liveField = live === undefined ? {} : { live };
  switch (r.outcome) {
    case "activated": {
      const reason = onSuccess === "gateway.rollback" ? "operator rollback" : undefined;
      d.record({ type: onSuccess, release: r.release, sha, ref, previous: r.previous, ...liveField, ...(reason ? { reason } : {}) });
      return 0;
    }
    case "links-only":
      d.record({ type: onSuccess, release: r.release, sha, ref, previous: r.previous, reason: LINKS_ONLY_REASON });
      return 0;
    case "rolled-back":
    case "failed":
      d.record({ type: "gateway.rollback", release: r.release, sha, ref, previous: r.previous, ...liveField, reason: r.message });
      return 1;
    case "already-current":
      return 0;
    default: {
      const unreachable: never = r.outcome;
      throw new Error(`unexpected activation outcome: ${unreachable}`);
    }
  }
}

export async function runDeploy(
  a: { ref: string; repo: string; root: string; activate: boolean },
  d: DeployDeps,
): Promise<number> {
  let built: BuildResult;
  try {
    built = buildRelease({ repo: a.repo, ref: a.ref, root: a.root }, d.build);
  } catch (e) {
    d.print(`build failed: ${(e as Error).message}`);
    d.print("current release was not changed.");
    return 1;
  }
  d.print(`${built.reused ? "reusing" : "built"} ${built.name} (${built.sha.slice(0, 7)})`);
  if (!a.activate) {
    d.print(`not activated. When ready: pmk gateway activate ${built.name}`);
    return 0;
  }
  const code = settle(a.root, await activateRelease({ root: a.root, name: built.name }, d.activate), built.sha, a.ref, d);
  if (code === 0) {
    try {
      for (const removed of (d.prune ?? pruneReleases)(a.root)) d.print(`pruned ${removed}`);
    } catch (e) {
      d.print(`warning: could not prune old releases: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return code;
}

function repoToplevel(cwd: string): string {
  return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export async function deployCmd(rest: string[]): Promise<void> {
  let args: ReturnType<typeof parseDeployArgs>;
  try {
    args = parseDeployArgs(rest);
  } catch (e) {
    println(chalk.yellow((e as Error).message));
    process.exit(1);
  }
  let repo: string;
  try {
    repo = path.resolve(args.repo ?? repoToplevel(process.cwd()));
  } catch (error) {
    println(chalk.red(`not inside a git repository; pass --repo <path>: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 1;
    return;
  }
  try {
    const root = releasesRoot();
    fs.mkdirSync(root, { recursive: true });
    process.exitCode = await runDeploy({ ref: args.ref, repo, root, activate: args.activate }, realDeps(root));
  } catch (e) {
    println(chalk.red((e as Error).message));
    process.exitCode = 1;
  }
}

async function activateNamed(name: string | undefined): Promise<void> {
  const root = releasesRoot();
  const d = realDeps(root);
  try {
    const r = name ? await activateRelease({ root, name }, d.activate) : await rollbackRelease(root, d.activate);
    const sha = readReleaseInfo(releaseDir(root, r.release))?.sha ?? "";
    process.exitCode = settle(root, r, sha, undefined, d, name ? "gateway.deployed" : "gateway.rollback");
  } catch (e) {
    println(chalk.red((e as Error).message));
    process.exitCode = 1;
  }
}

export async function activateCmd(rest: string[]): Promise<void> {
  if (rest.length !== 1) {
    println(chalk.yellow("usage: pmk gateway activate <release>"));
    process.exit(1);
  }
  await activateNamed(rest[0]);
}

export async function rollbackCmd(): Promise<void> {
  if (!readLink(releasesRoot(), "previous")) {
    println(chalk.red("no previous release to roll back to"));
    process.exitCode = 1;
    return;
  }
  await activateNamed(undefined);
}
