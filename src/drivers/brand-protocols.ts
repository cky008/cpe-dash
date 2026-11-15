import { fiberhomeProtocol } from "./fiberhome.ts";
import { nradioProtocol } from "./nradio.ts";
import { openwrtProtocol } from "./openwrt.ts";
import { pinsuProtocol } from "./pinsu.ts";
import { tozedProtocol } from "./tozed.ts";
import { zteGoformProtocol } from "./zte/goform.ts";
import { zteZwrtProtocol } from "./zte/zwrt.ts";

/**
 * Every non-Huawei brand's protocol, in one module that ./brands.ts loads the first time any of them
 * is needed (one load for all of them: the brands' code compresses better together than apart).
 */
export const BRAND_PROTOCOLS = {
  "zte-goform": zteGoformProtocol,
  "zte-zwrt": zteZwrtProtocol,
  pinsu: pinsuProtocol,
  tozed: tozedProtocol,
  fiberhome: fiberhomeProtocol,
  nradio: nradioProtocol,
  openwrt: openwrtProtocol,
} as const;
