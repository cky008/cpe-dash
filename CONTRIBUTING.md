# Contributing / 参与贡献

Thanks for helping. FengSui runs next to a router a household depends on, so changes are held to a high bar:
every change comes with tests, and nothing real (passwords, phone numbers, captures) ever enters the repository.

感谢参与。烽燧管理的路由器往往是一家人的上网出口，所以改动的门槛比较高：每个改动都要有测试，任何真实信息（密码、手机号、抓包）都不能进入仓库。

## Before you start / 开始之前

- **Bug or idea:** open an issue first for anything bigger than a small fix, so we can agree on the approach.
- **Another router model or brand:** file a device report (Issues → New issue → Device compatibility report). It helps more than a pull request at first; how a report is registered is under [Registering a device report](#registering-a-device-report--登记设备报告).
- **Security problem:** do not open an issue. Follow [SECURITY.md](SECURITY.md).
- **Conduct:** everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

- **缺陷或想法**：比小修复大的改动，请先开 Issue 商量做法。
- **其他型号与品牌**：先提交设备兼容性报告（Issues → New issue → 设备兼容性报告），这比直接提 PR 更有帮助。
- **安全问题**：不要开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。
- **行为准则**：所有参与者都遵守[行为准则](CODE_OF_CONDUCT.md)。

## Set up / 开发环境

You need Node.js 22.6 or later. You do not need a router: the demo runs the real daemon against a mock router in the same process.

需要 Node.js 22.6 或更高版本。不需要路由器：演示环境在同一个进程里用 Mock 路由器运行真实的守护进程。

```bash
npm ci
npm run demo        # console at http://127.0.0.1:18484, no .env, no network
npm run check       # the gate, below
npm run test:ui     # browser tests (headless Chrome), for console changes
npm run build:docs  # the documentation site, into dist/site
```

`npm run check` runs, and stops at the first failure:

1. `npm run typecheck` → strict TypeScript for the daemon, scripts, tests and the console
2. `npm run build:web` → builds the console; more than 160 KiB gzip fails, as in CI, releases and the Docker build
3. `npm run test:coverage` → every test offline, with statements, lines and functions at 90 % or more; a failure the
   test runner leaves out of its report still fails the gate, and the count must stay at or above the floor in
   `scripts/test-count-reporter.ts` (raise it when you add tests)
4. `npm run audit:secrets` → scans the working tree and the whole git history for secrets, device identifiers, phone numbers and `.js` files

## Rules / 规则

1. **Tests first.** Write a test that fails, then the change that makes it pass. Tests use `node:test` and the mock
   routers in `test/helpers/`; they never talk to a real router. Coverage stays at 90 % or more.
2. **Strict TypeScript only.** No `.js` files, no `any`, no `@ts-ignore`.
3. **No runtime dependencies.** The daemon uses Node.js built-ins only. Build and test tools go in `devDependencies`.
4. **One router session at a time.** Everything that talks to the router goes through `MutexSessionScheduler`; never
   create another `HuaweiCpeClient` or log in on your own.
5. **Placeholders only.** Use the RFC documentation addresses, the placeholder IMEI / IMSI / phone numbers and the
   synthetic cell listed in [`AGENTS.md`](AGENTS.md). Never commit `.env`, `data/`, HAR or pcap files, or values copied
   from your own router (that includes PCI and frequency numbers: they can locate a cell site).
6. **`npm run check` must pass** before you open a pull request; it also runs the secret scan over the full history.

1. **先写测试**：先写一个失败的测试，再写让它通过的改动。测试使用 `node:test` 和 `test/helpers/` 里的 Mock 路由器，绝不连接真实路由器。覆盖率保持 90% 以上。
2. **只用严格 TypeScript**：不要 `.js` 文件，不要 `any`，不要 `@ts-ignore`。
3. **零运行时依赖**：守护进程只用 Node.js 内置模块，构建和测试工具放进 `devDependencies`。
4. **同一时刻只有一个路由器会话**：所有访问路由器的代码都经过 `MutexSessionScheduler`，不要另建 `HuaweiCpeClient` 或自行登录。
5. **只用占位值**：使用 [`AGENTS.md`](AGENTS.md) 列出的 RFC 文档地址、占位 IMEI / IMSI / 手机号和合成小区。绝不提交 `.env`、`data/`、HAR 或 pcap 文件，也不要提交从自己路由器复制的数值（包括 PCI 和频点：它们能定位到具体基站）。
6. **提 PR 之前 `npm run check` 必须通过**，它也会扫描完整的 Git 历史。

## Registering a device report / 登记设备报告

When an issue's device report shows a feature working on a real router, record it so that its cell under
[Supported devices](docs/guide/en/supported-devices.md) turns into ✓.

1. **What counts.** Use the report's `checks`. A read counts when its `result` is `works` (the router answered its
   section with data). A write counts when its `result` is `works`: the latest write of that feature in the report's
   write record (`writes`) read back as written (`readback: "match"`). `failed` and `untested` do not count, and
   neither does a sentence in the issue without a report behind it.
