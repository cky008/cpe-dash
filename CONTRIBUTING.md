# Contributing / 参与贡献

Thanks for helping. FengSui runs next to a router a household depends on, so changes are held to a high bar:
every change comes with tests, and nothing real (passwords, phone numbers, captures) ever enters the repository.

感谢参与。烽燧管理的路由器往往是一家人的上网出口，所以改动的门槛比较高：每个改动都要有测试，任何真实信息（密码、手机号、抓包）都不能进入仓库。

## Before you start / 开始之前

- **Bug or idea:** open an issue first for anything bigger than a small fix, so we can agree on the approach.
- **Another Huawei model:** file a device report (Issues → New issue → Device compatibility report). It helps more than a pull request at first.
- **Security problem:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

- **缺陷或想法**：比小修复大的改动，请先开 Issue 商量做法。
- **其他华为型号**：先提交设备兼容性报告（Issues → New issue → 设备兼容性报告），这比直接提 PR 更有帮助。
- **安全问题**：不要开 Issue，请按 [SECURITY.md](SECURITY.md) 私下报告。

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
3. `npm run test:coverage` → every test offline, with statements, lines and functions at 90 % or more
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

## Commits and pull requests / 提交与 PR

- Commit messages follow Conventional Commits: `fix(sms): keep the draft when sending fails`.
  Types: `feat`, `fix`, `refactor`, `security`, `test`, `docs`, `chore`, `ci`.
- Keep a pull request to one change. Update `CHANGELOG.md` under `[Unreleased]`, and the user guide in both languages
  (`docs/guide/en`, `docs/guide/zh`) when behaviour changes.
- `main` accepts signed commits only
  ([how to sign commits](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-commits)).
  If yours are not signed, the maintainer squashes the pull request locally and signs the result.
- By contributing, you agree that your contribution is licensed under the project's license
  ([PolyForm Noncommercial 1.0.0](LICENSE)).

- 提交信息遵循 Conventional Commits，例如 `fix(sms): keep the draft when sending fails`。类型：`feat`、`fix`、`refactor`、`security`、`test`、`docs`、`chore`、`ci`。
- 一个 PR 只做一件事。在 `CHANGELOG.md` 的 `[Unreleased]` 下记录改动；行为有变化时同步更新中英文用户指南（`docs/guide/zh`、`docs/guide/en`）。
- `main` 分支只接受签名的提交（[如何签名提交](https://docs.github.com/zh/authentication/managing-commit-signature-verification/signing-commits)）。没有签名的 PR 由维护者在本地压缩合并、签名后推送。
- 提交贡献即表示你同意以本项目的许可证（[PolyForm Noncommercial 1.0.0](LICENSE)）授权你的贡献。
