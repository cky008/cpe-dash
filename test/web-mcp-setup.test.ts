import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEMO_ORIGIN,
  TOKEN_PLACEHOLDER,
  claudeCodeCommand,
  maskToken,
  mcpEndpoint,
  mcpJsonConfig,
  tokenOrPlaceholder,
} from "../web/src/core/mcp-setup.ts";
import { MCP_GUIDE_TEXT } from "../web/src/i18n/mcp-guide.ts";

describe("web core: MCP setup guide", () => {
  it("points at the console's own origin, or the documentation domain in the demo", () => {
    assert.equal(mcpEndpoint("https://cpe.example.com", false), "https://cpe.example.com/mcp");
    assert.equal(mcpEndpoint("http://192.168.8.10:18384/", false), "http://192.168.8.10:18384/mcp");
    assert.equal(mcpEndpoint("https://demo.example.org", true), `${DEMO_ORIGIN}/mcp`);
  });

  it("uses the read-only placeholder until a token is pasted and masks a real one for display", () => {
    assert.equal(tokenOrPlaceholder("   "), TOKEN_PLACEHOLDER);
    assert.equal(tokenOrPlaceholder(" readonly-token-1234 "), "readonly-token-1234");
    assert.equal(maskToken(TOKEN_PLACEHOLDER), TOKEN_PLACEHOLDER);
    assert.equal(maskToken("readonly-token-1234"), "••••••••1234");
    assert.equal(maskToken("short"), "••••••••", "a short token shows nothing of itself");
  });

  it("builds a Claude Code command that a token cannot break out of", () => {
    assert.equal(
      claudeCodeCommand("https://cpe.example.com/mcp", "readonly-token-1234"),
      "claude mcp add --transport http fengsui 'https://cpe.example.com/mcp' --header 'Authorization: Bearer readonly-token-1234'"
    );
    const hostile = claudeCodeCommand("https://cpe.example.com/mcp", "a'$(touch /tmp/x)'b");
    assert.equal(hostile.endsWith("--header 'Authorization: Bearer a'\\''$(touch /tmp/x)'\\''b'"), true, hostile);
  });

  it("builds the remote mcpServers entry as valid JSON", () => {
    const parsed = JSON.parse(mcpJsonConfig("https://cpe.example.com/mcp", 'quote"token')) as {
      mcpServers: { fengsui: { type: string; url: string; headers: Record<string, string> } };
    };
    assert.deepEqual(parsed.mcpServers.fengsui, {
      type: "http",
      url: "https://cpe.example.com/mcp",
      headers: { Authorization: 'Bearer quote"token' },
    });
  });

  it("ships the guide's own strings in both languages with the same placeholders and no markup", () => {
    const zh = MCP_GUIDE_TEXT["zh-CN"];
    const en = MCP_GUIDE_TEXT.en;
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      assert.ok(zh[key].trim() && en[key].trim(), key);
      assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), key);
      assert.doesNotMatch(zh[key] + en[key], /<\/?[a-z][a-z0-9]*[\s>]/i, key);
    }
    assert.deepEqual(placeholders(zh.prompt_body), ["token", "url"]);
    for (const text of [zh.prompt_body, en.prompt_body]) {
      assert.ok(text.includes("get_cpe_session_status") && text.includes("confirm: true"), "the prompt checks the link and keeps writes behind the owner");
    }
  });
});