2. **What to change.**
   - Add one entry per feature to `VERIFIED_FEATURES` in [`src/firmware.ts`](src/firmware.ts): `family` from the
     report's `access.family`, `model` and `softwareVersion` from `identity`, `feature` and `access` from the line in
     `checks`, and the issue number. A write must be one FengSui implements for that brand
     (`ROUTER_FAMILY_FACTS[family].writes`); `test/verified-features.test.ts` checks it.
   - Add a test that names the entry: the model's cell in `supportedDevicesSection` is ✓, and
     `DeviceAccess.writeState` answers `verified` for a write.
   - Add a line to `CHANGELOG.md` under `[Unreleased]` with the issue number (`#41`), and no name.
   - Regenerate the tables between `<!-- devices:begin -->` and `<!-- devices:end -->` in
     `docs/guide/{zh,en}/supported-devices.md` from `supportedDevicesSection` (`test/device-catalog.test.ts` fails until
     they match). A model the catalog does not have gets its row from the entry; add it to `DEVICE_CATALOG` in
     [`src/device-catalog.ts`](src/device-catalog.ts) with its form and section if you know them.
   - A report that shows a feature not working on a model goes into `UNSUPPORTED_FEATURES` the same way, and its cell
     turns into —.
3. **When it shows.** The table on the documentation site follows the push to `main`. The console shows the feature as
   verified (and drops "never checked on a real router" from its confirmation) from the next release.

当 issue 里的设备报告显示某项功能在真机上可用时，把它登记进代码，[支持的设备](docs/guide/zh/supported-devices.md)里那一格就会变成 ✓。

1. **什么样的报告算数**：看报告里的 `checks`。读取项的 `result` 是 `works`（路由器回答了这个读取项，并且有数据）才算；写入项的 `result` 是 `works` 才算，也就是写入记录（`writes`）里这个功能最近一次写入回读一致（`readback: "match"`）。`failed`、`untested` 不算；issue 里只有文字、没有报告支撑的也不算。
2. **登记要改哪里**：
   - 在 [`src/firmware.ts`](src/firmware.ts) 的 `VERIFIED_FEATURES` 里每个功能加一条：`family` 取报告的 `access.family`，`model` 和 `softwareVersion` 取 `identity`，`feature` 和 `access` 取 `checks` 里那一行，再写上 issue 编号。写入项必须是烽燧在这个品牌上实现了的（`ROUTER_FAMILY_FACTS[family].writes`），`test/verified-features.test.ts` 会检查。
   - 补一个测试点名这一条：这个型号在 `supportedDevicesSection` 里那一格是 ✓；写入项的 `DeviceAccess.writeState` 返回 `verified`。
   - 在 `CHANGELOG.md` 的 `[Unreleased]` 下加一行，写上 issue 编号（如 `#41`），不写人名。
   - 用 `supportedDevicesSection` 重新生成 `docs/guide/{zh,en}/supported-devices.md` 里 `<!-- devices:begin -->` 与 `<!-- devices:end -->` 之间的表（不一致时 `test/device-catalog.test.ts` 会失败）。清单里没有的型号会按这条登记自动多出一行；知道它的形态和品牌的话，也把它加进 [`src/device-catalog.ts`](src/device-catalog.ts) 的 `DEVICE_CATALOG`。
   - 报告显示某项功能在某个型号上不能用的，照同样的方式登记进 `UNSUPPORTED_FEATURES`，那一格变成 —。
3. **什么时候生效**：文档站上的表在推到 `main` 后随文档站更新；控制台里显示「已验证」（确认框也不再提示「没有在真机上验证过」）要等下一个版本。

## Commits and pull requests / 提交与 PR

- Commit messages follow Conventional Commits: `fix(sms): keep the draft when sending fails`.
  Types: `feat`, `fix`, `refactor`, `security`, `test`, `docs`, `chore`, `ci`.
- Keep a pull request to one change. Update `CHANGELOG.md` under `[Unreleased]`, and the user guide in both languages
  (`docs/guide/en`, `docs/guide/zh`) when behaviour changes.
- Signed commits are welcome
  ([how to sign commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits))
  but not required: pull requests are squash-merged on GitHub.
- By contributing, you agree that your contribution is licensed under the project's license
  ([PolyForm Noncommercial 1.0.0](LICENSE)).

- 提交信息遵循 Conventional Commits，例如 `fix(sms): keep the draft when sending fails`。类型：`feat`、`fix`、`refactor`、`security`、`test`、`docs`、`chore`、`ci`。
- 一个 PR 只做一件事。在 `CHANGELOG.md` 的 `[Unreleased]` 下记录改动；行为有变化时同步更新中英文用户指南（`docs/guide/zh`、`docs/guide/en`）。
- 欢迎签名提交（[如何签名提交](https://docs.github.com/zh/authentication/managing-commit-signature-verification/signing-commits)），但不强制：PR 在 GitHub 上压缩合并。
- 提交贡献即表示你同意以本项目的许可证（[PolyForm Noncommercial 1.0.0](LICENSE)）授权你的贡献。
