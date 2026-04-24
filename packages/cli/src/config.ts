import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DEFAULT_CONFIG, type PmkConfig } from "@pmk/shared";

const CONFIG_FILE = path.join(os.homedir(), ".pmk", "config.json");

/**
 * Load config from env vars and (optionally) ~/.pmk/config.json.
 * Env vars take precedence over file, file takes precedence over defaults.
 *
 * In M2 this expands to read from OS keychain via keytar.
 */
export function loadConfig(): PmkConfig {
  let fileConfig: Partial<PmkConfig> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (err) {
      console.warn(`[pmk] ignoring malformed ${CONFIG_FILE}`);
    }
  }

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    apiKey: process.env.ANTHROPIC_API_KEY ?? fileConfig.apiKey,
    model: process.env.PMK_MODEL ?? fileConfig.model ?? DEFAULT_CONFIG.model,
    language:
      (process.env.PMK_LANG as PmkConfig["language"]) ??
      fileConfig.language ??
      DEFAULT_CONFIG.language,
  };
}

export function requireApiKey(config: PmkConfig): string {
  if (!config.apiKey) {
    console.error(
      "[pmk] missing Anthropic API key.\n" +
        "  Set ANTHROPIC_API_KEY in your environment, or edit ~/.pmk/config.json.",
    );
    process.exit(1);
  }
  return config.apiKey;
}
