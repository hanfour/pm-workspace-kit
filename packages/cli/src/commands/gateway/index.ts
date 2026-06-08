import chalk from "chalk";
import { println } from "../../io";
import {
  auditCmd,
  demoCmd,
  doctorCmd,
  initCmd,
  restartCmd,
  startCmd,
  statsCmd,
  statusCmd,
  stopCmd,
} from "./ops";
import { audienceCmd } from "./audience";
import { escalationCmd } from "./escalation";
import { atomsCmd } from "./atoms";
import { adminBootstrapCmd } from "./admin";
import { installServiceCmd } from "./service";

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
    case "stop":
      return await stopCmd();
    case "restart":
      return await restartCmd();
    case "install-service":
      return installServiceCmd({
        load: rest.includes("--load"),
        uninstall: rest.includes("--uninstall"),
        force: rest.includes("--force"),
      });
    default:
      println(
        chalk.yellow(
          "usage: pmk gateway <init|start|stop|restart|status|stats|audience|escalation|atoms|admin|audit|doctor|demo|install-service>",
        ),
      );
      process.exit(1);
  }
}
