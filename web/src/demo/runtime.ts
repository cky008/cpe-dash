import { loadConfig } from "../../../src/config.ts";
import { ConsoleSettings } from "../../../src/console-settings.ts";
import { StorageCipher } from "../../../src/encrypted-file.ts";
import type { RouterFamily } from "../../../src/router-family.ts";
import { type FengSuiServices, assembleServices } from "../../../src/services.ts";
import { DemoTransport } from "./transport.ts";
import { TICK_MS, backfillHistory } from "./world.ts";
import {
  DEMO_BOT_TOKEN,
  DEMO_CONTACTS,
  DEMO_CPE_PASSWORD,
  type DemoRouter,
  type DemoWorldOptions,
  DLINK_DEMO_URL,
  ZTE_DEMO_URL,
  createDemoRouter,
  createDlinkDemoRouter,
  createUnverifiedDemoRouter,
  createZteDemoRouter,
  offlineTelegram,
} from "./worlds.ts";

/**
 * The live demo's back end: FengSui's own services (src/services.ts) and the REST API behind the
 * sign-in (src/http-api.ts), assembled in the page and talking to one of the demo's routers
 * (./worlds.ts), with the console's `fetch` and `EventSource` handed to them by ./transport.ts. In the
 * browser the Node built-ins those services use are the stand-ins of ./node/ (scripts/build-web.ts);
 * the tests run the same thing in Node. Nothing the daemon does is written again here: what is the
 * demo's own is the household it starts with and how it starts.
 */

/** The router the demo opens on: the H168-383, another Huawei model (`?router=other`), a ZTE one (`?router=zte`) or a D-Link one (`?router=dlink`). */
export type DemoWorld = "verified" | "other" | "zte" | "dlink";

const DAY_MS = 86_400_000;
/** When the first one-time code arrives, then how often another does. */
const FIRST_OTP_MS = 40_000;
const OTP_EVERY_MS = 150_000;
/** The household's own scrypt cost for the console password (the page computes it; the daemon's is 2^15). */
const DEMO_SCRYPT_COST = { N: 2 ** 10, r: 8, p: 1 } as const;
/** How long the start may wait for the first reads before the console opens anyway. */
const BOOT_DEADLINE_MS = 20_000;

export interface DemoRuntimeOptions extends DemoWorldOptions {
  world: DemoWorld;
  /** Where the daemon's stores live: the page's in-memory file system, or a temporary directory in the tests. */
  dataDir: string;
  /** The household's background (a 5 s step, one-time codes); the tests drive it themselves. */
  background?: boolean;
}

export interface DemoRuntime {
  world: DemoWorld;
  router: DemoRouter;
  services: FengSuiServices;
  transport: DemoTransport;
  stop(): Promise<void>;
}

function routerOf(world: DemoWorld, opts: DemoWorldOptions): { router: DemoRouter; url: string; family: RouterFamily } {
  if (world === "other") return { router: createUnverifiedDemoRouter(opts), url: "http://192.168.8.1", family: "huawei" };
  if (world === "zte") return { router: createZteDemoRouter(opts), url: ZTE_DEMO_URL, family: "zte-goform" };
  if (world === "dlink") return { router: createDlinkDemoRouter(opts), url: DLINK_DEMO_URL, family: "dlink" };
  return { router: createDemoRouter(opts), url: "http://192.168.8.1", family: "huawei" };
}

/** Telegram as the household left it: the owner's chat and a family group linked with /auth (one of .env's chats besides). */
function telegramState(nowMs: number): unknown {
  return {
    version: 1,
    authorizedChatIds: ["-1002", "1001"],
    groupLinks: [["-1002", { userId: "1001", threadId: 7 }]],
    linkedVia: [],
    linkedAt: [
      ["-1002", nowMs - 2 * DAY_MS],
      ["1001", nowMs - 12 * DAY_MS],
    ],
    replyTargets: [],
    alertsMutedUntilMs: null,
  };
}

