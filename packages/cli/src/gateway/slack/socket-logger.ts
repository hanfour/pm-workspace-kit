/**
 * A `Logger` wrapper for the Socket-Mode client that taps pong/ping
 * timeout WARN lines (the client surfaces these only as log lines, not
 * events) and forwards them to `onPongTimeout`, while passing EVERY log
 * line through to the wrapped logger unchanged. Observe-only: it never
 * swallows or rewrites a log.
 */
import { ConsoleLogger, LogLevel, type Logger } from "@slack/logger";

const PONG_TIMEOUT_RE = /pong wasn't received|ping wasn't received/i;

export function createPongTapLogger(onPongTimeout: () => void, base?: Logger): Logger {
  let sink: Logger;
  if (base) {
    sink = base;
  } else {
    sink = new ConsoleLogger();
    sink.setLevel(LogLevel.WARN);
  }
  return {
    debug: (...msgs: unknown[]) => sink.debug(...msgs),
    info: (...msgs: unknown[]) => sink.info(...msgs),
    warn: (...msgs: unknown[]) => {
      if (PONG_TIMEOUT_RE.test(msgs.join(" "))) {
        try { onPongTimeout(); } catch { /* caller bug must not drop the log line */ }
      }
      sink.warn(...msgs);
    },
    error: (...msgs: unknown[]) => sink.error(...msgs),
    setLevel: (level: LogLevel) => sink.setLevel(level),
    getLevel: () => sink.getLevel(),
    setName: (name: string) => sink.setName(name),
  };
}
