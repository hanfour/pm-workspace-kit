import {
  findClaudeExecutable,
  resolveProvider as resolveRuntimeProvider,
  type LlmProvider,
} from "@pmk/llm";
import type { PmkConfig } from "@pmk/shared";
import { appendGatewayEvent } from "../gateway/events";

export { findClaudeExecutable };

/** Gateway-specific usage auditing is injected at this application boundary. */
export function resolveProvider(config: PmkConfig): LlmProvider {
  return resolveRuntimeProvider(config, { onUsage: appendGatewayEvent });
}

export function resolveProviderOrExit(config: PmkConfig): LlmProvider {
  try {
    return resolveProvider(config);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
