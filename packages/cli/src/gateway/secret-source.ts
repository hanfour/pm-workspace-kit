import { execSync } from "node:child_process";

/**
 * On-disk representation of a gateway secret. A bare string is a literal
 * (back-compat). An object is a *reference* resolved before runtime use.
 */
export type SecretSource = string | { env: string } | { cmd: string };

/** Thrown when a reference is malformed or can't produce a non-empty value. */
export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate + narrow an untrusted on-disk secret value. A string is a literal.
 * An object MUST have exactly one of `env` / `cmd` with a non-empty string
 * value — anything else throws (a reference typo must be loud, never silently
 * "absent"). `undefined` is genuinely absent and returns `undefined`.
 */
export function validateSecretSource(
  v: unknown,
  secretName: string,
): SecretSource | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  if (!isRecord(v)) {
    throw new SecretResolutionError(
      `gateway: ${secretName} must be a string or a {env}|{cmd} reference`,
    );
  }
  const keys = Object.keys(v);
  const hasEnv = "env" in v;
  const hasCmd = "cmd" in v;
  if (hasEnv && hasCmd) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference cannot have both {env} and {cmd}`,
    );
  }
  if (!hasEnv && !hasCmd) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference must have one of {env}|{cmd}`,
    );
  }
  if (keys.length !== 1) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference has unexpected extra keys`,
    );
  }
  const value = hasEnv ? v.env : v.cmd;
  if (typeof value !== "string" || value.length === 0) {
    throw new SecretResolutionError(
      `gateway: ${secretName} reference value must be a non-empty string`,
    );
  }
  return hasEnv ? { env: value } : { cmd: value };
}

/**
 * Resolve a well-formed source to a secret string. Assumes validation already
 * ran (see validateSecretSource). Throws `SecretResolutionError` when an
 * explicit reference yields nothing — the error NEVER includes the command's
 * stdout or stderr (either may carry the secret); only the secret name +
 * exit/signal.
 *
 * A literal value (including an empty string) is returned verbatim; only
 * `{env}` and `{cmd}` references enforce non-empty output.
 */
export function resolveSecret(
  src: SecretSource | undefined,
  secretName: string,
): string | undefined {
  if (src === undefined) return undefined;
  if (typeof src === "string") return src;
  if ("env" in src) {
    const v = process.env[src.env];
    if (v === undefined || v === "") {
      throw new SecretResolutionError(
        `gateway: ${secretName} env var ${src.env} is unset or empty`,
      );
    }
    return v;
  }
  let out: string;
  try {
    out = execSync(src.cmd, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // SECURITY: never put err.stdout / err.stderr in the message — they may carry the secret.
    const e = err as { status?: number; signal?: string };
    const detail = e.signal ? `signal ${e.signal}` : `exit ${e.status ?? "?"}`;
    throw new SecretResolutionError(
      `gateway: ${secretName} command failed (${detail})`,
    );
  }
  const trimmed = out.trimEnd();
  if (trimmed === "") {
    throw new SecretResolutionError(
      `gateway: ${secretName} command produced no output`,
    );
  }
  return trimmed;
}

/** Disk-shape label for doctor reporting — never reveals the value. */
export function secretDiskLabel(src: SecretSource | undefined): string {
  if (src === undefined) return "unset";
  if (typeof src === "string") return "literal";
  if ("env" in src) return `env:${src.env}`;
  return "cmd";
}
