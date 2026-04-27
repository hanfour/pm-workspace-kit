import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_INGEST, PROMPT_DISCUSS } from "../prompts";
import { repl, println, writeToken } from "../io";
import {
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
  type PkbDoc,
} from "../adapters/mra";

const MRA_PREFIX = "mra:";
const PKB_STALE_DAYS = 7;

/**
 * Soft cap on total ingested context size. ~150 KB ≈ 50K tokens; well
 * within Sonnet's 200K window once you account for system prompt + the
 * response itself. Above this we warn but proceed.
 */
const PKB_TOTAL_CHAR_WARN = 150_000;

/**
 * `pmk ingest <target>` — load context into a conversation, then REPL.
 *
 * Three modes:
 *   - plain path:           `pmk ingest ./spec.md`
 *   - single mra repo:      `pmk ingest mra:erp`
 *   - multi mra repos:      `pmk ingest mra:erp,oss-ui-v2,api-gateway`
 *   - whole workspace:      `pmk ingest mra:--all` (every repo with PKB)
 */
export async function ingestCommand(target: string): Promise<void> {
  const { contextBlock, banner } = target.startsWith(MRA_PREFIX)
    ? loadFromMra(target.slice(MRA_PREFIX.length))
    : loadFromFile(target);

  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const session = new Session();

  println(
    chalk.bold(`\npmk ingest — ${banner} · provider=${client.displayName}`),
  );

  session.addUser(
    `I'm ingesting this context for our conversation:\n\n${contextBlock}\n\nPlease acknowledge what this is about in ≤ 3 sentences, then wait for my next question.`,
  );

  process.stdout.write(chalk.gray("assistant> "));
  const ack = await client.chat(PROMPT_INGEST, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(ack);

  await repl(
    async (line) => {
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_DISCUSS, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
    },
    { prompt: "you>" },
  );
}

function loadFromFile(filePath: string): {
  contextBlock: string;
  banner: string;
} {
  const abs = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error(chalk.red(`[pmk] file not found: ${filePath}`));
    process.exit(1);
  }
  const content = fs.readFileSync(abs, "utf8");
  return {
    contextBlock: "```\n" + content + "\n```",
    banner: `${path.relative(process.cwd(), abs)} · ${content.split("\n").length} lines, ${content.length} chars`,
  };
}

function loadFromMra(spec: string): { contextBlock: string; banner: string } {
  if (!spec) {
    println(
      chalk.red("usage: pmk ingest mra:<repo> | mra:repo1,repo2 | mra:--all"),
    );
    process.exit(1);
  }

  const doctor = mraDoctor();
  if (!doctor.ok) {
    println(chalk.red(`[pmk] ${doctor.reason}`));
    process.exit(1);
  }
  const workspace = doctor.workspace!;

  const repos = resolveRepoSpec(spec, workspace);
  if (repos.length === 0) {
    println(
      chalk.red(
        `[pmk] no repos with PKB found for spec \`${spec}\` in ${workspace}`,
      ),
    );
    process.exit(1);
  }

  const blocks: string[] = [];
  const allDocs: Array<{ repo: string; doc: PkbDoc }> = [];
  const missing: string[] = [];

  for (const repo of repos) {
    const repoPath = resolveMraRepo(workspace, repo);
    if (!repoPath) {
      missing.push(`${repo} (dir not found)`);
      continue;
    }
    const docs = loadPkbBase(repoPath);
    if (docs.length === 0) {
      missing.push(`${repo} (no PKB)`);
      continue;
    }
    for (const d of docs) allDocs.push({ repo, doc: d });
    blocks.push(formatRepoBlock(repo, docs));
  }

  if (allDocs.length === 0) {
    println(
      chalk.red(
        `[pmk] none of the requested repos have PKB. Run \`mra analyze <repo>\` first.`,
      ),
    );
    process.exit(1);
  }

  if (missing.length) {
    println(chalk.yellow(`[pmk] skipped: ${missing.join(", ")}`));
  }

  warnIfStale(allDocs);
  const totalChars = allDocs.reduce((s, e) => s + e.doc.content.length, 0);
  if (totalChars > PKB_TOTAL_CHAR_WARN) {
    println(
      chalk.yellow(
        `[pmk] context is ${totalChars.toLocaleString()} chars (~${Math.round(totalChars / 3.5).toLocaleString()} tokens). Above ${PKB_TOTAL_CHAR_WARN.toLocaleString()} the conversation may run tight on long answers.`,
      ),
    );
  }

  const loadedRepos = Array.from(new Set(allDocs.map((e) => e.repo)));
  const repoSummary =
    loadedRepos.length === 1
      ? `mra:${loadedRepos[0]}`
      : `mra:${loadedRepos.length} repos (${loadedRepos.slice(0, 3).join(", ")}${loadedRepos.length > 3 ? ", …" : ""})`;
  return {
    contextBlock: blocks.join("\n\n---\n\n"),
    banner: `${repoSummary} · ${allDocs.length} PKB doc(s), ${totalChars.toLocaleString()} chars`,
  };
}

/**
 * Resolve a repo spec into the actual list of repos to load.
 *  - `--all` walks the workspace via repos.json and picks ones with PKB
 *  - comma-separated list is split and trimmed
 *  - single name is returned as a one-element list
 */
function resolveRepoSpec(spec: string, workspace: string): string[] {
  if (spec === "--all") {
    return listMraWorkspaceReposWithPkb(workspace);
  }
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatRepoBlock(repo: string, docs: PkbDoc[]): string {
  return [
    `## repo: ${repo}`,
    ...docs.map(
      (d) => `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
    ),
  ].join("\n\n");
}

function warnIfStale(entries: Array<{ repo: string; doc: PkbDoc }>): void {
  // Group oldest mtime per repo so the warning lists every stale repo,
  // not just the single oldest doc.
  const perRepo = new Map<string, number>();
  for (const { repo, doc } of entries) {
    const cur = perRepo.get(repo);
    if (cur === undefined || doc.mtime < cur) perRepo.set(repo, doc.mtime);
  }
  const stale: string[] = [];
  for (const [repo, mtime] of perRepo) {
    const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
    if (ageDays > PKB_STALE_DAYS) {
      stale.push(`${repo} (${Math.round(ageDays)}d)`);
    }
  }
  if (stale.length) {
    println(
      chalk.yellow(
        `[pmk] warning: PKB stale in ${stale.join(", ")}. Consider \`mra analyze\` on each.`,
      ),
    );
  }
}
