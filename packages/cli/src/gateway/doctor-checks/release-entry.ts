import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheckResult, DoctorContext } from "../doctor";
import { installedPlist } from "../run-state";
import { currentEntry, insideGitTree, readLink, readReleaseInfo, releaseDir, releasesRoot } from "../deploy/paths";

const NAME = "release-entry";
const ENTRY_RE = /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/;

/**
 * Is the service insulated from the repo? A LaunchAgent that runs a working
 * tree's `dist` is rewritten by any build there (`cli:build` begins with
 * `rm -rf dist`), and nothing else reports it.
 */
export function evaluateReleaseEntry(o: {
  plistXml: string | undefined;
  root: string;
  currentRelease: string | undefined;
  insideGitTree: (dir: string) => boolean;
}): DoctorCheckResult {
  const entry = o.plistXml === undefined ? undefined : ENTRY_RE.exec(o.plistXml)?.[1];
  if (!entry) return { name: NAME, severity: "pass", message: "no LaunchAgent installed" };

  if (entry === currentEntry(o.root)) {
    return o.currentRelease
      ? { name: NAME, severity: "pass", message: `LaunchAgent runs release ${o.currentRelease}` }
      : {
          name: NAME,
          severity: "fail",
          message: "LaunchAgent runs releases/current, but that link does not exist",
          hint: "deploy a release: pmk gateway deploy <ref>",
        };
  }
  if (o.insideGitTree(path.dirname(entry))) {
    return {
      name: NAME,
      severity: "warn",
      message: `LaunchAgent runs ${entry}, inside a git working tree — a build there rewrites the live service`,
      hint: "pmk gateway deploy <ref>, then run install-service --force from releases/current",
    };
  }
  return { name: NAME, severity: "pass", message: `LaunchAgent runs ${entry}` };
}

export async function releaseEntryCheck(ctx: DoctorContext): Promise<DoctorCheckResult> {
  const root = releasesRoot(ctx.home);
  const plist = installedPlist();
  return evaluateReleaseEntry({
    plistXml: plist ? fs.readFileSync(plist.plistPath, "utf8") : undefined,
    root,
    currentRelease: readLink(root, "current"),
    insideGitTree,
  });
}

/** One line for `pmk gateway status`. */
export function releaseStatusLine(root: string): string {
  const name = readLink(root, "current");
  if (!name) return "  release:    — (not deployed; see `pmk gateway deploy`)";
  const info = readReleaseInfo(releaseDir(root, name));
  return info ? `  release:    ${name} (${info.ref}, built ${info.builtAt})` : `  release:    ${name}`;
}
