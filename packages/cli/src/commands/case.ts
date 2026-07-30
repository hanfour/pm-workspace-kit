import chalk from "chalk";
import { loadConfig } from "../config";
import { resolveProviderOrExit } from "../llm";
import { Session } from "../session";
import { PROMPT_CASE } from "../prompts";
import { println, repl, writeToken } from "../io";
import {
  addEvidence,
  addHypothesis,
  addQuestion,
  appendTimeline,
  applyCaseUpdate,
  assertSafeCaseName,
  caseExists,
  CASE_VERSION,
  loadCase,
  listCases,
  newCase,
  parseCaseUpdate,
  renderCaseMarkdown,
  resolveQuestion,
  saveCase,
  setHypothesisStatus,
  stripCaseUpdateBlock,
  type CaseFile,
} from "../case";
import {
  listMraWorkspaceReposWithPkb,
  loadPkbBase,
  mraDoctor,
  resolveMraRepo,
  type PkbDoc,
} from "../adapters/mra";

const MRA_PREFIX = "mra:";

export interface CaseOpenOptions {
  ingest?: string;
  title?: string;
  symptom?: string;
}

export interface CaseCloseOptions {
  resolution?: string;
}

/**
 * Top-level `pmk case <action>` dispatcher.
 */
export async function caseCommand(
  action: string,
  rest: string[],
  opts: CaseOpenOptions & CaseCloseOptions = {},
): Promise<void> {
  switch (action) {
    case "open":
    case "resume":
      return openCase(rest[0], opts);
    case "list":
      return listCmd();
    case "show":
      return showCase(rest[0]);
    case "close":
      return closeCase(rest[0], opts);
    default:
      println(
        chalk.yellow("usage: pmk case <open|resume|list|show|close> [args]"),
      );
      process.exit(1);
  }
}

function listCmd(): void {
  const cases = listCases();
  if (cases.length === 0) {
    println(chalk.yellow("no cases yet. `pmk case open <name>` to start one."));
    return;
  }
  println(chalk.bold("Cases:"));
  for (const c of cases) {
    const tag =
      c.status === "open" ? chalk.green("● open  ") : chalk.gray("○ closed");
    println(`  ${tag} ${c.name}  ${chalk.dim(c.title)}`);
  }
}

async function showCase(name: string): Promise<void> {
  if (!name) {
    println(chalk.red("usage: pmk case show <name>"));
    process.exit(1);
  }
  assertCaseNameOrExit(name);
  const c = loadCaseOrExit(name);
  println(renderCaseMarkdown(c));
}

async function closeCase(name: string, opts: CaseCloseOptions): Promise<void> {
  if (!name) {
    println(chalk.red('usage: pmk case close <name> [--resolution "..."]'));
    process.exit(1);
  }
  assertCaseNameOrExit(name);
  const c = loadCaseOrExit(name);
  c.status = "closed";
  if (opts.resolution) c.resolution = opts.resolution;
  appendTimeline(
    c,
    "slash",
    `case closed${opts.resolution ? ": " + opts.resolution : ""}`,
  );
  const file = saveCase(c);
  println(chalk.green(`closed → ${file}`));
}

function loadCaseOrExit(name: string): CaseFile {
  try {
    return loadCase(name);
  } catch (err) {
    println(chalk.red(`[pmk] ${(err as Error).message}`));
    const known = listCases();
    if (known.length) {
      println(chalk.dim("known cases:"));
      for (const c of known) println(chalk.dim(`  · ${c.name}`));
    }
    process.exit(1);
  }
}