/** A data key for this page only: 32 random bytes as hex. */
function randomKey(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function settled(work: ReadonlyArray<Promise<unknown>>): Promise<void> {
  await Promise.allSettled(work);
}

/** Start the daemon's services in front of the demo's router and have every first read land before the console opens. */
export async function startDemoRuntime(opts: DemoRuntimeOptions): Promise<DemoRuntime> {
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? Math.random;
  const { router, url, family } = routerOf(opts.world, { now, random, autoReply: opts.autoReply ?? false, ...(opts.replyAfterMs !== undefined ? { replyAfterMs: opts.replyAfterMs } : {}) });
  const loaded = loadConfig({
    envPath: `${opts.dataDir}/demo.env`,
    ignoreProcessEnv: true,
    overrides: {
      CPE_URL: url,
      CPE_PASSWORD: DEMO_CPE_PASSWORD,
      STATE_FILE: `${opts.dataDir}/state.json`,
      POLL_INTERVAL_MS: String(TICK_MS),
      NEIGHBOR_SCAN_INTERVAL_MS: "60000",
      SMS_SEND_STATUS_TIMEOUT_MS: "8000",
      // The household runs self-healing (as `npm run demo` does): its WAN never drops, so it never writes
      LOCK_ROLLBACK_AFTER_MIN: "10",
      WAN_AUTO_RECONNECT_AFTER_MIN: "3",
      TELEGRAM_BOT_TOKEN: DEMO_BOT_TOKEN,
      TELEGRAM_CHAT_IDS: "1003",
    },
  });
  // Encrypted at rest as the daemon's stores always are, under a key made up for this page (the first write makes the directory)
  const config = { ...loaded, dataEncryptionKey: randomKey(), apiToken: "", apiTokenReadonly: "", webhookUrl: "", webhookSecret: "", peerDiscoveryEnabled: false };
  new StorageCipher(config.dataEncryptionKey).writeJsonFile(config.telegramStateFile, telegramState(now()));

  // A router of another brand is saved with its brand, as the console saves one (no .env names a brand)
  if (family !== "huawei") {
    const saved = new ConsoleSettings({ filePath: config.settingsFile, cipher: new StorageCipher(config.dataEncryptionKey), scryptCost: DEMO_SCRYPT_COST });
    saved.importFromEnv(config);
    saved.setCpe({ url, username: "", password: DEMO_CPE_PASSWORD, family });
    await saved.flush();
  }

  const services = assembleServices({ config, fetchImpl: router.fetchImpl, notifyFetchImpl: offlineTelegram(), log: () => undefined, scryptCost: DEMO_SCRYPT_COST });
  const { settings, monitor, sms } = services;
  // The household is set up already: a console password, two tokens, contacts, a day of history
  settings.markReviewed();
  await settings.setLogin("demo-console-password");
  const grafana = settings.createToken({ name: "Grafana", permissions: [], lifetimeDays: null });
  settings.createToken({ name: "Claude Code", permissions: ["sms-read"], lifetimeDays: 90 });
  settings.resolveBearer(grafana.token);
  for (const contact of DEMO_CONTACTS) sms?.upsertContact(contact);
  backfillHistory(services.timeseries, router.base, now(), random);

  const transport = new DemoTransport({ services });
  services.start();
  // The first reads, at once (no answer times while the page starts), the slow sweeps included
  router.setLatencyScale(0);
  const boot = (async (): Promise<void> => {
    await services.startBackground(false);
    await monitor.refreshTelemetry();
    await monitor.identifyDevice();
    await settled([
      monitor.refreshTopology({ ignoreCooldown: true }),
      monitor.refreshSettings({ ignoreCooldown: true }),
      monitor.refreshAccessControl({ ignoreCooldown: true }),
      monitor.refreshNeighbors({ ignoreCooldown: true }),
      monitor.refreshCellular({ ignoreCooldown: true }),
      sms?.sync("full") ?? Promise.resolve(),
    ]);
  })();
  await Promise.race([boot.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, BOOT_DEADLINE_MS))]);
  router.setLatencyScale(1);
  transport.signIn();

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  if (opts.background !== false) {
    timers.push(setInterval(() => router.advance(), TICK_MS));
    const deliver = (): void => {
      router.pushOtp();
      timers.push(setTimeout(deliver, OTP_EVERY_MS));
    };
    timers.push(setTimeout(deliver, FIRST_OTP_MS));
  }
  return {
    world: opts.world,
    router,
    services,
    transport,
    async stop(): Promise<void> {
      for (const timer of timers) clearTimeout(timer);
      transport.close();
      await services.close();
    },
  };
}
