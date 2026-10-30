import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.ts";
import { HuaweiCpeClient } from "./cpe-client.ts";
import { FengSuiHttpServer } from "./http-server.ts";
import { FengSuiMcpServer } from "./mcp-server.ts";
import { MutexSessionScheduler } from "./scheduler.ts";
import { SseEventBus } from "./sse-bus.ts";
import { EncryptedStateStore } from "./state-store.ts";
import { TimeSeriesRingBuffer } from "./timeseries.ts";
import type { AppConfig } from "./types.ts";

export type CliMode = "serve" | "mcp" | "help";

export interface ParsedCliCommand {
  mode: CliMode;
  envPath?: string;
  mcpBackgroundPoll: boolean;
}

export function parseCliCommand(argv: ReadonlyArray<string>): ParsedCliCommand {
  const args = argv.slice(2);
  let mode: CliMode = "serve";
  let envPath: string | undefined;
  let mcpBackgroundPoll = process.env["MCP_STDIO_BACKGROUND_POLL"] === "true";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--help" || arg === "-h" || arg === "help") {
      return { mode: "help", envPath, mcpBackgroundPoll };
    }
    if (arg === "serve") {
      mode = "serve";
      continue;
    }
    if (arg === "mcp") {
      mode = "mcp";
      continue;
    }
    if (arg === "--poll") {
      mcpBackgroundPoll = true;
      continue;
    }
    if (arg === "--env" && typeof args[i + 1] === "string") {
      envPath = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--env=")) {
      envPath = arg.slice("--env=".length);
      continue;
    }
    throw new Error(`Unknown CLI argument "${arg}". Run with --help for usage.`);
  }

  return { mode, envPath, mcpBackgroundPoll };
}

export interface FengSuiRuntimeStack {
  config: AppConfig;
  stateStore: EncryptedStateStore;
  timeseries: TimeSeriesRingBuffer;
  cpeClient: HuaweiCpeClient;
  scheduler: MutexSessionScheduler;
  sseBus: SseEventBus;
  mcpServer: FengSuiMcpServer;
  httpServer: FengSuiHttpServer;
}

export function createFengSuiRuntime(options: {
  config: AppConfig;
  envPath?: string;
  fetchImpl?: typeof fetch;
}): FengSuiRuntimeStack {
  const { config, envPath, fetchImpl } = options;

  const stateStore = new EncryptedStateStore({
    filePath: config.stateFile,
    encryptionKey: config.dataEncryptionKey,
  });

  const timeseries = new TimeSeriesRingBuffer({
    retentionHours: config.historyRetentionHours,
  });

  const cpeClient = new HuaweiCpeClient({
    cpeUrl: config.cpeUrl,
    cpeUsername: config.cpeUsername,
    cpePassword: config.cpePassword,
    requestTimeoutMs: config.requestTimeoutMs,
    respectBrowserSession: config.respectBrowserSession,
    fetchImpl,
  });

  const scheduler = new MutexSessionScheduler({
    client: cpeClient,
    stateStore,
    timeseries,
    pollIntervalMs: config.pollIntervalMs,
    neighborScanIntervalMs: config.neighborScanIntervalMs,
    stateFlushIntervalMs: config.stateFlushIntervalMs,
    redactSensitive: config.redactSensitiveInApi,
  });

  const sseBus = new SseEventBus({
    heartbeatMs: config.sseHeartbeatMs,
    maxClients: config.sseMaxClients,
  });

  const mcpServer = new FengSuiMcpServer({
    scheduler,
    allowMutations: config.mcpAllowMutations,
  });

  const httpServer = new FengSuiHttpServer({
    config,
    scheduler,
    sseBus,
    mcpServer,
    envPath,
  });

  return {
    config,
    stateStore,
    timeseries,
    cpeClient,
    scheduler,
    sseBus,
    mcpServer,
    httpServer,
  };
}

export function formatCliHelp(): string {
  return [
    "FengSui (烽燧 / cpe-dash) — Huawei 5G CPE Ultra 6 (H168-383) Telemetry, Control & MCP Platform",
    "",
    "Usage:",
    "  cpe-dash [serve] [--env <path>]        Start Web Dashboard, REST API, SSE & Streamable HTTP MCP daemon",
    "  cpe-dash mcp [--poll] [--env <path>]   Start NDJSON stdio MCP Server for local AI agents",
    "  cpe-dash --help                        Show this help message",
  ].join("\n");
}

function redirectConsoleToStderrForStdioMcp(): void {
  const writeStderr = (...items: unknown[]): void => {
    const line = items
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join(" ");
    process.stderr.write(`${line}\n`);
  };
  console.log = writeStderr;
  console.info = writeStderr;
  console.warn = writeStderr;
}

export async function runCli(argv: ReadonlyArray<string> = process.argv): Promise<void> {
  const cmd = parseCliCommand(argv);

  if (cmd.mode === "help") {
    process.stdout.write(`${formatCliHelp()}\n`);
    return;
  }

  if (cmd.mode === "mcp") {
    redirectConsoleToStderrForStdioMcp();
  }

  const config = loadConfig({ envPath: cmd.envPath });
  const stack = createFengSuiRuntime({ config, envPath: cmd.envPath });

  if (cmd.mode === "mcp") {
    stack.scheduler.init();
    if (cmd.mcpBackgroundPoll) {
      stack.scheduler.start();
    }
    const detachStdio = stack.mcpServer.attachStdio(process.stdin, process.stdout);
    process.stderr.write(
      `[fengsui-mcp] stdio NDJSON server ready (cpe=${config.cpeUrl}, mutations=${config.mcpAllowMutations})\n`
    );

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      detachStdio();
      await stack.scheduler.stop();
    };

    process.once("SIGINT", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      void shutdown().finally(() => process.exit(0));
    });
    process.stdin.once("end", () => {
      void shutdown();
    });
    return;
  }

  // `serve` daemon mode
  stack.scheduler.init();
  stack.sseBus.attachScheduler(stack.scheduler);
  stack.sseBus.start();
  stack.scheduler.start();

  let boundAddress: { host: string; port: number } | null = null;
  if (config.webEnabled) {
    boundAddress = await stack.httpServer.listen();
    process.stdout.write(
      `[fengsui] HTTP + SSE + MCP server listening on http://${boundAddress.host}:${boundAddress.port} (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms, mcpHttp=${config.mcpHttpEnabled})\n`
    );
  } else {
    process.stdout.write(
      `[fengsui] Background telemetry daemon started with WEB_ENABLED=false (cpe=${config.cpeUrl}, poll=${config.pollIntervalMs}ms)\n`
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`[fengsui] Received ${signal}, flushing encrypted state and closing server...\n`);
    stack.sseBus.stop();
    await stack.httpServer.close();
    await stack.scheduler.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

const isDirectEntry =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectEntry) {
  runCli(process.argv).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[fengsui] Fatal startup error: ${msg}\n`);
    process.exit(1);
  });
}
