import type { FengSuiCore } from "../../src/core.ts";
import type { ConsoleSettings } from "../../src/console-settings.ts";
import { FengSuiApi } from "../../src/http-api.ts";
import { FengSuiHttpServer } from "../../src/http-server.ts";
import type { FengSuiMcpServer } from "../../src/mcp-server.ts";
import type { NotificationHub } from "../../src/notify/hub.ts";
import type { SmsService } from "../../src/sms/service.ts";
import type { SseEventBus } from "../../src/sse-bus.ts";
import type { AppConfig } from "../../src/types.ts";
import { consoleSettingsFor } from "./console-settings.ts";

/**
 * The daemon's HTTP server in front of the REST API for a test that assembles its own core (the
 * daemon itself builds both in src/cli.ts). Nothing re-reads `.env` on reset-breaker here.
 */
export function testHttpServer(opts: {
  config: AppConfig;
  core: FengSuiCore;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  sms?: SmsService | null;
  notificationHub?: NotificationHub | null;
  settings?: ConsoleSettings;
  log?: (line: string) => void;
}): FengSuiHttpServer {
  const settings = opts.settings ?? consoleSettingsFor(opts.config);
  const api = new FengSuiApi({
    core: opts.core,
    settings,
    sseBus: opts.sseBus,
    sms: opts.sms ?? null,
    notificationHub: opts.notificationHub ?? null,
    metricsFromEnv: opts.config.metricsEnabled,
  });
  return new FengSuiHttpServer({ config: opts.config, api, sseBus: opts.sseBus, mcpServer: opts.mcpServer, settings, ...(opts.log ? { log: opts.log } : {}) });
}
