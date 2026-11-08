# Security policy / 安全策略

FengSui controls a home router that is often the household's only internet connection, and it keeps router credentials,
SMS and verification codes. Please report security problems privately so they can be fixed before anyone else knows about them.

烽燧控制的路由器往往是一家人唯一的上网出口，它还保存着路由器凭据、短信和验证码。发现安全问题请私下报告，修好之前不要公开。

## Report a vulnerability / 报告漏洞

- Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**.
  Do not open a public issue, pull request or discussion for a security problem.
- Describe what an attacker needs (network position, credentials), what they gain, and the steps to reproduce.
  A failing test or a short script against the mock router (`npm run demo`) is the most useful proof.
- Leave out real identifiers: no router passwords, tokens, IMEI / IMSI / phone numbers, SMS text, captures (HAR, pcap)
  or public IP addresses. Use the placeholders listed in [`AGENTS.md`](AGENTS.md).

---

- 请用 GitHub 的私密报告：打开仓库的 **Security** 标签页，选择 **Report a vulnerability**。安全问题不要发公开的 Issue、PR 或讨论。
- 写清楚攻击者需要什么条件（网络位置、凭据）、能得到什么，以及复现步骤。最有用的证明是一个失败的测试，或者对着 Mock 路由器（`npm run demo`）运行的小脚本。
- 不要带真实标识：路由器密码、令牌、IMEI / IMSI / 手机号、短信内容、抓包（HAR、pcap）和公网 IP 都不要附上。用 [`AGENTS.md`](AGENTS.md) 里列出的占位值。

## What to expect / 处理流程

FengSui has one maintainer. You should get a first reply within 7 days. Confirmed problems are fixed in a new release,
and the advisory is published once the release is out, crediting you unless you ask otherwise.

烽燧目前只有一位维护者。一般 7 天内会首次回复。确认的问题会在新版本中修复，版本发布后公开安全公告，并致谢报告者（除非你不希望署名）。

## Supported versions / 受支持的版本

Only the latest release receives security fixes. Update before reporting if you can.

只有最新发布的版本会收到安全修复。报告前请尽量先升级。

## Scope / 范围

In scope:

- The daemon: web console, REST API, `/api/events`, the MCP server and the `cpe-dash mcp` bridge.
- Authentication, sessions, tokens, rate limits, the Host allowlist and the reverse-proxy handling.
- The encrypted data files, `backup` / `restore` / `rekey`, and anything that could leak secrets or SMS into logs,
  API answers, Telegram or webhooks.
- How FengSui talks to the router: anything that could lock the router's admin account, force a write the user did not ask for,
  or bypass the write gate for unverified models.
- The container image and the GitHub Actions workflows.

Out of scope:

- Bugs in the router's own firmware or web page. Report those to Huawei PSIRT.
- Attacks that need the console password, a full-access token or `DATA_ENCRYPTION_KEY` already.
- Flooding the local network, or a console deliberately exposed to the internet without TLS (the docs ask for a VPN or
  an HTTPS reverse proxy).

范围内：守护进程（Web 控制台、REST API、`/api/events`、MCP 服务与 `cpe-dash mcp` 桥接）；鉴权、会话、令牌、限流、Host 白名单与反向代理处理；加密数据文件与 `backup` / `restore` / `rekey`，以及任何可能把密钥或短信泄露到日志、API 应答、Telegram、Webhook 的问题；烽燧与路由器的交互（任何可能锁死路由器管理员账户、在用户没有要求时写入路由器、或绕过未验证型号写闸门的问题）；容器镜像与 GitHub Actions 工作流。

范围外：路由器固件或路由器自带网页的缺陷（请报告给华为 PSIRT）；需要先拿到控制台密码、完整权限令牌或 `DATA_ENCRYPTION_KEY` 的攻击；在局域网里制造流量洪泛；未经 TLS 直接暴露到公网的控制台（文档要求使用 VPN 或 HTTPS 反向代理）。

## Testing rules / 测试规则

- Test only on equipment you own. Never test against someone else's router, console, Telegram bot or phone number.
- Use the mock router (`npm run demo`) for anything that writes. A wrong password three times in a row locks the router's
  admin account, and a band or cell lock can cut off the internet.
- Never send test SMS to numbers you do not own.

- 只在自己的设备上测试。绝不对别人的路由器、控制台、Telegram 机器人或手机号做测试。
- 涉及写操作的测试请用 Mock 路由器（`npm run demo`）。连续输错 3 次密码会锁死路由器管理员账户，锁频锁站可能让家里断网。
- 绝不向不属于你的号码发送测试短信。
