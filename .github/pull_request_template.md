## What and why / 改了什么、为什么

<!-- One change per pull request. Link the issue it fixes. / 一个 PR 只做一件事，附上对应的 Issue。 -->

## How it was tested / 怎么测试的

<!-- The test that failed before this change, and anything you checked by hand (npm run demo). / 改动前失败的测试，以及手动检查过的内容（npm run demo）。 -->

## Checklist / 自查

- [ ] `npm run check` passes (and `npm run test:ui` for console changes) / `npm run check` 通过（改了控制台还要跑 `npm run test:ui`）
- [ ] Tests cover the change; nothing talks to a real router / 有测试覆盖改动，且不连接真实路由器
- [ ] No real identifiers anywhere: passwords, tokens, IMEI / IMSI / phone numbers, SMS text, MAC or public IP addresses, PCI or frequency values from a real router, captures / 任何地方都没有真实标识：密码、令牌、IMEI / IMSI / 手机号、短信内容、MAC 或公网 IP、真机的 PCI 或频点、抓包
- [ ] `CHANGELOG.md` (`[Unreleased]`) and both READMEs updated if behaviour changed / 行为有变化时已更新 `CHANGELOG.md`（`[Unreleased]`）和中英文 README
