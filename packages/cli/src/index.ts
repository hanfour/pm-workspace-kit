#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";
import { proposeCommand } from "./commands/propose";
import { ingestCommand } from "./commands/ingest";
import { applyCommand } from "./commands/apply";
import { discussCommand } from "./commands/discuss";
import { askCommand } from "./commands/ask";
import { debugCommand } from "./commands/debug";

// Load .env if present in cwd.
dotenv.config({ quiet: true });

const program = new Command();

program
  .name("pmk")
  .description(
    "pmk — pm-workspace-kit command-line interface.\n" +
      "Six verbs: propose / ingest / apply / discuss / ask / debug.",
  )
  .version("0.3.0-m1");

program
  .command("propose [topic]")
  .description(
    "PRD authoring → markdown file in docs/prds/. " +
      "Defaults to interactive interview; pass --from / --paste / pipe stdin for one-shot drafting.",
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
  .command("ingest <path>")
  .description(
    "Load an existing file into conversation context, then continue the chat.",
  )
  .action(async (filePath: string) => {
    await ingestCommand(filePath);
  });

program
  .command("apply [plan]")
  .description("Execute a decomposed plan, task by task. (Stub until M5.)")
  .action(async (plan?: string) => {
    await applyCommand(plan);
  });

program
  .command("discuss [topic]")
  .description("Open-ended brainstorm / discussion with the model.")
  .action(async (topic?: string) => {
    await discussCommand(topic);
  });

program
  .command("ask [question...]")
  .description("RAG query over your docs corpus. (Stub until M4.)")
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

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
