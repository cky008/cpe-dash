/**
 * The documentation site's home page (scripts/build-docs.ts renders it): what FengSui is, in a few seconds,
 * in both languages. Words live here; the layout is the builder's.
 */
import { escapeHtml } from "./markdown.ts";

export type SiteLocale = "zh-CN" | "en";

export interface HomeContext {
  locale: SiteLocale;
  /** Relative path from this page to the site root (`""`, `"../"`). */
  root: string;
  /** Relative path from this page to the docs of its language (`docs/`, `../en/docs/`…). */
  docs: string;
  version: string;
  demoUrl: string;
  repoUrl: string;
  image: (name: string) => { src: string; width: number; height: number };
  icon: (id: string) => string;
}

export const INSTALL_COMMAND = "docker pull ghcr.io/cky008/cpe-dash:latest";

const TEXT = {
  "zh-CN": {
    metaTitle: "烽燧 FengSui · 华为 5G 路由器的自托管控制台",
    metaDescription: "烽燧是装在你自己 NAS 上的华为 5G CPE 网页控制台：实时信号与载波聚合、锁频锁站、短信收发、终端管理、Telegram 告警和 AI 智能体接口，数据只留在家里。",
    eyebrow: "开源 · 自托管 · 零运行时依赖",
    titleStrong: "看清信号，",
    // "|" marks where the line may break (each part stays whole)
    titleSoft: "管好家里的|5G 路由器",
    lead: "烽燧是装在你自己 NAS 上的网页控制台。实时信号与载波聚合、锁频锁站、短信收发、终端管理和 Telegram 通知，一个页面都能看到、都能操作。数据只留在你家里。",
    start: "快速开始",
    demo: "在线演示",
    verified: "只在华为 5G CPE Ultra 6（H168-383）上验证过，其他华为型号以只读方式工作。",
    copyLabel: "复制命令",
    showcaseTitle: "一眼看清你的网络",
    showcaseLead: "信号、载波、邻区、流量和设备都在同一块大屏上，每 5 秒刷新一次。",
    featuresTitle: "需要的都在这里",
    features: [
      ["i-signal", "信号与载波聚合", "RSRP、SINR、MCS、发射功率和每个载波的频段、带宽，一眼看清 4G 与 5G 现在用的是什么。"],
      ["i-lock", "锁频锁站，可以撤回", "锁定频段或某个小区之前先预览；如果锁完断了网，可以设置在几分钟后自动解锁。"],
      ["i-inbox", "短信中心", "收发短信、会话视图、验证码一键复制、通讯录导入，短信内容加密存在本地。"],
      ["i-network", "终端与上网管理", "谁连着你的网络、用的是 Wi-Fi 还是网线；暂停某台设备上网，或者给孩子设定上网时段。"],
      ["i-bell", "告警与 Telegram", "断网、信号变差、路由器重启、短信满了时提醒你；在 Telegram 里也能收短信、回短信。"],
      ["i-cpu", "交给 AI 助手", "内置 MCP 服务器，Claude 等智能体可以查信号、看历史；写操作默认关闭，需要你确认。"],
    ],
    safeTitle: "它不会添乱",
    safeLead: "路由器往往是一家人唯一的上网出口。烽燧的每个设计都先保证不给它添麻烦。",
    safe: [
      ["i-eye", "不和你抢路由器", "路由器同一时间只允许一个管理员登录。你在官方网页登录时，烽燧会自动让开，等你退出再继续。"],
      ["i-shield", "不会把路由器锁死", "密码连续输错 3 次会锁住路由器。烽燧第一次登录失败就停下，等你在控制台改正，绝不重试。"],
      ["i-key", "数据加密存在本地", "路由器密码、短信和设置都用你的密钥加密，存在你自己的硬盘上，不上传任何地方。"],
      ["i-layers", "没有第三方依赖", "运行时只用 Node.js 自带的模块，没有 npm 依赖，也就没有供应链投毒的入口。"],
    ],
    galleryTitle: "手机上也一样好用",
    gallery: [
      ["sms-suzhi.webp", "短信会话"],
      ["mobile.webp", "手机布局"],
      ["controls-chenxi.webp", "控制抽屉"],
    ],
    ctaTitle: "几分钟装好",
    ctaLead: "一台能运行 Docker 的 NAS 或电脑，和华为路由器在同一个局域网里就够了。",
    ctaButton: "阅读快速开始",
    install: "安装指南",
    faq: "常见问题",
  },
  en: {
    metaTitle: "FengSui · Self-hosted console for Huawei 5G routers",
    metaDescription: "FengSui is a web console for Huawei 5G CPEs that runs on your own NAS: live signal and carrier aggregation, band and cell locking, SMS, connected devices, Telegram alerts and an MCP server for AI agents. Your data stays at home.",
    eyebrow: "Open source · Self-hosted · No runtime dependencies",
    titleStrong: "See your signal.",
    titleSoft: "Run your 5G router.",
    lead: "FengSui is a web console you run on your own NAS. Live signal and carrier aggregation, band and cell locking, SMS, connected devices and Telegram alerts, all on one page. Your data never leaves home.",
    start: "Get started",
    demo: "Live demo",
    verified: "Verified on the Huawei 5G CPE Ultra 6 (H168-383) only. Other Huawei models work read-only.",
    copyLabel: "Copy command",
    showcaseTitle: "Your network at a glance",
    showcaseLead: "Signal, carriers, neighbouring cells, traffic and devices on one screen, refreshed every 5 seconds.",
    featuresTitle: "Everything you need",
    features: [
      ["i-signal", "Signal and carrier aggregation", "RSRP, SINR, MCS, transmit power and every carrier's band and bandwidth: see what 4G and 5G are using right now."],
      ["i-lock", "Band and cell locks you can undo", "Preview a band or cell lock before you apply it. If a lock cuts the internet, FengSui can undo it after a few minutes."],
      ["i-inbox", "SMS", "Send and receive messages in threads, copy one-time codes with a click, import contacts. Messages are stored encrypted."],
      ["i-network", "Devices and internet access", "See who is connected and how. Pause a device's internet access, or set a schedule for the kids."],
      ["i-bell", "Alerts and Telegram", "Get told when the WAN drops, the signal weakens, the router restarts or the SMS box fills up. Read and answer SMS in Telegram."],
      ["i-cpu", "Works with AI agents", "A built-in MCP server lets Claude and other agents read the signal and its history. Writes are off by default and need your confirmation."],
    ],
    safeTitle: "Built not to get in the way",
    safeLead: "The router is often a household's only internet connection. Every part of FengSui is designed to keep it that way.",
    safe: [
      ["i-eye", "Never fights you for the router", "The router allows one admin login at a time. When you sign in to its own page, FengSui steps aside until you sign out."],
      ["i-shield", "Never locks the router", "Three wrong passwords lock the router. FengSui stops after the first failed login and waits for you to fix it in the console."],
      ["i-key", "Encrypted, on your own disk", "The router password, SMS and settings are encrypted with your key and stored on your hardware. Nothing is uploaded."],
      ["i-layers", "No third-party code at runtime", "The daemon uses only what ships with Node.js. No npm dependencies means no supply-chain surprises."],
    ],
    galleryTitle: "Just as good on a phone",
    gallery: [
      ["sms-ziming-en.webp", "SMS threads"],
      ["mobile.webp", "Phone layout"],
      ["controls-chenxi.webp", "Controls drawer"],
    ],
    ctaTitle: "Up and running in minutes",
    ctaLead: "All you need is a NAS or computer that runs Docker, on the same network as your Huawei router.",
    ctaButton: "Read the quick start",
    install: "Installation guide",
    faq: "FAQ",
  },
} as const;

