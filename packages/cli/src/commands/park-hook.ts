import chalk from "chalk";
import { Session } from "../session";
import { println } from "../io";

/**
 * Intercept the pseudo-command `/park <name>` from a REPL line. Returns
 * true when the line was handled (callers should then skip the LLM
 * call); false means the line is a normal user turn.
 */
export function handleParkCommand(
  line: string,
  session: Session,
  verb: string,
  systemPromptKey?: string,
): boolean {
  if (!line.startsWith("/park")) return false;
  const name = line.slice(5).trim();
  if (!name) {
    println(chalk.yellow("usage: /park <name>"));
    return true;
  }
  const file = session.park(name, verb, systemPromptKey);
  println(chalk.green(`\nparked → ${file}`));
  println(chalk.dim(`resume with: pmk resume ${name}`));
  return true;
}
