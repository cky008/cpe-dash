# cpe-dash · FengSui (烽燧)

<p align="center">
  <strong>Self-Hosted 5G RF Telemetry · 3CA Carrier Aggregation · Neighbor Cell Scanner · Band & Cell Locking Platform for Huawei 5G CPE Ultra 6 (H168-383)</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> | <strong>English</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/Node.js-%3E%3D22.6.0-339933?logo=node.js&logoColor=white" alt="Node.js >= 22.6.0" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-7.0_Strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript 7.0 Strict" />
  </a>
  <a href="package.json">
    <img src="https://img.shields.io/badge/dependencies-0%20runtime-black" alt="Zero Runtime Dependencies" />
  </a>
  <a href="test/">
    <img src="https://img.shields.io/badge/coverage-96.6%25-brightgreen" alt="Coverage 96.6%" />
  </a>
  <a href="AGENTS.md">
    <img src="https://img.shields.io/badge/security-AES--256--GCM-0052CC?logo=vault&logoColor=white" alt="AES-256-GCM Security" />
  </a>
  <a href=".env.example">
    <img src="https://img.shields.io/badge/WEB__PORT-18384-6E56CF" alt="Default Port 18384" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-PolyForm_Noncommercial_1.0.0-orange.svg" alt="License" />
  </a>
</p>

---

**FengSui (烽燧 / `cpe-dash`)** is a self-hosted 5G RF telemetry, 3CA carrier aggregation analyzer, 4G/5G neighbor cell scanner, band/cell lock controller, dual-period traffic auditor, and LAN terminal topology platform engineered specifically for the **Huawei 5G CPE Ultra 6 (`H168-383`, firmware `4.4.0.1`)** (strictly focused on RF & network management, excluding SMS).

Designed for private home-lab environments such as **Synology DS923+ NAS (AMD Ryzen R1600 / 32GB RAM)**, `cpe-dash` is written in **100% Strict TypeScript (`strict: true`)** as a completely standalone repository with **zero production runtime npm dependencies** (relying exclusively on Node.js built-ins) and listens on isolated port `:18384` by default.

---

## Table of Contents

