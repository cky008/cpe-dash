import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { DOCS_SITE, HELP_TOPICS, type HelpTopicId, helpLabel, helpUrl } from "../web/src/core/help.ts";
import { DEFAULT_PREFERENCES, type KeyValueStorage, PREF_KEYS, loadPreferences } from "../web/src/core/prefs.ts";

function memoryStorage(entries: Record<string, string> = {}): KeyValueStorage {
  const map = new Map(Object.entries(entries));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
}

describe("term help in the console", () => {
  it("points every '?' at an anchor that exists in the guide, in both languages", () => {
    const ids = Object.keys(HELP_TOPICS) as HelpTopicId[];
    assert.ok(ids.length >= 30);
    for (const id of ids) {
      const topic = HELP_TOPICS[id];
      for (const lang of ["zh", "en"]) {
        const page = fs.readFileSync(path.join("docs", "guide", lang, `${topic.page}.md`), "utf8");
        assert.ok(page.includes(`<a id="${topic.anchor}"></a>`), `docs/guide/${lang}/${topic.page}.md lacks <a id="${topic.anchor}"></a> (${id})`);
      }
    }
  });

  it("explains each term in one short line per language, and links to the reader's language", () => {
    for (const [id, topic] of Object.entries(HELP_TOPICS)) {
      for (const locale of ["zh-CN", "en"] as const) {
        assert.ok(topic.tip[locale].length >= 8 && topic.tip[locale].length <= 110, `${id} ${locale}: ${topic.tip[locale]}`);
        assert.doesNotMatch(topic.tip[locale], /[<>"]/, "plain text: it lands in an attribute");
      }
    }
    assert.equal(helpUrl("rsrp", "zh-CN"), `${DOCS_SITE}docs/signal/#rsrp`);
    assert.equal(helpUrl("pci", "en"), `${DOCS_SITE}en/docs/bands-and-cells/#pci`);
    assert.equal(helpLabel("upnp", "zh-CN"), "什么是UPnP？");
    assert.equal(helpLabel("upnp", "en"), "What is UPnP?");
    assert.match(DOCS_SITE, /^https:\/\/cky008\.github\.io\/cpe-dash\/$/, "the project's own site, never a personal domain");
  });

  it("shows the marks unless the browser turned them off in Settings → Appearance", () => {
    assert.equal(DEFAULT_PREFERENCES.showHelp, true);
    assert.equal(loadPreferences(memoryStorage()).showHelp, true);
    assert.equal(loadPreferences(memoryStorage({ [PREF_KEYS.showHelp]: "0" })).showHelp, false);
    assert.equal(loadPreferences(memoryStorage({ [PREF_KEYS.showHelp]: "1" })).showHelp, true);
    // Applied before the first paint, like the theme
    assert.match(fs.readFileSync("web/src/boot.ts", "utf8"), /root\.dataset\["help"\] = prefs\.showHelp \? "on" : "off"/);
    assert.match(fs.readFileSync("web/styles.css", "utf8"), /:root\[data-help="off"\] \.fs-help \{\s*display: none;/);
  });
});
