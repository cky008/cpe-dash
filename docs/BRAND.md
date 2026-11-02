# 烽燧 · 品牌标志（Logo）

当前标志：**月白 · 回声**。一道高弧加一道低弧，表示接收与回应。

## 唯一来源

标志只有一个源文件：[`web/brand/logo.svg`](../web/brand/logo.svg)。构建（`npm run build:web`，包括 Docker 镜像和在线演示）从它派生出：

| 用在哪里 | 怎么来的 | 颜色 |
|---|---|---|
| 控制台页头、登录页（`#i-mark`） | `scripts/build-web.ts` 把它转成 `<symbol>`，填进 `web/index.html` 里的 `{{BRAND_MARK}}` | 跟随主题（见下） |
| 浏览器标签页图标（`favicon.svg`） | 原样输出源文件 | 源文件 `<style>` 里写的浅色 / 深色，跟随系统 |

`scripts/brand.ts` 负责检查源文件和生成 `<symbol>`；`test/brand.test.ts` 保证页面、样式和图标都来自同一份路径数据。

### 源文件约定

- `viewBox="0 0 100 100"`，标志居中，四周留约 2 个单位。
- 只能有 `<svg>`、`<title>`、`<style>`、`<path>`。不能有脚本、事件属性、链接或嵌入图片。
- 每个 `<path>` 必须带 `class="main"`（主弧）或 `class="echo"`（回声弧），至少一个 `main`。路径数据只能是命令和数字。
- `<style>` 写 `.main` / `.echo` 的浅色，以及 `@media (prefers-color-scheme: dark)` 里的深色。这两组颜色只用于网站图标。

## 颜色如何跟随主题

页头和登录页的标志不用源文件里的颜色，而是由当前主题算出来（`web/styles.css` 的 `.fs-mark`）：

- 主弧 `--mark-main` = 主题 `primary` 与正文墨色 `base-content` 按 `--mark-strength` 混合（oklab）：保留主题色相，压低饱和度。
- 回声弧 `--mark-echo` = 主弧与页面底色 `base-100` 按 `--mark-echo-share` 混合：同一色相，更靠近背景。
- 两个比例写在主题的 scheme 层（`[data-scheme="light"]` / `[data-scheme="dark"]`）。目前浅色是 58% / 58%，深色是 55% / 74%，是按概念稿的浅色 / 深色两版校准的。所有内置主题和自定义强调色都会自动跟随。
- 深色主题下有一点辉光（`--glow-strength`），浅色主题没有。

## 换标志

### 从 SVG 换

1. 按上面的约定改写 `web/brand/logo.svg`：路径归一到 `0 0 100 100`，标好 `main` / `echo`，写好浅色和深色。
2. `npm run build:web`，然后 `npm run demo` 看页头和登录页，至少看一个浅色和一个深色主题，再看看手机宽度。
3. `npm run check`，然后 `npm run screenshots` 重拍 README 截图。

### 从概念图换（PNG）

概念图要求：实心色块放在纯色背景上；可以是左浅右深的对比图（像 `05-moon-echo.png` 那样）。

```bash
npm run brand:trace -- path/to/concept.png     # 生成 web/brand/logo.svg
```

- 会自动识别左右对比图：用左半边取形状和浅色，用右半边取深色。
- 用亚像素描边加 Bézier 拟合，默认误差不超过 0.6 源像素，可以用 `--tolerance` 调整；`--out` 可以改输出路径。
- 对比度最高的形状为 `main`，较浅的为 `echo`。
- 生成后照上面第 2、3 步检查。如果形状数量或角色不对，直接编辑生成的 SVG。

### 如果新标志的配色风格不同

- 只改 `--mark-strength` / `--mark-echo-share` 两个比例，就能整体调深浅。
- 如果新标志不是「主弧 + 回声弧」结构，在 `scripts/brand.ts` 里增加角色（例如 `accent`），同时在 `.fs-mark` 加对应的颜色变量，并更新测试。

## 另见

- 概念稿与生成提示词不入库（AI 生成的位图，约 1 MB）。仓库里以 `web/brand/logo.svg` 为准。
