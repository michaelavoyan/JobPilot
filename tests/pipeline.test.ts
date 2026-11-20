import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, setConfigDir } from "../src/engine/util.ts";
import { open, upsertBoards, listBoards } from "../src/storage/db.ts";
import { runCollect } from "../src/engine/pipeline.ts";

/** A config directory whose sources are all disabled, so nothing hits the network. */
function quietConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobpilot-config-"));
  writeFileSync(
    join(dir, "market.yaml"),
    [
      "country: IL",
      "currency: ILS",
      "comp_period: month",
      "country_names: [Israel]",
      "currency_markers: { ILS: ['₪'] }",
      "sources:",
      "  comeet: { enabled: false }",
      "  greenhouse: { enabled: false }",
      "  lever: { enabled: false }",
      "  ashby: { enabled: false }",
      "  adzuna: { enabled: false }",
      "  remoteok: { enabled: false }",
      "clearance_patterns: []",
      "exclude_title_patterns: []",
      "city_aliases: {}",
      "remote_deny_regions: []",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "profile.yaml"),
    "name: Test\ncountry: IL\nexperience:\n  total_years: 10\n  management_years: 3\n",
    "utf8",
  );
  writeFileSync(join(dir, "tracks.yaml"), "tracks:\n  b:\n    label: B\n    title_include: [manager]\n", "utf8");
  return dir;
}

function withConfig<T>(dir: string, fn: () => T): T {
  const before = configDir();
  setConfigDir(dir);
  try {
    return fn();
  } finally {
    setConfigDir(before);
  }
}

test("collect reads companies from the directory, not a file", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "greenhouse", ident: "acme", name: "Acme", openRoles: 5 }]);

  const summary = await withConfig(dir, () => runCollect(db));
  // Sources are disabled, so nothing is fetched — but the run must complete and
  // must not complain that no companies exist.
  assert.equal(summary.fetched, 0);
  assert.deepEqual(Object.keys(summary.perSource), []);
});

test("an empty directory collects nothing and does not throw", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");

  const summary = await withConfig(dir, () => runCollect(db));
  assert.equal(summary.fetched, 0);
  assert.equal(summary.inserted, 0);
});

test("the directory survives a collect run", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "lever", ident: "acme", name: "Acme" }]);

  await withConfig(dir, () => runCollect(db));
  assert.equal(listBoards(db).length, 1, "collecting must not consume the directory");
});
