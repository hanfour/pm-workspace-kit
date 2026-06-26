import { spawn as nodeSpawn } from "node:child_process";

export class MediaError extends Error {
  constructor(message: string) { super(message); this.name = "MediaError"; }
}
export type SpawnDeps = { spawn?: typeof nodeSpawn };

export async function runMedia(
  bin: "ffmpeg" | "ffprobe",
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  deps: SpawnDeps = {},
): Promise<{ stdout: string; stderr: string }> {
  const spawn = deps.spawn ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  return new Promise((resolve, reject) => {
    // SECURITY: args array (no shell); strip all secret-named vars from child env.
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/(_TOKEN|_KEY|_SECRET|PASSWORD|APIKEY|ANTHROPIC|OPENAI|SLACK|GITHUB|PMK_)/i.test(k)) continue;
      env[k] = v;
    }
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env, signal: opts.signal });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* noop */ } }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(new MediaError(`${bin} spawn failed: ${e.message}`)); });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new MediaError(`${bin} failed (${sig ? `signal ${sig}` : `exit ${code}`})`));
    });
  });
}