export function homeMeta(locale: SiteLocale): { title: string; description: string } {
  return { title: TEXT[locale].metaTitle, description: TEXT[locale].metaDescription };
}

function img(ctx: HomeContext, name: string, alt: string, extra = ""): string {
  const { src, width, height } = ctx.image(name);
  return `<img src="${escapeHtml(src)}" width="${width}" height="${height}" alt="${escapeHtml(alt)}"${extra}>`;
}

/** The `<main>` of the home page. */
export function renderHome(ctx: HomeContext): string {
  const t = TEXT[ctx.locale];
  const e = escapeHtml;
  const copyIcon = `<svg class="svg-icon copy-icon" aria-hidden="true"><use href="#i-copy"/></svg>`;
  const hero = `
<section class="mx-auto max-w-7xl px-4 sm:px-6 pt-12 sm:pt-20 pb-16 grid gap-12 lg:grid-cols-[1.05fr_1fr] items-center">
  <div>
    <button type="button" class="copy-chip" data-copy="${e(INSTALL_COMMAND)}" data-label="${e(t.copyLabel)}" aria-label="${e(t.copyLabel)}"><code>${e(INSTALL_COMMAND)}</code>${copyIcon}</button>
    <h1 class="hero-title mt-8 text-5xl sm:text-6xl lg:text-[4.25rem]"><span class="block">${e(t.titleStrong)}</span><span class="soft block">${t.titleSoft.split("|").map((part) => `<span class="inline-block">${e(part)}</span>`).join("")}</span></h1>
    <p class="lead mt-6 text-lg sm:text-xl max-w-xl">${e(t.lead)}</p>
    <div class="mt-8 flex flex-wrap gap-3">
      <a class="btn-primary" href="${e(ctx.docs)}quick-start/">${e(t.start)} <span aria-hidden="true">→</span></a>
      <a class="btn-secondary" href="${e(ctx.demoUrl)}" rel="noopener" target="_blank">${e(t.demo)}</a>
    </div>
    <p class="faint mt-6 text-sm max-w-xl">${e(t.verified)}</p>
  </div>
  <div class="stage hidden md:block" aria-hidden="true">
    <div class="tilt relative">
      <div class="shot">${img(ctx, "dashboard-sujian.webp", "", ' loading="eager" fetchpriority="high"')}</div>
      <div class="shot shot-phone absolute -bottom-10 -left-10 w-1/4">${img(ctx, "mobile.webp", "", ' loading="lazy"')}</div>
    </div>
  </div>
</section>`;

  const showcase = `
<section class="band py-20 sm:py-28">
  <div class="mx-auto max-w-6xl px-4 sm:px-6 text-center">
    <h2 class="section-title text-4xl sm:text-5xl">${e(t.showcaseTitle)}</h2>
    <p class="lead mt-4 text-lg max-w-2xl mx-auto">${e(t.showcaseLead)}</p>
    <div class="shot mt-12 text-left"><div class="window-bar" aria-hidden="true"><span></span><span></span><span></span></div>${img(ctx, "dashboard-jiye.webp", t.showcaseTitle, ' loading="lazy"')}</div>
  </div>
</section>`;

  const card = ([icon, title, body]: readonly [string, string, string]): string =>
    `<div class="feature"><span class="feature-icon">${ctx.icon(icon)}</span><h3 class="mt-5 text-lg font-semibold">${e(title)}</h3><p class="muted mt-2 leading-relaxed">${e(body)}</p></div>`;

  const features = `
<section class="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
  <h2 class="section-title text-4xl sm:text-5xl text-center">${e(t.featuresTitle)}</h2>
  <div class="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">${t.features.map(card).join("")}</div>
</section>`;

  const safe = `
<section class="band py-20 sm:py-28">
  <div class="mx-auto max-w-6xl px-4 sm:px-6">
    <div class="max-w-2xl">
      <h2 class="section-title text-4xl sm:text-5xl">${e(t.safeTitle)}</h2>
      <p class="lead mt-4 text-lg">${e(t.safeLead)}</p>
    </div>
    <div class="mt-12 grid gap-5 sm:grid-cols-2">${t.safe.map(card).join("")}</div>
  </div>
</section>`;

  const gallery = `
<section class="mx-auto max-w-6xl px-4 sm:px-6 py-20 sm:py-28">
  <h2 class="section-title text-4xl sm:text-5xl text-center">${e(t.galleryTitle)}</h2>
  <div class="mt-12 grid gap-6 md:grid-cols-3">${t.gallery.map(([name, alt]) => `<figure><div class="shot ${name === "mobile.webp" ? "shot-phone mx-auto w-3/5" : "shot-frame"}">${img(ctx, name, alt, ' loading="lazy"')}</div><figcaption class="faint text-sm text-center mt-3">${e(alt)}</figcaption></figure>`).join("")}</div>
</section>`;

  const cta = `
<section class="mx-auto max-w-4xl px-4 sm:px-6 pb-24 text-center">
  <h2 class="section-title text-4xl sm:text-5xl">${e(t.ctaTitle)}</h2>
  <p class="lead mt-4 text-lg">${e(t.ctaLead)}</p>
  <div class="mt-8 flex flex-wrap justify-center gap-3">
    <a class="btn-primary" href="${e(ctx.docs)}quick-start/">${e(t.ctaButton)} <span aria-hidden="true">→</span></a>
    <a class="btn-secondary" href="${e(ctx.docs)}install/">${e(t.install)}</a>
    <a class="btn-secondary" href="${e(ctx.docs)}faq/">${e(t.faq)}</a>
  </div>
</section>`;

  return hero + showcase + features + safe + gallery + cta;
}