async function openCase(name: string, opts: CaseOpenOptions): Promise<void> {
  if (!name) {
    println(chalk.red("usage: pmk case open <name> [--ingest mra:...]"));
    process.exit(1);
  }
  assertCaseNameOrExit(name);

  let c: CaseFile;
  if (caseExists(name)) {
    c = loadCase(name);
    println(
      chalk.bold(
        `\npmk case — resuming \`${name}\` (status=${c.status}, ${c.messages.length} prior msgs)`,
      ),
    );
    if (c.status === "closed") {
      println(
        chalk.yellow(
          `(this case is closed; reopening as open. Use \`pmk case close ${name}\` again when done.)`,
        ),
      );
      c.status = "open";
    }
    if (opts.ingest && !c.ingest.includes(opts.ingest)) {
      c.ingest.push(opts.ingest);
    }
  } else {
    c = newCase({
      name,
      title: opts.title ?? name.replace(/-/g, " "),
      ingest: opts.ingest ? [opts.ingest] : [],
      symptom: opts.symptom,
    });
    println(chalk.bold(`\npmk case — created \`${name}\``));
  }

  const config = loadConfig();
  const client = resolveProviderOrExit(config);
  println(chalk.dim(`provider=${client.displayName}`));

  // Build the seed user message: case state + ingested PKB (if any).
  const session = new Session();
  session.load(c.messages);

  if (session.size() === 0) {
    const seed = buildSeedMessage(c);
    session.addUser(seed);
    c.messages = session.history();
    appendTimeline(c, "user", "(case opened, seeded with PKB context)");

    process.stdout.write(chalk.gray("\nassistant> "));
    const ack = await client.chat(PROMPT_CASE, session.history(), {
      onToken: writeToken,
    });
    println("");
    const ackVisible = stripCaseUpdateBlock(ack);
    session.addAssistant(ackVisible);
    c.messages = session.history();
    appendTimeline(c, "assistant", truncate(ackVisible, 200));
    autoApplyCaseUpdate(c, ack);
    saveCase(c);
  } else {
    println(
      chalk.dim(
        `last update ${c.updatedAt}. Type naturally — pmk auto-tracks hypotheses, evidence, and next-questions. /help for slash commands.`,
      ),
    );
  }

  await repl(
    async (line) => {
      // Slash commands operate on the case file synchronously, no LLM.
      const handled = handleSlash(c, line);
      if (handled === "stop") return "stop";
      if (handled) {
        saveCase(c);
        return;
      }

      // Regular user turn → append, send to model, save.
      session.addUser(line);
      c.messages = session.history();
      appendTimeline(c, "user", truncate(line, 200));

      process.stdout.write(chalk.gray("\nassistant> "));
      const response = await client.chat(PROMPT_CASE, session.history(), {
        onToken: writeToken,
      });
      println("");
      const visible = stripCaseUpdateBlock(response);
      session.addAssistant(visible);
      c.messages = session.history();
      appendTimeline(c, "assistant", truncate(visible, 200));
      autoApplyCaseUpdate(c, response);
      saveCase(c);
    },
    {
      prompt: "you>",
      greeting:
        "Just type. pmk auto-tracks hypotheses / evidence / questions. /help for advanced.",
    },
  );

  saveCase(c);
  println(chalk.green(`\nsaved → ${c.name}`));
}

function assertCaseNameOrExit(name: string): void {
  try {
    assertSafeCaseName(name);
  } catch (err) {
    println(chalk.red(`[pmk] ${(err as Error).message}`));
    process.exit(1);
  }
}

function buildSeedMessage(c: CaseFile): string {
  const parts: string[] = [];
  parts.push(
    `I'm opening a bug investigation case named \`${c.name}\` (\`${c.title}\`).`,
  );
  if (c.symptom) parts.push(`\n## Symptom\n${c.symptom}`);
  if (c.ingest.length === 0) {
    parts.push(
      "\nNo PKB ingested yet. Treat this like a generic debugging conversation; ask me what repos to load if you need code context.",
    );
  } else {
    parts.push(`\n## Ingested context\n${loadIngestedPkb(c.ingest)}`);
  }
  parts.push(
    "\nFor each turn:\n" +
      "- propose hypotheses I should track (I'll add them with /hypothesis).\n" +
      "- suggest concrete questions I should ask the bug reporter (I'll add with /next).\n" +
      "- name file paths / module names / API endpoints from the ingested PKB whenever applicable.\n" +
      "Don't pretend to know things outside the PKB — say so.",
  );
  return parts.join("\n");
}

