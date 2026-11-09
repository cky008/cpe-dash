<p align="center">
  <img src="web/brand/logo.svg" width="72" height="72" alt="" />
</p>

<h1 align="center">烽燧 FengSui</h1>

<p align="center">
  华为 5G 路由器的自托管控制台：看清信号，管好路由器，短信和告警一处收。
</p>

<p align="center">
  <a href="https://github.com/cky008/cpe-dash/releases"><img src="https://img.shields.io/github/v/release/cky008/cpe-dash?style=flat-square&label=%E7%89%88%E6%9C%AC" alt="最新版本" /></a>
  <a href="https://github.com/cky008/cpe-dash/actions/workflows/ci-docker.yml"><img src="https://github.com/cky008/cpe-dash/actions/workflows/ci-docker.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/Docker-amd64_|_arm64-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker amd64 和 arm64" />
  <img src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-black?style=flat-square" alt="零运行时依赖" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF-PolyForm_NC_1.0.0-orange?style=flat-square" alt="PolyForm Noncommercial 1.0.0" /></a>
</p>

<p align="center">
  <a href="docs/guide/zh/quick-start.md"><b>快速开始</b></a> ·
  <a href="https://fengsui.iocky.com/">文档站</a> ·
  <a href="https://cky008.github.io/fengsui-demo/">在线演示</a> ·
  <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img src="docs/screenshots/dashboard-sujian.webp" alt="烽燧的控制台" width="100%" />
</p>

烽燧是一个装在你自己 NAS 或电脑上的网页控制台，用来查看和管理华为 5G 路由器。它把官方网页里分散的信息集中到一个页面上，再补上官方网页没有的东西：历史曲线、告警、Telegram 通知、短信会话，以及给 AI 智能体用的接口。数据只留在你家里。

## 它能做什么

- **看清信号**：RSRP、SINR、调制方式、发射功率，以及 4G / 5G 每个载波的频段和带宽，每 5 秒刷新，保留 7 天历史。
- **锁频锁站，可以撤回**：锁定频段或某个小区前先预览；锁完断了网，可以设置几分钟后自动解锁。
- **短信中心**：会话视图、验证码一键复制、通讯录导入，短信加密保存在本地。
- **设备与上网管理**：谁连着你的网络、怎么连的；暂停某台设备上网，或给它设定上网时段。
- **告警与 Telegram**：断网、信号变差、路由器重启、短信存满时提醒你；在 Telegram 里也能收发短信。
- **交给 AI 助手**：内置 MCP 服务器，Claude、Cursor 等可以查信号、看历史；会改动路由器的操作默认关闭，每个令牌能做什么由你勾选。

它也被设计成不添乱：你登录路由器官方网页时它会让开；密码错一次就停下，不会把路由器锁死；运行时只用 Node.js 自带模块，没有第三方依赖。

## 快速开始

需要一台能运行 Docker 的 NAS 或电脑，和路由器在同一个局域网里。

```bash
mkdir -p ~/cpe-dash/data && cd ~/cpe-dash
curl -fsSLO https://raw.githubusercontent.com/cky008/cpe-dash/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/cky008/cpe-dash/main/.env.example
# 编辑 .env：填 DATA_ENCRYPTION_KEY（用 openssl rand -hex 32 生成）和 TZ
docker compose pull && docker compose up -d
docker compose logs cpe-dash | grep "setup code"
```

打开 `http://<这台机器的 IP>:18384`，输入日志里的设置码，按引导连上路由器。完整步骤（包括群晖图形界面）见[快速开始](docs/guide/zh/quick-start.md)。

> [!CAUTION]
> 不要把 `18384` 端口直接映射到公网。要在外面访问，请用 Tailscale 等 VPN 或 HTTPS 反向代理，见[安全与隐私](docs/guide/zh/security.md)。

## 截图

