import type { DriverFamily } from "../router-family.ts";
import { DriverCpeClient, type DriverCpeClientOptions, type DriverProtocol } from "./client.ts";

/**
 * Registry of all non-Huawei router protocol drivers supported by FengSui. Their modules
 * (./brand-protocols.ts) load the first time one of them is asked something (a login-free detection,
 * the check before a login, a login), which every protocol answers asynchronously anyway: a daemon
 * on a Huawei router never loads them, and neither does the live demo's page on its Huawei routers.
 */

let loading: Promise<typeof import("./brand-protocols.ts")> | null = null;
const brandProtocols = (): Promise<typeof import("./brand-protocols.ts")> => (loading ??= import("./brand-protocols.ts"));

/** A brand's protocol whose module loads on first use (once; every later call uses the same). */
function onDemand(family: DriverFamily): DriverProtocol {
  const protocol = async (): Promise<DriverProtocol> => (await brandProtocols()).BRAND_PROTOCOLS[family];
  return {
    family,
    detect: async (http) => (await protocol()).detect(http),
    // A brand without its own check answers none, as the session client takes a protocol without one
    precheck: async (http) => {
      const real = await protocol();
      return real.precheck ? await real.precheck(http) : null;
    },
    login: async (http, credentials) => (await protocol()).login(http, credentials),
  };
}

export const DRIVER_PROTOCOLS: Readonly<Record<DriverFamily, DriverProtocol>> = {
  "zte-goform": onDemand("zte-goform"),
  "zte-zwrt": onDemand("zte-zwrt"),
  pinsu: onDemand("pinsu"),
  tozed: onDemand("tozed"),
  fiberhome: onDemand("fiberhome"),
  nradio: onDemand("nradio"),
  dlink: onDemand("dlink"),
  openwrt: onDemand("openwrt"),
};

/**
 * Resolve the protocol driver for the given router family.
 * Throws a TypeError if the family is not a recognized driver family.
 */
export function driverProtocolOf(family: DriverFamily): DriverProtocol {
  const protocol = DRIVER_PROTOCOLS[family];
  if (!protocol) {
    throw new TypeError(`Unknown driver protocol family "${String(family)}"`);
  }
  return protocol;
}

/**
 * Instantiate a DriverCpeClient configured for the specified driver family.
 */
export function createDriverClient(family: DriverFamily, options: Omit<DriverCpeClientOptions, "protocol">): DriverCpeClient {
  const protocol = driverProtocolOf(family);
  return new DriverCpeClient({ ...options, protocol });
}