function loadIngestedPkb(ingestSpecs: string[]): string {
  const blocks: string[] = [];
  const doctor = mraDoctor();
  if (!doctor.ok) {
    blocks.push(`(adapter: ${doctor.reason})`);
    return blocks.join("\n");
  }
  for (const spec of ingestSpecs) {
    if (!spec.startsWith(MRA_PREFIX)) {
      blocks.push(`(unsupported ingest spec: ${spec})`);
      continue;
    }
    const tail = spec.slice(MRA_PREFIX.length);
    const repos =
      tail === "--all"
        ? listMraWorkspaceReposWithPkb(doctor.workspace!)
        : tail
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
    for (const repo of repos) {
      const repoPath = resolveMraRepo(doctor.workspace!, repo);
      if (!repoPath) continue;
      const docs = loadPkbBase(repoPath);
      if (docs.length === 0) continue;
      blocks.push(formatRepoBlock(repo, docs));
    }
  }
  return blocks.join("\n\n---\n\n") || "(no PKB found for ingested specs)";
}

function formatRepoBlock(repo: string, docs: PkbDoc[]): string {
  return [
    `## repo: ${repo}`,
    ...docs.map(
      (d) => `### ${d.name}\n\n\`\`\`markdown\n${d.content.trim()}\n\`\`\``,
    ),
  ].join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Parse the assistant's `case-update` fenced block (if any) and apply
 * each action to the case file. Prints a `✓` line per applied action
 * so the user sees what was tracked. The user can `/undo` to revert
 * the last batch if the model misclassified.
 */
function autoApplyCaseUpdate(c: CaseFile, fullResponse: string): void {
  const { actions } = parseCaseUpdate(fullResponse);
  if (actions.length === 0) return;
  // Snapshot for /undo: shallow copies of the mutable arrays.
  lastSnapshot = {
    name: c.name,
    symptom: c.symptom,
    hypotheses: c.hypotheses.map((h) => ({ ...h })),
    evidence: c.evidence.map((e) => ({ ...e })),
    openQuestions: c.openQuestions.map((q) => ({ ...q })),
  };
  const summaries = applyCaseUpdate(c, actions);
  for (const s of summaries) {
    println(chalk.green(`  ✓ ${s}`));
  }
}

interface CaseSnapshot {
  name: string;
  symptom: string;
  hypotheses: CaseFile["hypotheses"];
  evidence: CaseFile["evidence"];
  openQuestions: CaseFile["openQuestions"];
}

let lastSnapshot: CaseSnapshot | null = null;

function undoLast(c: CaseFile): boolean {
  if (!lastSnapshot || lastSnapshot.name !== c.name) return false;
  c.symptom = lastSnapshot.symptom;
  c.hypotheses = lastSnapshot.hypotheses;
  c.evidence = lastSnapshot.evidence;
  c.openQuestions = lastSnapshot.openQuestions;
  lastSnapshot = null;
  return true;
}

/**
 * Returns:
 *   - `"stop"` when user typed an exit command
 *   - `true` when a slash command was handled (caller should NOT call LLM)
 *   - `false` when the line is a regular user turn
 */
function handleSlash(c: CaseFile, line: string): "stop" | boolean {
  if (!line.startsWith("/")) return false;
  const space = line.indexOf(" ");
  const cmd = space === -1 ? line : line.slice(0, space);
  const arg = space === -1 ? "" : line.slice(space + 1).trim();

  switch (cmd) {
    case "/show":
      println(renderCaseMarkdown(c));
      appendTimeline(c, "slash", "/show");
      return true;
    case "/symptom":
      if (!arg) {
        println(chalk.red("usage: /symptom <text>"));
        return true;
      }
      c.symptom = arg;
      appendTimeline(c, "slash", `/symptom ${truncate(arg, 80)}`);
      println(chalk.green("symptom updated."));
      return true;
    case "/hypothesis":
      if (!arg) {
        println(chalk.red("usage: /hypothesis <text>"));
        return true;
      }
      addHypothesis(c, arg);
      appendTimeline(c, "slash", `/hypothesis ${truncate(arg, 80)}`);
      println(chalk.green(`hypothesis added (#${c.hypotheses.length}).`));
      return true;
    case "/rule-out":
    case "/confirm": {
      if (!arg) {
        println(chalk.red(`usage: ${cmd} <hypothesis-index> [reason]`));
        return true;
      }
      const [idxStr, ...rest] = arg.split(/\s+/);
      const idx = parseInt(idxStr, 10);
      if (Number.isNaN(idx)) {
        println(chalk.red("first arg must be the hypothesis index from /show"));
        return true;
      }
      const status = cmd === "/rule-out" ? "ruled-out" : "confirmed";
      const note = rest.join(" ");
      const h = setHypothesisStatus(c, idx, status, note);
      if (!h) {
        println(chalk.red(`no hypothesis at index ${idx}.`));
        return true;
      }
      appendTimeline(c, "slash", `${cmd} #${idx}${note ? `: ${note}` : ""}`);
      println(chalk.green(`hypothesis #${idx} → ${status}.`));
      return true;
    }
    case "/evidence": {
      if (!arg) {
        println(
          chalk.red("usage: /evidence <text> (default source: reporter)"),
        );
        return true;
      }
      addEvidence(c, "reporter", arg);
      appendTimeline(c, "slash", `/evidence ${truncate(arg, 80)}`);
      println(chalk.green(`evidence #${c.evidence.length} added.`));
      return true;
    }
    case "/next": {
      if (!arg) {
        println(chalk.red("usage: /next <question to ask the reporter>"));
        return true;
      }
      addQuestion(c, arg);
      appendTimeline(c, "slash", `/next ${truncate(arg, 80)}`);
      println(chalk.green(`question #${c.openQuestions.length} queued.`));
      return true;
    }
    case "/resolve": {
      if (!arg) {
        println(chalk.red("usage: /resolve <question-index>"));
        return true;
      }
      const idx = parseInt(arg, 10);
      const q = resolveQuestion(c, idx);
      if (!q) {
        println(chalk.red(`no question at index ${idx}.`));
        return true;
      }
      appendTimeline(c, "slash", `/resolve #${idx}`);
      println(chalk.green(`question resolved (removed from queue).`));
      return true;
    }
    case "/undo": {
      if (undoLast(c)) {
        appendTimeline(c, "slash", "/undo");
        println(chalk.green("undid last auto-tracked update."));
      } else {
        println(chalk.yellow("nothing to undo."));
      }
      return true;
    }
    case "/help":
      println(chalk.bold("\nCase REPL slash commands"));
      println(
        chalk.dim(
          "  Most of the time you don't need these — pmk auto-tracks from your conversation.\n" +
            "  Use these when the model misclassified or you want explicit control.\n",
        ),
      );
      println("  /show              render the case as Markdown");
      println("  /symptom <text>    set the symptom");
      println("  /hypothesis <t>    add a hypothesis manually");
      println("  /rule-out  N [r]   mark hypothesis #N as ruled-out");
      println("  /confirm   N [r]   mark hypothesis #N as confirmed");
      println("  /evidence  <text>  add evidence (source: reporter)");
      println("  /next      <text>  queue a question for the reporter");
      println("  /resolve   N       remove question #N (answered)");
      println("  /undo              revert the last auto-tracked update");
      println("  /done | /quit      save and exit");
      return true;
    case "/done":
    case "/quit":
      return "stop";
    default:
      println(chalk.yellow(`unknown slash command: ${cmd}`));
      return true;
  }
}

export const _internal = {
  CASE_VERSION,
};
