import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { println } from "../../io";
import { appendGatewayEvent } from "../../gateway/events";
import { installedPlist, readGatewayRunStateRaw } from "../../gateway/run-state";
import { currentEntry } from "../../gateway/deploy/paths";
import { plistEntryPoint } from "../../gateway/deploy/plist-entry";
import { restartGateway } from "./ops";
import type { DeployDeps } from "./deploy";

const MAX_TAR_BYTES = 512 * 1024 * 1024;
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export function plistRunsCurrent(plistXml: string | undefined, root: string): boolean {
  return plistEntryPoint(plistXml) === currentEntry(root);
}

export function readPlistXml(plistPath: string | undefined, read: (p: string) => string): string | undefined {
  if (plistPath === undefined) return undefined;
  try {
    return read(plistPath);
  } catch {
    // False is the safe service-detection answer: an unreadable plist cannot justify restarting after the link flip.
    return undefined;
  }
}

export function realDeps(root: string): DeployDeps {
  return {
    record: appendGatewayEvent,
    print: println,
    build: {
      progress: println,
      nodeVersion: process.version,
      nodePath: process.execPath,
      now: () => new Date(),
      run: (file, args, cwd) => {
        try {
          return execFileSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: MAX_STDOUT_BYTES });
        } catch (error) {
          throw new Error(describeCommandFailure(file, args, error));
        }
      },
      exportTree: (repo, sha, dest) => {
        const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha], { maxBuffer: MAX_TAR_BYTES });
        execFileSync("tar", ["-xf", "-", "-C", dest], { input: tar });
      },
    },
    activate: {
      restart: restartGateway,
      readReady: readGatewayRunStateRaw,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      serviceRunsCurrent: () =>
        plistRunsCurrent(readPlistXml(installedPlist()?.plistPath, (p) => fs.readFileSync(p, "utf8")), root),
    },
  };
}

export function lastLines(text: string, n: number): string {
  return n > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/).slice(-n).join("\n") : "";
}

export function describeCommandFailure(file: string, args: readonly string[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const captured = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const tails = [captured.stdout, captured.stderr]
    .filter((value): value is string | Buffer => typeof value === "string" || Buffer.isBuffer(value))
    .map((value) => lastLines(value.toString(), 40)).filter(Boolean);
  return [`${file} ${args.join(" ")}: ${message}`, ...tails].join("\n");
}
