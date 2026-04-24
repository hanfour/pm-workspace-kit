import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_DRAFT_PRD, PROMPT_PROPOSE } from "../prompts";
import { println, repl, writeToken } from "../io";
import { extractPrdBody, nextPrdId, writePrd } from "../frontmatter";

export interface ProposeOptions {
  from?: string;
  paste?: boolean;
  interview?: boolean;
}

/**
 * `pmk propose [topic]` — produce a PRD markdown file.
 *
 * Four modes, decided in this order:
 *   1. --from <file>                    → one-shot: read file, draft PRD, exit
 *   2. stdin is a pipe (not a TTY)      → one-shot: read stdin, draft PRD, exit
 *   3. --paste                          → one-shot: collect multi-line via Ctrl-D, draft, exit
 *   4. (default)                        → interactive interview REPL
 *
 * --interview forces interview mode even when other flags/pipes are present.
 */
export async function proposeCommand(
  topic?: string,
  options: ProposeOptions = {},
): Promise<void> {
  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  const docsDir = path.resolve(process.cwd(), config.docsRoot, "prds");

  const header = chalk.bold(
    `\npmk propose — model=${config.model} · provider=${client.displayName}`,
  );
  println(header);

  if (options.interview) {
    return runInterview(client, docsDir, topic);
  }
  if (options.from) {
    const spec = readSpecFile(options.from);
    return runOneShot(client, docsDir, spec, { topic, source: options.from });
  }
  if (!process.stdin.isTTY) {
    const spec = await readStdin();
    if (spec.trim()) {
      return runOneShot(client, docsDir, spec, { topic, source: "stdin" });
    }
  }
  if (options.paste) {
    const spec = await collectPaste();
    if (!spec.trim()) {
      println(chalk.yellow("(empty input, nothing to draft)"));
      return;
    }
    return runOneShot(client, docsDir, spec, { topic, source: "paste" });
  }

  return runInterview(client, docsDir, topic);
}

function readSpecFile(from: string): string {
  const abs = path.resolve(process.cwd(), from);
  if (!fs.existsSync(abs)) {
    console.error(chalk.red(`[pmk] file not found: ${from}`));
    process.exit(1);
  }
  return fs.readFileSync(abs, "utf8");
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8")),
    );
  });
}

function collectPaste(): Promise<string> {
  return new Promise((resolve) => {
    println(
      chalk.dim(
        "Paste your spec below. Press Ctrl-D when done (or type only `.` on its own line).",
      ),
    );
    const chunks: string[] = [];
    process.stdin.setEncoding("utf8");
    const onData = (raw: string) => {
      if (raw.trimEnd().endsWith("\n.") || raw.trim() === ".") {
        finish();
        return;
      }
      chunks.push(raw);
    };
    const finish = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", finish);
      resolve(chunks.join(""));
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", finish);
  });
}

async function runOneShot(
  client: ReturnType<typeof resolveProviderOrExit>,
  docsDir: string,
  spec: string,
  ctx: { topic?: string; source: string },
): Promise<void> {
  println(
    chalk.dim(
      `Drafting PRD (${ctx.source}${ctx.topic ? `, topic: ${ctx.topic}` : ""}, ${spec.length.toLocaleString()} chars) …`,
    ),
  );
  const session = new Session();
  const preamble = ctx.topic
    ? `Topic: ${ctx.topic}\n\nSpec:\n\n${spec}`
    : spec;
  session.addUser(preamble);

  process.stdout.write(chalk.gray("\nassistant> "));
  const response = await client.chat(PROMPT_DRAFT_PRD, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(response);

  const saved = await maybeSavePrd(response, docsDir);
  if (!saved) {
    println(
      chalk.yellow(
        "\n[pmk] model did not emit PRD markers — nothing saved. Try re-running, or use --interview for clarification.",
      ),
    );
  }
}

async function runInterview(
  client: ReturnType<typeof resolveProviderOrExit>,
  docsDir: string,
  topic?: string,
): Promise<void> {
  if (topic) println(chalk.dim(`Seed topic: ${topic}\n`));

  const session = new Session();
  session.addUser(
    topic
      ? `Help me write a PRD for: ${topic}. Please start asking me questions.`
      : "Start a requirement intake conversation with me. What do you need to know first?",
  );
  process.stdout.write(chalk.gray("assistant> "));
  const opener = await client.chat(PROMPT_PROPOSE, session.history(), {
    onToken: writeToken,
  });
  println("");
  session.addAssistant(opener);

  if (await maybeSavePrd(opener, docsDir)) return;

  await repl(
    async (line) => {
      if (line === "/save") {
        println(
          chalk.yellow(
            "/save not wired yet — ask the model to draft now, e.g. 'ok, draft the PRD'.",
          ),
        );
        return;
      }
      session.addUser(line);
      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_PROPOSE, session.history(), {
        onToken: writeToken,
      });
      println("");
      session.addAssistant(response);
      if (await maybeSavePrd(response, docsDir)) return "stop";
    },
    { prompt: "you>", greeting: "" },
  );
}

async function maybeSavePrd(
  response: string,
  docsDir: string,
): Promise<boolean> {
  if (!response.includes("=== PRD ===") || !response.includes("=== END ===")) {
    return false;
  }
  const body = extractPrdBody(response);
  const id = nextPrdId(docsDir);
  const stamped = body.replace(/doc_id:\s*PRD-YYYY-NNNN/g, `doc_id: ${id}`);
  const titleMatch = stamped.match(/^title:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;
  const saved = writePrd(stamped, title, docsDir);
  println(chalk.green(`\nPRD saved → ${path.relative(process.cwd(), saved)}`));
  println(chalk.dim(`  doc_id: ${id}`));
  return true;
}
