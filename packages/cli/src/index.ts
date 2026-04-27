#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";
import { proposeCommand } from "./commands/propose";
import { ingestCommand } from "./commands/ingest";
import { applyCommand } from "./commands/apply";
import { discussCommand } from "./commands/discuss";
import { askCommand } from "./commands/ask";
import { debugCommand } from "./commands/debug";
import { indexCommand } from "./commands/index-cmd";
import { resumeCommand } from "./commands/resume";
import { worktreeCommand } from "./commands/worktree";
import { tddCommand } from "./commands/tdd";
import { exploreCommand } from "./commands/explore";
import { caseCommand } from "./commands/case";
import { gatewayCommand } from "./commands/gateway";

dotenv.config({ quiet: true });

const program = new Command();

program
  .name("pmk")
  .description(
    "pmk — pm-workspace-kit command-line interface.\n" +
      "Verbs: propose / ingest / apply / discuss / ask / debug / index / resume / worktree / tdd / explore / case / gateway.",
  )
  .version("0.7.0-dev");

program
  .command("propose [topic]")
  .description(
    "PRD authoring → markdown file in docs/prds/. Defaults to interactive interview; pass --from / --paste / pipe stdin for one-shot drafting.",
  )
  .option("-f, --from <file>", "draft from a spec file (one-shot, no REPL)")
  .option("-p, --paste", "draft from pasted multi-line input; Ctrl-D to send")
  .option(
    "-i, --interview",
    "force interactive interview even if stdin is piped",
  )
  .action(
    async (
      topic: string | undefined,
      opts: { from?: string; paste?: boolean; interview?: boolean },
    ) => {
      await proposeCommand(topic, opts);
    },
  );

program
  .command("ingest <target>")
  .description(
    "Load context: a file path, OR `mra:<repo>` / `mra:repo1,repo2` / `mra:--all` to pull PKB from a multi-repo-agent workspace.",
  )
  .action(async (target: string) => {
    await ingestCommand(target);
  });

program
  .command("explore <repo>")
  .description(
    "Delegate deep code exploration to mra (multi-repo-agent). Spawns `mra <repo> --with-deps`; auto-parks on exit.",
  )
  .action(async (repo: string) => {
    await exploreCommand(repo);
  });

program
  .command("gateway <action> [args...]")
  .description(
    "Run a Slack/LINE bridge so other PMs and stakeholders can chat with pmk via the messengers they already use. Actions: init / start / status / stats.",
  )
  .action(async (action: string, rest: string[]) => {
    await gatewayCommand(action, rest);
  });

program
  .command("case <action> [args...]")
  .description(
    "Long-lived bug investigation: open / resume / list / show / close. State persists across sessions.",
  )
  .option("--ingest <spec>", "PKB to load (e.g. mra:erp,oss-ui-v2)")
  .option("--title <text>", "human-readable title (default: name)")
  .option("--symptom <text>", "initial symptom description")
  .option("--resolution <text>", "(close) resolution summary")
  .action(
    async (
      action: string,
      rest: string[],
      opts: {
        ingest?: string;
        title?: string;
        symptom?: string;
        resolution?: string;
      },
    ) => {
      await caseCommand(action, rest, opts);
    },
  );

program
  .command("apply [plan]")
  .description(
    "Execute a decomposed plan task by task. --parallel runs tasks concurrently (capped at 3) as a preview.",
  )
  .option("--parallel", "run tasks concurrently (dry-run style)")
  .option(
    "--concurrency <n>",
    "max concurrent tasks when --parallel is set (1-3, default 3)",
    (v: string) => parseInt(v, 10),
  )
  .action(
    async (
      plan: string | undefined,
      opts: { parallel?: boolean; concurrency?: number },
    ) => {
      await applyCommand(plan, opts);
    },
  );

program
  .command("discuss [topic]")
  .description("Open-ended brainstorm / discussion REPL. /park <name> to save.")
  .action(async (topic?: string) => {
    await discussCommand(topic);
  });

program
  .command("ask [question...]")
  .description(
    "RAG query over your indexed docs corpus. Requires `pmk index` first.",
  )
  .action(async (words?: string[]) => {
    await askCommand(words?.join(" "));
  });

program
  .command("debug [symptom...]")
  .description(
    "Systematic debugging flow (symptom → hypotheses → test one → iterate).",
  )
  .action(async (words?: string[]) => {
    await debugCommand(words?.join(" "));
  });

program
  .command("index")
  .description("Build a local TF-IDF index over tracked docs (for `pmk ask`).")
  .option("--root <dir>", "override the repo root to index")
  .action(async (opts: { root?: string }) => {
    await indexCommand(opts);
  });

program
  .command("resume [name]")
  .description(
    "Reopen a parked session. Without a name, lists available parks.",
  )
  .action(async (name?: string) => {
    await resumeCommand(name);
  });

program
  .command("worktree <action> [args...]")
  .description(
    "Thin wrapper over `git worktree add|list|remove` for parallel pmk sessions.",
  )
  .action(async (action: string, rest: string[]) => {
    await worktreeCommand(action, rest);
  });

program
  .command("tdd [feature...]")
  .description(
    "Red → Green → Refactor TDD session with phase discipline enforced.",
  )
  .action(async (words?: string[]) => {
    await tddCommand(words?.join(" "));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
