import { AGENT_TOKEN_DAYS, agentTokenName } from "../core/console-view.ts";
import { type MessageParams, interpolate } from "../core/i18n.ts";
import { claudeCodeCommand, maskToken, mcpEndpoint, mcpJsonConfig, tokenOrPlaceholder } from "../core/mcp-setup.ts";
import { MCP_GUIDE_TEXT, type McpGuideTextKey } from "../i18n/mcp-guide.ts";
import { copyText } from "./clipboard.ts";
import type { AppContext } from "./context.ts";
import { byId, h, icon, mount } from "./dom.ts";

interface Snippet {
  title: McpGuideTextKey;
  note?: McpGuideTextKey;
  /** The text to copy, built from the endpoint and the real token. */
  build(url: string, token: string): string;
}

/**
 * "Connect an AI agent": the daemon's `/mcp` endpoint with copy-ready setup for coding agents. A
 * pasted or freshly minted read-only token only fills the snippets (masked on screen, real in the
 * clipboard); the page never stores it.
 */
export function mountMcpGuide(ctx: AppContext): { open(): void } {
  const dialog = byId<HTMLDialogElement>("mcpDialog");
  const t = (key: McpGuideTextKey, params?: MessageParams): string => interpolate(MCP_GUIDE_TEXT[ctx.tr.locale][key], params);
  let token = "";

  const snippets: Snippet[] = [
    { title: "prompt_title", note: "prompt_note", build: (url, value) => t("prompt_body", { url, token: value }) },
    { title: "claude_title", build: claudeCodeCommand },
    { title: "json_title", build: mcpJsonConfig },
  ];

  const render = (): void => {
    const url = mcpEndpoint(window.location.origin, ctx.demo);
    const blocks = snippets.map((snippet) => {
      const code = h("pre", { class: "font-mono text-xs whitespace-pre-wrap break-all rounded-lg bg-base-200/70 p-3 pr-10" });
      const copy = h(
        "button",
        { class: "btn btn-ghost btn-xs btn-square absolute right-1.5 top-1.5", title: t("copy"), attrs: { type: "button", "aria-label": t("copy") } },
        icon("copy")
      );
      copy.addEventListener("click", () => {
        void copyText(dialog, snippet.build(url, tokenOrPlaceholder(token))).then((ok) =>
          ctx.toast(ctx.t(ok ? "toast.copied" : "toast.copy_failed"), ok ? "success" : "warning")
        );
      });
      const show = (): void => {
        code.textContent = snippet.build(url, maskToken(tokenOrPlaceholder(token)));
      };
      show();
      return {
        show,
        el: h(
          "section",
          { class: "space-y-1.5" },
          h("h4", { class: "fs-label" }, t(snippet.title)),
          snippet.note ? h("p", { class: "text-xs muted" }, t(snippet.note)) : null,
          h("div", { class: "relative" }, code, copy)
        ),
      };
    });

    const tokenInput = h("input", {
      class: "input input-sm rounded-lg w-full",
      attrs: { id: "mcpTokenInput", type: "password", autocomplete: "off", spellcheck: "false", placeholder: t("token_placeholder") },
    });
    tokenInput.value = token;
    tokenInput.addEventListener("input", () => {
      token = tokenInput.value;
      for (const block of blocks) block.show();
    });
    const mint = h("button", { class: "btn btn-sm rounded-lg shrink-0", attrs: { type: "button" } }, icon("key"), t("mint"));
    mint.addEventListener("click", () => {
      mint.disabled = true;
      void ctx.api
        .createToken({ name: agentTokenName(ctx.now(), t("agent_name")), scope: "read", lifetimeDays: AGENT_TOKEN_DAYS })
        .then((res) => {
          token = res.token;
          tokenInput.value = token;
          for (const block of blocks) block.show();
          ctx.toast(t("minted", { name: res.record.name, days: AGENT_TOKEN_DAYS }), "success");
        })
        .catch((err: unknown) => ctx.toast(ctx.describeError(err), "error"))
        .finally(() => (mint.disabled = false));
    });

    mount(
      dialog,
      h(
        "div",
        { class: "modal-box sm:max-w-2xl p-0 flex flex-col max-h-[90vh]" },
        h(
          "div",
          { class: "flex items-center gap-2 px-5 pt-5 pb-3" },
          icon("bot", "text-primary text-lg"),
          h("h3", { class: "text-lg font-bold serif" }, t("title")),
          h("form", { class: "ml-auto", attrs: { method: "dialog" } }, h("button", { class: "btn btn-ghost btn-sm btn-circle", attrs: { "aria-label": ctx.t("common.close") } }, icon("x", "text-base")))
        ),
        h(
          "div",
          { class: "flex-1 overflow-y-auto px-5 pb-5 space-y-4 text-sm" },
          h("p", { class: "muted" }, t("intro")),
          ctx.demo ? h("p", { class: "text-xs text-warning" }, t("demo_note")) : null,
          h("div", { class: "space-y-1" }, h("div", { class: "fs-label" }, t("endpoint")), h("code", { class: "font-mono text-xs break-all" }, url)),
          h(
            "div",
            { class: "space-y-1" },
            h("label", { class: "fs-label block", attrs: { for: "mcpTokenInput" } }, t("token_label")),
            h("div", { class: "flex flex-col sm:flex-row gap-2" }, tokenInput, mint),
            h("p", { class: "text-xs muted" }, t("token_hint"))
          ),
          ...blocks.map((block) => block.el),
          h("p", { class: "text-xs faint" }, t("notes"))
        )
      ),
      h("form", { class: "modal-backdrop", attrs: { method: "dialog" } }, h("button", null, "close"))
    );
  };

  dialog.addEventListener("close", () => {
    // Nothing of the token outlives the dialog
    token = "";
  });
  ctx.tr.onChange(() => {
    if (dialog.open) render();
  });
  return {
    open: () => {
      render();
      dialog.showModal();
    },
  };
}
