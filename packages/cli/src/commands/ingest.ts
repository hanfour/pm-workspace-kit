import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_INGEST, PROMPT_DISCUSS } from "../prompts";
import { repl, println, writeToken } from "../io";
import {
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
  type PkbDoc,
} from "../adapters/mra";

const MRA_PREFIX = "mra:";
const PKB_STALE_DAYS = 7;

/**
 * `pmk ingest <target>` — load context into a conversation, then REPL.
 *
 * Two modes:
 *  - plain path:    `pmk ingest ./spec.md` loads the file
 *  - mra: scheme:   `pmk ingest mra:erp/order` loads PKB Layer 0+1+2
 *                   (identity / sitemap / architecture / api-surface)
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

function loadFromFile(filePath: string): { contextBlock: string; banner: string } {
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

function loadFromMra(repo: string): { contextBlock: string; banner: string } {
  if (!repo) {
    println(chalk.red("usage: pmk ingest mra:<repo>"));
    process.exit(1);
  }
  const doctor = mraDoctor();
  if (!doctor.ok) {
    println(chalk.red(`[pmk] ${doctor.reason}`));
    process.exit(1);
  }
  const repoPath = resolveMraRepo(doctor.workspace!, repo);
  if (!repoPath) {
    println(
      chalk.red(
        `[pmk] repo \`${repo}\` not found in workspace ${doctor.workspace}`,
      ),
    );
    process.exit(1);
  }
  const docs = loadPkbBase(repoPath);
  if (docs.length === 0) {
    println(
      chalk.red(
        `[pmk] no PKB found at ${repoPath}/.collab/pkb/. Run \`mra analyze ${repo}\` first.`,
      ),
    );
    process.exit(1);
  }
  warnIfStale(docs, repo);
  const totalChars = docs.reduce((s, d) => s + d.content.length, 0);
  return {
    contextBlock: docs
      .map(
        (d) =>
          `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
      )
      .join("\n\n"),
    banner: `mra:${repo} · ${docs.length} PKB doc(s), ${totalChars.toLocaleString()} chars`,
  };
}

function warnIfStale(docs: PkbDoc[], repo: string): void {
  const oldest = Math.min(...docs.map((d) => d.mtime));
  const ageDays = (Date.now() - oldest) / (1000 * 60 * 60 * 24);
  if (ageDays > PKB_STALE_DAYS) {
    println(
      chalk.yellow(
        `[pmk] warning: oldest PKB doc is ${Math.round(ageDays)} days old. Consider \`mra analyze ${repo}\` to refresh.`,
      ),
    );
  }
}
