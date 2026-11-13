import type { DriverFamily } from "../router-family.ts";
import { DriverCpeClient, type DriverCpeClientOptions, type DriverProtocol } from "./client.ts";
import { fiberhomeProtocol } from "./fiberhome.ts";
import { nradioProtocol } from "./nradio.ts";
import { openwrtProtocol } from "./openwrt.ts";
import { pinsuProtocol } from "./pinsu.ts";
import { tozedProtocol } from "./tozed.ts";
import { zteGoformProtocol } from "./zte/goform.ts";
import { zteZwrtProtocol } from "./zte/zwrt.ts";

/**
 * Registry of all non-Huawei router protocol drivers supported by FengSui.
 */
export const DRIVER_PROTOCOLS: Readonly<Record<DriverFamily, DriverProtocol>> = {
  "zte-goform": zteGoformProtocol,
  "zte-zwrt": zteZwrtProtocol,
  pinsu: pinsuProtocol,
  tozed: tozedProtocol,
  fiberhome: fiberhomeProtocol,
  nradio: nradioProtocol,
  openwrt: openwrtProtocol,
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
