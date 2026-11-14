import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_FACTS } from "../src/device-catalog.ts";
import {
  AGENT_TEST_FEATURES,
  CELLULAR_WRITE_FEATURES,
  CONTROL_FEATURES,
  DEVICE_FEATURES,
  FEATURES,
  FEATURE_COLUMNS,
  READ_FEATURES,
  READ_SECTIONS,
  STATUS_READ_FEATURES,
  WRITE_FEATURES,
  type WriteFeatureRecord,
  featureAccess,
  featureRead,
  featureRecord,
  isCellularWriteFeature,
  isDeviceFeature,
  isStatusReadFeature,
  isWriteFeature,
  sectionFeature,
} from "../src/features.ts";
import { UNSUPPORTED_FEATURES, VERIFIED_FEATURES } from "../src/firmware.ts";
import { ROUTER_FAMILIES, ROUTER_FAMILY_FACTS } from "../src/router-family.ts";

/**
 * The capability registry (src/features.ts): one record per feature, and every other list of features
 * worked out from it. A new feature is one record here and the brand that implements it; these checks
 * keep the records whole and every name used elsewhere one the registry has.
 */

describe("capability registry", () => {
  it("lists the features in the table's column order, a column's features together", () => {
    const columns = FEATURE_COLUMNS.map((column) => column.id);
    assert.equal(new Set(columns).size, columns.length, "each column once");
    // Reading the records in order meets each column once, in the table's order
    const met: string[] = [];
    for (const feature of DEVICE_FEATURES) if (met.at(-1) !== featureRecord(feature).column) met.push(featureRecord(feature).column);
    assert.deepEqual(met, columns, "a column's features stand together, the columns in order");
    assert.deepEqual(
      FEATURE_COLUMNS.flatMap((column) => column.features),
      [...DEVICE_FEATURES],
      "every feature in exactly one column"
    );
    for (const column of FEATURE_COLUMNS) assert.ok(column.features.length > 0 && column.zh !== "" && column.en !== "", column.id);
  });

  it("names each feature of a column of several, and none of a column of one", () => {
    for (const column of FEATURE_COLUMNS) {
      const named = column.features.map((feature) => featureRecord(feature).part !== undefined);
      if (column.features.length === 1) {
        assert.deepEqual(named, [false], `${column.en}: one feature, no part`);
        assert.equal(column.parts, undefined, column.en);
      } else {
        assert.ok(named.every(Boolean), `${column.en}: each feature has its part`);
        assert.equal(column.parts?.zh.length, column.features.length, column.en);
        assert.ok([...(column.parts?.zh ?? []), ...(column.parts?.en ?? [])].every((part) => part !== ""), column.en);
      }
    }
  });

  it("files every router write under exactly one write feature, and gives every write feature one", () => {
    const actions = WRITE_FEATURES.flatMap((feature) => [...(FEATURES[feature] as WriteFeatureRecord).actions]);
    assert.equal(new Set(actions).size, actions.length, "an action belongs to one feature");
    assert.deepEqual(Object.keys(CONTROL_FEATURES).sort(), [...actions].sort());
    for (const feature of WRITE_FEATURES) {
      const record = FEATURES[feature] as WriteFeatureRecord;
      assert.ok(record.actions.length > 0, `${feature} has a write`);
      for (const action of record.actions) assert.equal(CONTROL_FEATURES[action as keyof typeof CONTROL_FEATURES], feature, action);
    }
    assert.deepEqual([...new Set(Object.values(CONTROL_FEATURES))].sort(), [...WRITE_FEATURES].sort());
  });

  it("says where each read feature is read: one read section each, or the 5 s poll's status", () => {
    for (const feature of READ_FEATURES) {
      const where = featureRead(feature);
      assert.ok(where === "status" || (READ_SECTIONS as ReadonlyArray<string>).includes(where), feature);
      if (where !== "status") assert.equal(sectionFeature(where), feature, `${where} is ${feature}'s section`);
    }
    // The sections read for writes only (router settings, access control) belong to no read feature
    assert.deepEqual(READ_SECTIONS.filter((section) => sectionFeature(section) === null), ["settings", "accessControl"]);
    assert.deepEqual([...STATUS_READ_FEATURES], ["battery", "simCard", "airplaneMode"]);
  });

  it("works every list out from the records", () => {
    assert.deepEqual([...READ_FEATURES, ...WRITE_FEATURES].sort(), [...DEVICE_FEATURES].sort());
    for (const feature of DEVICE_FEATURES) {
      assert.equal(isDeviceFeature(feature), true);
      assert.equal(isWriteFeature(feature), featureAccess(feature) === "write", feature);
      assert.equal(isStatusReadFeature(feature), featureAccess(feature) === "read" && featureRead(feature as never) === "status", feature);
    }
    assert.equal(isDeviceFeature("__proto__"), false);
    assert.equal(isDeviceFeature(42), false);
    assert.equal(isWriteFeature("telemetry"), false);
    assert.ok(CELLULAR_WRITE_FEATURES.every((feature) => featureAccess(feature) === "write" && isCellularWriteFeature(feature)));
    assert.deepEqual([...CELLULAR_WRITE_FEATURES], ["simSlot", "simPin", "airplaneSwitch", "networkMode", "operatorSelect", "roaming", "apn", "dataLimit", "trafficReset", "ussd"]);
    assert.ok(AGENT_TEST_FEATURES.every((feature) => featureAccess(feature) === "write"));
  });

  it("is the only source of feature names: the brands, the reports and the model facts use its names", () => {
    for (const family of ROUTER_FAMILIES) {
      const facts = ROUTER_FAMILY_FACTS[family];
      for (const form of [facts, ...Object.values(facts.variants ?? {})]) {
        for (const feature of form.writes) assert.equal(isWriteFeature(feature), true, `${family} writes ${feature}`);
      }
    }
    for (const entry of VERIFIED_FEATURES) assert.equal(featureAccess(entry.feature), entry.access, `${entry.model} ${entry.feature}`);
    for (const entry of UNSUPPORTED_FEATURES) assert.equal(isDeviceFeature(entry.feature), true, `${entry.model} ${entry.feature}`);
    for (const fact of MODEL_FACTS) for (const feature of fact.features) assert.equal(isDeviceFeature(feature), true, `${fact.family} ${feature}`);
  });
});
