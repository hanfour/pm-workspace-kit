import chalk from "chalk";
import { println } from "../../io";
import {
  auditCmd,
  demoCmd,
  doctorCmd,
  initCmd,
  startCmd,
  statsCmd,
  statusCmd,
} from "./ops";
import { audienceCmd } from "./audience";
import { escalationCmd } from "./escalation";
import { atomsCmd } from "./atoms";
import { adminBootstrapCmd } from "./admin";

export { buildAtomTelemetryReport } from "./atoms";

export async function gatewayCommand(
  action: string,
  rest: string[],
): Promise<void> {
  switch (action) {
    case "init":
      return await initCmd();
    case "start":
      return await startCmd(rest);
    case "status":
      return statusCmd();
    case "stats":
      return statsCmd(rest);
    case "audience":
      return audienceCmd(rest);
    case "escalation":
      return escalationCmd(rest);
    case "atoms":
      return atomsCmd(rest);
    case "admin":
      return adminBootstrapCmd(rest);
    case "audit":
      return auditCmd(rest);
    case "doctor":
      return await doctorCmd(rest);
    case "demo":
      return demoCmd(rest);
    default:
      println(
        chalk.yellow(
          "usage: pmk gateway <init|start|status|stats|audience|escalation|atoms|admin|audit|doctor|demo>",
        ),
      );
      process.exit(1);
  }
}
