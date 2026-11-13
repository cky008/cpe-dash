import crypto from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt, computeScram, curve25519Mul, huaweiXssDecode, huaweiXssEncode } from "../../src/protocols/hilink/crypto.ts";
import { getXmlBlocks, getXmlTag } from "../../src/protocols/hilink/xml.ts";

/**
 * In-memory Huawei H168-383 SMS store with the real wire behaviour exercised by `src/sms/protocol.ts`:
 * SCRAM login, ECC public key + HMAC signature, AES-256-GCM `enc-type=1|2|3` endpoints, plain
 * `sms-list` paging (optionally "unsupported" with `100002`), `send-status` progression,
 * `set-read` / `delete-sms` batches and the unauthenticated `check-notifications` probe.
 *
 * All numbers use reserved fictional ranges (Irish `+3538300000xx`, Ofcom drama `+447700900xxx`).
 */
export interface MockSms {
  index: number;
  phone: string;
  content: string;
  date: string;
  /** `0` unread, `1` read, `3` sent, `4` send failed. */
  smstat: string;
  box: 1 | 2;
}

export interface MockSmsCpeOptions {
  password?: string;
  messages?: MockSms[];
  smsListUnsupported?: boolean;
  /** `success`, `fail`, or `stuck` (send-status keeps reporting the phone as pending). */
  sendOutcome?: "success" | "fail" | "stuck";
  /** Number of `send-status` polls that still report the phone as pending before completing. */
  pendingStatusPolls?: number;
  stateLoginXml?: () => string;
  smsMax?: number;
  storageFull?: boolean;
  /** Optional hook to inject faults for a path (return a raw response body or throw). */
  intercept?: (pathname: string, method: string) => string | undefined;
}

