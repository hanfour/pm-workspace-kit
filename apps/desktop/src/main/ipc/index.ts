import { registerFsHandlers } from "./fs";
import { registerLlmHandlers } from "./llm";

export function registerIpcHandlers(repoRoot: string): void {
  registerFsHandlers(repoRoot);
  registerLlmHandlers();
}
