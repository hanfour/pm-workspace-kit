import {
  AnthropicApiKeyProvider as RuntimeAnthropicApiKeyProvider,
} from "@pmk/llm";
import type { PmkConfig } from "@pmk/shared";
import { appendGatewayEvent } from "../gateway/events";

/** Gateway compatibility wrapper: telemetry belongs to this host boundary. */
export class AnthropicApiKeyProvider extends RuntimeAnthropicApiKeyProvider {
  constructor(config: PmkConfig & { apiKey: string }) {
    super(config, appendGatewayEvent);
  }
}
