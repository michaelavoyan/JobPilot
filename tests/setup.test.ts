import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableMarkets, initConfig } from "../src/engine/setup.ts";
import { templatesDir } from "../src/engine/util.ts";

const freshDir = () => mkdtempSync(join(tmpdir(), "jobpilot-init-"));

test("both markets are available", () => {
  assert.deepEqual(availableMarkets(), ["il", "us"]);
});

test("init creates a profile, tracks and a market", () => {
  const dir = freshDir();
  const result = initConfig(dir, "il");
  assert.deepEqual(result.created.sort(), ["market.yaml", "profile.yaml", "tracks.yaml"]);
  assert.deepEqual(result.kept, []);
  assert.equal(result.market, "il");

  for (const file of ["profile.yaml", "tracks.yaml", "market.yaml"]) {
    assert.ok(existsSync(join(dir, file)), `${file} should exist`);
  }
});

test("init never creates a company file", () => {
  const dir = freshDir();
  initConfig(dir, "il");
  const files = readdirSync(dir);
  assert.ok(!files.some((f) => f.includes("compan")), `unexpected file in ${files.join(", ")}`);
});

test("the chosen market is the one written", () => {
  const dir = freshDir();
  initConfig(dir, "us");
  const contents = readdirSync(dir);
  assert.ok(contents.includes("market.yaml"), "the template is copied under a fixed name");
});

test("init keeps files that already exist", () => {
  const dir = freshDir();
  initConfig(dir, "il");
  const second = initConfig(dir, "il");
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.kept.sort(), ["market.yaml", "profile.yaml", "tracks.yaml"]);
});

test("the profile template does not carry a country", () => {
  const text = readFileSync(join(templatesDir(), "profile.yaml"), "utf8");
  assert.ok(!/^country:/m.test(text), "country belongs to the market, not the CV");
});

test("an unknown market is rejected", () => {
  assert.throws(() => initConfig(freshDir(), "de"), /unknown market "de"/);
});