| 短信中心 | 控制抽屉 |
| :---: | :---: |
| <img src="docs/screenshots/sms-suzhi.webp" alt="短信中心" /> | <img src="docs/screenshots/controls-chenxi.webp" alt="控制抽屉：锁频、自愈与开关" /> |
| **设备与上网管理** | **手机布局** |
| <img src="docs/screenshots/topology-access.webp" alt="已连接设备与访问控制" /> | <img src="docs/screenshots/mobile.webp" alt="手机上的控制台" width="60%" /> |

更多界面可以直接在[在线演示](https://cky008.github.io/fengsui-demo/)里点：数据全是虚构的，刷新即复原。

## 兼容性

烽燧只在 H168-383（固件 4.4.0.1）上验证过。其他华为 HiLink 路由器通常也能连上，但以只读方式工作，写操作默认锁定；你可以在控制台里逐项打开实验性写入，风险自负。欢迎用控制台生成设备报告并提交，帮助验证更多型号；也可以把控制台里现成的提示词交给 AI 智能体，让它帮你测试并起草报告。详见[其他华为型号](docs/guide/zh/other-routers.md)。

## 文档

- **开始使用**：[烽燧是什么](docs/guide/zh/overview.md) · [快速开始](docs/guide/zh/quick-start.md) · [安装与升级](docs/guide/zh/install.md)
- **使用烽燧**：[控制台](docs/guide/zh/dashboard.md) · [锁频与锁小区](docs/guide/zh/locking.md) · [短信](docs/guide/zh/sms.md) · [设备与上网管理](docs/guide/zh/devices.md) · [告警与通知](docs/guide/zh/notifications.md) · [AI 智能体（MCP）](docs/guide/zh/agents.md)
- **管理**：[Docker Compose 配置](docs/guide/zh/docker-compose.md) · [配置参考](docs/guide/zh/configuration.md) · [安全与隐私](docs/guide/zh/security.md) · [备份与恢复](docs/guide/zh/backup.md) · [其他华为型号](docs/guide/zh/other-routers.md)
- **帮助**：[排障](docs/guide/zh/troubleshooting.md) · [常见问题](docs/guide/zh/faq.md)
- **技术文档**：[协议规范](docs/PHASE1_PROTOCOL_SPEC.md) · [架构报告](docs/PHASE2_ARCHITECTURE_REPORT.md) · [后端契约（REST / SSE / MCP）](docs/PHASE2_BACKEND_CONTRACT.md) · [更新日志](CHANGELOG.md)

这些页面也发布在[文档站](https://fengsui.iocky.com/)上，支持搜索。

## 参与

- 问题和建议：[GitHub Issues](https://github.com/cky008/cpe-dash/issues)
- 参与开发：[CONTRIBUTING.md](CONTRIBUTING.md)（不需要路由器：`npm run demo` 在本机模拟一台）
- 安全问题：按 [SECURITY.md](SECURITY.md) 私下报告
- 行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 赞助：[GitHub Sponsors](https://github.com/sponsors/cky008) · [Buy Me a Coffee](https://buymeacoffee.com/iocky)

## 许可与声明

- **许可**：[PolyForm Noncommercial 1.0.0](LICENSE)。个人、学习、研究等非商业用途可以免费使用和修改；商业使用需要另外取得作者授权。构建产物包含的第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- **非官方项目**：烽燧是独立的开源项目，与华为、群晖及任何运营商均无关联，也未获其认可。所有商标归各自所有者。
- **按现状提供**：不附带任何担保。锁频、锁小区、重启、断网等操作可能让你暂时无法上网；短信按运营商资费计费，内容由你负责。只在你有权管理的设备和网络上使用，并遵守当地法规和运营商条款。

## 致谢

感谢 [Salamek/huawei-lte-api](https://github.com/Salamek/huawei-lte-api)：烽燧为其他华为型号做兼容时，参考了它整理的接口与机型资料。烽燧不包含它的代码，也不依赖它。

---

**本项目开放源码（PolyForm Noncommercial 1.0.0），仅供个人与非商业免费使用，严禁任何形式的商业售卖、付费代部署及商业捆绑。**
