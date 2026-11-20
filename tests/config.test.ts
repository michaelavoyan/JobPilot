import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { configDir, setConfigDir, templatesDir } from "../src/engine/util.ts";
import { loadMarket } from "../src/engine/config.ts";

function template(name: string): Record<string, unknown> {
  return parse(readFileSync(join(templatesDir(), name), "utf8")) as Record<string, unknown>;
}

test("config dir defaults to <repo>/config", () => {
  assert.equal(configDir(), resolve(import.meta.dirname, "..", "config"));
});

test("setConfigDir resolves relative paths against the working directory", () => {
  const before = configDir();
  setConfigDir("some/other/dir");
  assert.equal(configDir(), resolve(process.cwd(), "some/other/dir"));
  setConfigDir(before);
  assert.equal(configDir(), before);
});

test("templates ship every config file the tool needs", () => {
  const files = readdirSync(templatesDir());
  for (const name of [
    "profile.yaml",
    "tracks.yaml",
    "market.il.yaml",
    "market.us.yaml",
  ]) {
    assert.ok(files.includes(name), `missing template: ${name}`);
  }
});

test("no company file is shipped", () => {
  const files = readdirSync(templatesDir());
  assert.ok(!files.includes("companies.yaml"), "the tenant directory lives in the database");
});

test("every market template declares the required fields", () => {
  const markets = readdirSync(templatesDir()).filter((f) => /^market\..+\.yaml$/.test(f));
  assert.ok(markets.length >= 2);

  for (const file of markets) {
    const m = template(file);
    const code = file.replace(/^market\./, "").replace(/\.yaml$/, "");
    assert.equal(m.country, code.toUpperCase(), `${file}: country must match its name`);
    assert.ok(m.currency, `${file}: currency is required`);
    assert.ok(m.comp_period, `${file}: comp_period is required`);
    assert.ok(
      Object.keys(m.currency_markers as object).length > 0,
      `${file}: currency_markers is required`,
    );
  }
});

test("market templates use the right salary period", () => {
  assert.equal(template("market.il.yaml").comp_period, "month");
  assert.equal(template("market.us.yaml").comp_period, "year");
});

test("every configured regex compiles", () => {
  for (const file of ["market.il.yaml", "market.us.yaml"]) {
    const m = template(file);
    for (const key of ["clearance_patterns", "exclude_title_patterns"]) {
      for (const pattern of (m[key] as string[]) ?? []) {
        assert.doesNotThrow(
          () => new RegExp(pattern, "i"),
          `${file}: bad ${key} pattern "${pattern}"`,
        );
      }
    }
  }
});

test("city aliases are unambiguous enough to be safe as substrings", () => {
  for (const file of ["market.il.yaml", "market.us.yaml"]) {
    const aliases = (template(file).city_aliases ?? {}) as Record<string, string>;
    for (const alias of Object.keys(aliases)) {
      assert.ok(alias.length >= 3, `${file}: alias "${alias}" is too short for substring matching`);
    }
  }
});

test("the active market config is valid", () => {
  const market = loadMarket();
  assert.ok(market.country);
  assert.ok(market.currency);
  assert.ok(market.comp_period);
  assert.ok(Object.keys(market.currency_markers).length > 0);
});