- [✨ Core Engineering & Protocol Highlights](#-core-engineering--protocol-highlights)
- [📡 H168-383 Hardware & Protocol Capability Panorama (Live-Verified)](#-h168-383-hardware--protocol-capability-panorama-live-verified)
- [🏗️ Repository Architecture](#️-repository-architecture)
- [🚀 Quick Start & Live Probe Suite](#-quick-start--live-probe-suite)
- [⚙️ `.env` Configuration Reference](#️-env-configuration-reference)
- [🛡️ Security Invariants & TDD Quality Gates](#️-security-invariants--tdd-quality-gates)
- [📚 Phase 1 Protocol Specification](#-phase-1-protocol-specification)
- [⚠️ Disclaimer & License](#️-disclaimer--license)

---

## ✨ Core Engineering & Protocol Highlights

- **⚡ `~26 ms` Ephemeral Sessions & Dual-Layer Browser Avoidance**
  - The H168-383 enforces a strict single-administrator session limit. `HuaweiCpeClient.withSession()` executes every authenticated transaction inside a serialized short-lived window (**`25 ms – 47 ms`** for lightweight polls; **`130 ms – 260 ms`** for 18-endpoint parallel sweeps) and unconditionally calls `POST /api/user/logout` inside `finally`.
  - **Dual-Layer Human Avoidance**: Checks `GET /api/user/state-login` prior to authentication (Layer 1: yields immediately with zero SCRAM overhead when `State != -1`), and silently yields `null` upon receiving cross-IP `108003` / `108009` occupied responses when another LAN host's browser is logged into `192.168.8.1` (Layer 2).
- **🛑 `108006` / `108007` Anti-Brute-Force Circuit Breaker**
  - Three consecutive wrong password attempts lock the H168-383 hardware admin account. Our built-in `CircuitBreaker` latches immediately upon `108006` (wrong password) or `108007` (locked), short-circuiting all subsequent calls without network retries until `.env` is corrected and explicitly reset.
- **🔐 End-to-End Wire & At-Rest Cryptography**
  - Implements Huawei SCRAM-SHA256 authentication, **unclamped big-endian Curve25519 ECDH**, and **`enc-type=1|2|3` AES-256-GCM** payload encryption/decryption; local state files are encrypted at rest via `StorageCipher` (`scrypt` + `HKDF-SHA256` + `AES-256-GCM` with atomic `0600` writes).
- **🎯 Exact `BandMask` Bitwise Codec & 4G/5G Cell Lock Builders**
  - Cross-validated against reverse-engineered PC/Android `CpeVendorHUAWEI` (`v3.8.4`) plugins and live router firmware: computes arbitrary-width `Mask(N) = 1n << BigInt(N - 1)` hex bitmasks (matching H168-383's 14-band mask `0x40000007a0880800d5` bit-for-bit) and `/api/net/lock-freq` (`lock_mode 0..3`) XML payloads.

---

## 📡 H168-383 Hardware & Protocol Capability Panorama (Live-Verified)

Every capability below has been verified non-destructively against a live Huawei 5G CPE Ultra 6 (`H168-383` / `WL1H168M` / firmware `4.4.0.1(H1006SP19C00)`) on `192.168.8.1`:

| Capability Domain | Verified Endpoints | Live-Measured Telemetry & Protocol Structure | Status |
| :--- | :--- | :--- | :---: |
| **3CA Carrier Aggregation** | `GET /api/device/signal`<br/>`GET /api/device/seccellinfo` | Live **`B1(20MHz) + B3(20MHz) + N78(100MHz)`** (**`140 MHz`** EN-DC 3CA); secondary carriers exposed via 8-column CSV (`EARFCN, Band, BW, PCI, RSRP, RSRQ, RSSI, SINR`) | ✅ Verified |
| **256QAM MCS & MIMO** | `GET /api/device/signal`<br/>`GET /api/device/ri` | Exposes 4G/5G UL & DL **`256QAM` / `64QAM`** codeword MCS indices, `TM[4]` spatial multiplexing, LTE `RI=2` / NR `nrrank` layers, and `CQI0/CQI1` | ✅ Verified |
| **PHY Transmit Power** | `GET /api/device/signal` | Separate 4G `<txpower>` and 5G `<nrtxpower>` reporting `PPusch`, `PPucch`, `PSrs`, and `PPrach` in dBm | ✅ Verified |
| **Tower & TAC Identity** | `GET /api/device/signal`<br/>`GET /api/net/cell-info` | Decimal `<cell_id>` / `<tac>` proven mathematically identical to hex `<cellinfo>` / `<lac>`; 28-bit ECI (`eNodeB = ECI >>> 8`) & 36-bit NCI bitwise decomposition | ✅ Verified |
| **4G / 5G Neighbor Scan** | `GET /api/device/nbrcellinfo` | Native `<nbrcell_ltelist>` & `<nbrcell_nrlist>` 7-column CSV (`EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR`) directly mappable to cell-lock payloads | ✅ Verified |
| **Band & Cell Locking** | `GET/POST /api/net/net-mode`<br/>`POST /api/net/lock-freq` | Hardware exposes `select_band_switch=1` & `lock_freq_switch=3`; supports 4G `LTEBand` hex masks, 5G NR band lock (`lock_mode=3`), freq lock (`1`), and `PCI+ARFCN` cell lock (`2`) | ✅ Verified |
| **Today vs Monthly Traffic** | `GET /api/monitoring/month_statistics`<br/>`GET /api/monitoring/traffic-statistics` | Native **Today's cumulative bytes (`<CurrentDayUsed>`)**, **Monthly UL+DL bytes**, billing rollover `<StartDay>`, and live byte/bit rates (`CurrentDownloadRate * 8`) | ✅ Verified |
| **Terminal Topology & Leases** | `GET /api/system/HostInfo` (JSON)<br/>`GET /api/system/topology` (JSON) | Classifies **`LAN 1000M`** Gigabit Ethernet vs `2.4GHz` / `5GHz` Wi-Fi clients with PHY rate (Mbps), RSSI, dual-stack IPv4/IPv6, and remaining DHCP lease seconds | ✅ Verified |
| **Wi-Fi 7 (802.11be) MLO** | `GET/POST /api/wlan/wlandbho`<br/>`GET /api/wlan/multi-security-settings-ex` | Tri-radio `802.11be` (`b/g/n/ax/be` + `a/n/ac/ax/be`), **MLO (`MloEnable`)**, Dual-Band Handover (`DbhoEnable`), EasyMesh, and channel auto-optimization | ✅ Verified |
| **Antenna, Static DHCP & APN** | `/api/device/antenna_set_type`<br/>`/api/dhcp/static-addr-info`<br/>`/api/dialup/profiles` | Auto/Internal/External antenna mode & physical insertion telemetry, static MAC-IP reservations, `IPv4/IPv6` (`iptype=2`) dual-stack APN profiles, and scheduled reboot | ✅ Verified |

---

## 🏗️ Repository Architecture

```text
cpe-dash/
├── AGENTS.md                        # Mandatory architecture, session safety & 7 security/TDD invariants
├── .env.example                     # Pure native .env template (default WEB_PORT=18384)
├── docs/
│   └── PHASE1_PROTOCOL_SPEC.md      # Complete H168-383 API dictionary, reversed formulas & handoff spec
├── src/
│   ├── types.ts                     # Strict TypeScript domain interfaces
│   ├── config.ts                    # Zero-dep .env parser, SSRF origin validator & XFF trusted-proxy resolver
│   ├── crypto.ts                    # Unclamped big-endian Curve25519, Huawei SCRAM-SHA256, AES-256-GCM
│   ├── xml.ts                       # Linear O(N) ReDoS-safe & prototype-pollution-safe XML codec
│   ├── sanitize.ts                  # Automated RFC redaction engine for IMEI/IMSI/MAC/IP/TAC/CellID
│   ├── encrypted-file.ts            # StorageCipher (scrypt + HKDF-SHA256 + AES-256-GCM 0600)
│   ├── band-lock.ts                 # 4G/5G BandMask bitwise codec, ECI/NCI splitter & lock XML builders
│   ├── parsers.ts                   # Pure parsers for 3CA RF, MCS, TxPower, neighbors, traffic & topology
│   ├── cpe-client.ts                # Ephemeral session client, dual-layer avoidance & 108006 circuit breaker
│   └── index.ts                     # Public SDK exports
├── scripts/
│   ├── audit-secrets.ts             # Working-tree + full git-history Zero-Secret/Zero-PII & Pure-TS gate
│   ├── probe-har-endpoints.ts       # Probe #1: Streaming HAR deconstruction & sanitized endpoint extractor
│   ├── probe-locking-algo.ts        # Probe #2: Offline + live BandMask & cell-lock verification
│   ├── probe-rf-ca.ts               # Probe #3: 3CA aggregation, TAC, 256QAM MCS, MIMO & TxPower telemetry
│   ├── probe-neighbor-cells.ts      # Probe #4: 4G/5G neighbor cell scanner & dry-run lock XML preview
│   ├── probe-traffic.ts             # Probe #5: Live UL/DL throughput + Today vs Monthly traffic accounting
│   ├── probe-topology.ts            # Probe #6: Gigabit LAN / Wi-Fi classification, PHY rates & dual-stack leases
│   ├── probe-session-avoidance.ts   # Probe #7: ~26ms ephemeral benchmark & dual-layer browser avoidance
│   └── probe-extended-capabilities.ts # Probe #8: Wi-Fi 7 MLO, antenna mode, static DHCP & dual-stack APN
└── test/                            # Offline deterministic simulation tests (96.6% coverage)
```

---

## 🚀 Quick Start & Live Probe Suite

### 1. Prerequisites

- **Node.js `>= 22.6.0`** (uses native TypeScript type-stripping and built-in `fetch`)
- Local LAN connectivity to Huawei H168-383 (`192.168.8.1`)

```bash
git clone https://github.com/cky008/cpe-dash.git
cd cpe-dash
npm install

cp .env.example .env
chmod 600 .env
# Edit .env and set CPE_PASSWORD (never commit .env)
```

### 2. Run Non-Destructive Live Hardware Probes

All probes are strictly read-only, sanitize all sensitive identifiers in stdout, and release the router's single-admin slot immediately:

```bash
npm run probe:locking     # Verify BandMask math against live H168-383 14-band mask
npm run probe:rf          # Query 3CA chain, 256QAM MCS, MIMO rank, TxPower & hex/dec tower proof
npm run probe:neighbors   # Scan 4G/5G candidate neighbor cells (EARFCN, Band, PCI, RSRP, RSRQ, RSSI, SINR)
npm run probe:traffic     # Query live UL/DL bps rates, Today's bytes & Monthly UL+DL bytes
npm run probe:topology    # Classify LAN 1000M / 2.4G / 5G terminals, PHY speeds & dual-stack leases
npm run probe:session     # Benchmark ~26ms session release & verify dual-layer browser avoidance
npm run probe:extended    # Inspect Wi-Fi 7 MLO, antenna mode, static DHCP, dual-stack APN & SNTP
```

---

## ⚙️ `.env` Configuration Reference

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CPE_URL` | `http://192.168.8.1` | CPE LAN origin URL (strictly validated against private/LAN ranges to prevent SSRF) |
| `CPE_USERNAME` | `admin` | H168-383 administrator username |
| `CPE_PASSWORD` | *(Required)* | CPE admin password (`108006` wrong-password response immediately latches CircuitBreaker) |
| `DATA_ENCRYPTION_KEY` | *(Falls back to `CPE_PASSWORD`)* | Master secret for `data/*.json` encryption at rest (`scrypt` + `HKDF-SHA256`) |
| `API_TOKEN` | *(Falls back to `CPE_PASSWORD`)* | Web console & REST API bearer secret (verified via `crypto.timingSafeEqual`) |
| `TRUSTED_PROXIES` | `127.0.0.1,::1` | Trusted reverse-proxy peer IPs allowed to supply `X-Forwarded-For` |
| `WEB_PORT` | `18384` | Default Web & API port (isolated from NAS `8080` and sibling `18383`) |
| `POLL_INTERVAL_MS` | `5000` | Standard RF & traffic telemetry polling interval (ms) |
| `NEIGHBOR_SCAN_INTERVAL_MS` | `60000` | Low-frequency neighbor cell scan interval (ms) |
| `RESPECT_BROWSER_SESSION` | `true` | Yield peacefully whenever a human admin session is active on the router |

---

## 🛡️ Security Invariants & TDD Quality Gates

Every commit is gated by `npm run check`:

```bash
npm run check
# Runs in sequence:
# 1. npm run typecheck      -> tsc -p tsconfig.test.json (100% Strict TS, zero implicit any)
# 2. npm run test:coverage  -> c8 >= 90% threshold (currently 96.6% Stmts / 98.21% Funcs / 96.6% Lines)
# 3. npm run audit:secrets  -> Scans working tree & full git log -p --all for secrets, PII & .js files
```

See [`AGENTS.md`](AGENTS.md) for the complete engineering constitution.

---

## 📚 Phase 1 Protocol Specification

For the complete verified API dictionary, RFC-sanitized XML/JSON payloads, `BandMask` bit-offset table, `/api/net/lock-freq` modes, and session error-code matrix, see:
👉 **[`docs/PHASE1_PROTOCOL_SPEC.md`](docs/PHASE1_PROTOCOL_SPEC.md)**

---

## ⚠️ Disclaimer & License

- This project is an independent, unofficial management platform and is not affiliated with or endorsed by Huawei Technologies Co., Ltd. Band and cell locking modify cellular modem radio behavior — use responsibly in accordance with your carrier's network policies.
- Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)** for personal and non-commercial research use only.