const SERVER_ECC_PRIV = BigInt("0x09112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
const SERVER_ECC_PUB = curve25519Mul(SERVER_ECC_PRIV, 9n).toString(16).padStart(64, "0");

function newestFirst(a: MockSms, b: MockSms): number {
  return a.date === b.date ? b.index - a.index : a.date > b.date ? -1 : 1;
}

function messageXml(m: MockSms, tag: "Message" | "message", withCurbox: boolean): string {
  const curbox = withCurbox ? `<curbox>${m.box === 2 ? 1 : 0}</curbox>` : "";
  return (
    `<${tag}><Smstat>${m.smstat}</Smstat><Index>${m.index}</Index><Phone>${huaweiXssEncode(m.phone)}</Phone>` +
    `<Content>${huaweiXssEncode(m.content)}</Content><Date>${m.date}</Date><Sca></Sca><SaveType>4</SaveType>` +
    `<Priority>0</Priority><SmsType>1</SmsType>${curbox}</${tag}>`
  );
}

export function createMockSmsCpe(opts: MockSmsCpeOptions = {}) {
  const password = opts.password ?? "sms_mock_password";
  const saltHex = "aa".repeat(32);
  const serverNonceTail = "cc".repeat(32);
  const store: MockSms[] = (opts.messages ?? []).map((m) => ({ ...m }));
  const requests: Array<{ path: string; method: string; encType: string | null }> = [];
  const sentRequests: string[] = [];
  const setReadBatches: number[][] = [];
  const deleteBatches: number[][] = [];
  let nextIndex = Math.max(40000, ...store.map((m) => m.index)) + 1;
  let firstNonce = "";
  let loggedIn = false;
  let loginCount = 0;
  let pendingPolls = 0;
  let pendingPhones: string[] = [];
  let tokenSeq = 0;

  const control = {
    smsListUnsupported: Boolean(opts.smsListUnsupported),
    sendOutcome: opts.sendOutcome ?? "success",
    pendingStatusPolls: opts.pendingStatusPolls ?? 1,
    storageFull: Boolean(opts.storageFull),
    stateLoginXml: opts.stateLoginXml,
  };

  const counters = () => ({
    unread: store.filter((m) => m.box === 1 && m.smstat === "0").length,
    inbox: store.filter((m) => m.box === 1).length,
    outbox: store.filter((m) => m.box === 2).length,
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const p = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const encType = url.searchParams.get("enc-type");
    const clientPub = url.searchParams.get("ecc-client-pubkey");
    requests.push({ path: p, method, encType });

    const respond = (payload: string, withTokens = true): Response => {
      const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
      if (withTokens) {
        headers.set("__RequestVerificationTokenone", `mt_${String(++tokenSeq).padStart(29, "0")}`);
        headers.set("__RequestVerificationTokentwo", `mt_${String(++tokenSeq).padStart(29, "0")}`);
      }
      headers.set("Set-Cookie", "SessionID=mock_sms_session; Path=/; HttpOnly");
      return new Response(payload, { status: 200, headers });
    };

    const injected = opts.intercept?.(p, method);
    if (injected !== undefined) return respond(injected);

    if (p === "/api/user/state-login") {
      return respond(
        control.stateLoginXml?.() ??
          `<response><State>${loggedIn ? "0" : "-1"}</State><lockstatus>0</lockstatus><remainwaittime>0</remainwaittime></response>`,
        false
      );
    }
    if (p === "/api/monitoring/check-notifications") {
      const c = counters();
      return respond(
        `<response><UnreadMessage>${c.unread}</UnreadMessage><SmsStorageFull>${control.storageFull ? 1 : 0}</SmsStorageFull><OnlineUpdateStatus>0</OnlineUpdateStatus></response>`,
        false
      );
    }
    if (p === "/api/webserver/token") {
      return respond(`<response><token>${"0".repeat(32)}${crypto.randomBytes(16).toString("hex")}</token></response>`, false);
    }
    if (p === "/api/user/challenge_login") {
      firstNonce = getXmlTag(body, "firstnonce") ?? "";
      return respond(
        `<response><salt>${saltHex}</salt><iterations>1000</iterations><servernonce>${firstNonce}${serverNonceTail}</servernonce></response>`
      );
    }
    if (p === "/api/user/authentication_login") {
      const serverNonce = `${firstNonce}${serverNonceTail}`;
      const scram = computeScram(password, saltHex, 1000, firstNonce, serverNonce);
      if ((getXmlTag(body, "clientproof") ?? "").toLowerCase() !== scram.clientProofHex.toLowerCase()) {
        return respond("<error><code>108006</code><remaincount>2</remaincount></error>");
      }
      loggedIn = true;
      loginCount += 1;
      const eccSig = crypto.createHmac("sha256", scram.serverKey).update(Buffer.from(SERVER_ECC_PUB, "hex")).digest("hex");
      return respond(
        `<response><serversignature>${scram.expectedServerSig}</serversignature><ecc_server_pubkey>${SERVER_ECC_PUB}</ecc_server_pubkey><ecc_pubkey_signature>${eccSig}</ecc_pubkey_signature></response>`
      );
    }
    if (p === "/api/user/logout") {
      loggedIn = false;
      return respond("<response>OK</response>");
    }
    // Which router this is: a write reads it first when no poll has yet (the write gate)
    if (p === "/api/device/information") {
      return respond("<response><DeviceName>H168-383</DeviceName><SoftwareVersion>4.4.0.1(H1006SP19C00)</SoftwareVersion></response>");
    }
    if (p === "/api/sms/sms-count") {
      const c = counters();
      return respond(
        `<response><LocalUnread>${c.unread}</LocalUnread><LocalInbox>${c.inbox}</LocalInbox><LocalOutbox>${c.outbox}</LocalOutbox><LocalDraft>0</LocalDraft><LocalDeleted>0</LocalDeleted><SimUnread>0</SimUnread><LocalMax>${opts.smsMax ?? 500}</LocalMax></response>`
      );
    }
    if (p === "/api/sms/sms-count-contact" && method === "GET") {
      return respond(`<response><count>${new Set(store.map((m) => m.phone)).size}</count></response>`);
    }
    if (p === "/api/sms/sms-list") {
      if (control.smsListUnsupported) return respond("<error><code>100002</code><message></message></error>");
      const box = Number(getXmlTag(body, "BoxType") ?? "1");
      const page = Number(getXmlTag(body, "PageIndex") ?? "1");
      const count = Number(getXmlTag(body, "ReadCount") ?? "20");
      const items = store.filter((m) => m.box === box).sort(newestFirst).slice((page - 1) * count, page * count);
      return respond(
        `<response><Count>${items.length}</Count><Messages>${items.map((m) => messageXml(m, "Message", false)).join("")}</Messages></response>`
      );
    }
    if (p === "/api/sms/set-read") {
      const batch = getXmlBlocks(body, "Index").map(Number);
      setReadBatches.push(batch);
      for (const m of store) if (batch.includes(m.index) && m.smstat === "0") m.smstat = "1";
      return respond("<response>OK</response>");
    }
    if (p === "/api/sms/delete-sms") {
      const batch = getXmlBlocks(body, "Index").map(Number);
      deleteBatches.push(batch);
      for (let i = store.length - 1; i >= 0; i--) if (batch.includes(store[i]!.index)) store.splice(i, 1);
      return respond("<response>OK</response>");
    }

    if (clientPub && encType) {
      const shareKeyHex = curve25519Mul(SERVER_ECC_PRIV, BigInt(`0x${clientPub}`)).toString(16);
      const plainBody = encType === "1" ? body : aesGcmDecrypt(body, shareKeyHex);
      const encrypted = (xml: string): Response => respond(aesGcmEncrypt(xml, shareKeyHex));

      if (p === "/api/sms/sms-list-contact") {
        const page = Number(getXmlTag(plainBody, "pageindex") ?? "1");
        const count = Number(getXmlTag(plainBody, "readcount") ?? "20");
        const latestByPhone = new Map<string, MockSms>();
        for (const m of [...store].sort(newestFirst)) if (!latestByPhone.has(m.phone)) latestByPhone.set(m.phone, m);
        const items = [...latestByPhone.values()].slice((page - 1) * count, page * count);
        return encrypted(
          `<response><count>${latestByPhone.size}</count><messages>${items.map((m) => messageXml(m, "message", true)).join("")}</messages></response>`
        );
      }
      if (p === "/api/sms/sms-count-contact") {
        const phone = huaweiXssDecode(getXmlTag(plainBody, "phone") ?? "");
        return respond(`<response><count>${store.filter((m) => m.phone === phone).length}</count></response>`);
      }
      if (p === "/api/sms/sms-list-phone") {
        const phone = getXmlTag(plainBody, "phone") ?? "";
        const page = Number(getXmlTag(plainBody, "pageindex") ?? "1");
        const count = Number(getXmlTag(plainBody, "readcount") ?? "20");
        const items = store
          .filter((m) => m.phone === phone)
          .sort(newestFirst)
          .slice((page - 1) * count, page * count);
        return encrypted(
          `<response><count>${items.length}</count><messages>${items.map((m) => messageXml(m, "message", true)).join("")}</messages></response>`
        );
      }
      if (p === "/api/sms/send-sms") {
        sentRequests.push(plainBody);
        const phones = getXmlBlocks(plainBody, "Phone").map((ph) => huaweiXssDecode(ph));
        const content = huaweiXssDecode(getXmlTag(plainBody, "Content") ?? "");
        const date = getXmlTag(plainBody, "Date") ?? "2026-10-30 12:00:00";
        for (const phone of phones) {
          store.push({
            index: nextIndex++,
            phone,
            content,
            date,
            smstat: control.sendOutcome === "fail" ? "4" : "3",
            box: 2,
          });
        }
        pendingPhones = phones;
        pendingPolls = control.pendingStatusPolls;
        return respond("<response>OK</response>");
      }
      if (p === "/api/sms/send-status") {
        const still = control.sendOutcome === "stuck" || pendingPolls > 0;
        if (pendingPolls > 0) pendingPolls -= 1;
        const phoneList = pendingPhones.join(",");
        const xml = still
          ? `<response><Phone>${phoneList}</Phone><SucPhone></SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`
          : control.sendOutcome === "fail"
            ? `<response><Phone></Phone><SucPhone></SucPhone><FailPhone>${phoneList}</FailPhone><SendFailCode>113018</SendFailCode></response>`
            : `<response><Phone></Phone><SucPhone>${phoneList}</SucPhone><FailPhone></FailPhone><SendFailCode>0</SendFailCode></response>`;
        return encrypted(xml);
      }
    }

    return respond("<response>OK</response>");
  };

  return {
    fetchImpl,
    password,
    store,
    control,
    requests,
    sentRequests,
    setReadBatches,
    deleteBatches,
    getLoginCount: () => loginCount,
    pushIncoming(msg: { phone: string; content: string; date: string }): MockSms {
      const created: MockSms = { index: nextIndex++, smstat: "0", box: 1, ...msg };
      store.push(created);
      return created;
    },
    serverEccPublicKeyHex: SERVER_ECC_PUB,
  };
}
