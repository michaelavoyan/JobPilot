import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listBoards,
  pruneSilentBoards,
  reviveBoards,
  latestBoardYield,
  open,
  recordBoardYield,
  saveScores,
  upsertBoards,
  upsertJobs,
} from "../src/storage/db.ts";
import type { Job } from "../src/engine/types.ts";

function job(id: string, company: string): Job {
  return {
    id,
    source: "greenhouse",
    company,
    title: "Engineering Manager",
    url: "",
    locations: ["Tel Aviv"],
    remote: true,
    description: "Lead.",
    lang: "en",
    country: "IL",
  };
}

function dbWithBoards() {
  const db = open(":memory:");
  upsertBoards(db, [
    { ats: "greenhouse", ident: "a", name: "Acme" },
    { ats: "greenhouse", ident: "b", name: "Beta" },
  ]);
  return db;
}

function seedDead(db: ReturnType<typeof open>, ats: string, ident: string, count: number) {
  const stmt = db.prepare(
    "INSERT INTO board_yield (ats, ident, at, fetched, eligible, matched) VALUES (?, ?, ?, 0, 0, 0)",
  );
  for (let i = 0; i < count; i++) {
    stmt.run(ats, ident, new Date(Date.now() - (count - i) * 86_400_000).toISOString());
  }
}

test("yield counts fetched, eligible and matched per board", () => {
  const db = dbWithBoards();
  upsertJobs(db, [job("a1", "Acme"), job("a2", "Acme")]);
  saveScores(
    db,
    [
      { jobId: "a1", track: "b", score: 80, reasons: [], flags: [] },
      { jobId: "a2", track: "b", score: 40, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );

  const result = recordBoardYield(db, {
    at: new Date().toISOString(),
    runStart: new Date(Date.now() - 60_000).toISOString(),
    threshold: 65,
    scored: true,
  });

  const acme = result.rows.find((r) => r.name === "Acme")!;
  assert.equal(acme.fetched, 2);
  assert.equal(acme.eligible, 2);
  assert.equal(acme.matched, 1, "only the score at or above the threshold counts");

  const beta = result.rows.find((r) => r.name === "Beta")!;
  assert.deepEqual([beta.fetched, beta.eligible, beta.matched], [0, 0, 0]);
});

test("a board with fourteen empty runs is retired", () => {
  const db = dbWithBoards();
  seedDead(db, "greenhouse", "b", 13);

  const result = recordBoardYield(db, {
    at: new Date().toISOString(),
    runStart: new Date(Date.now() - 60_000).toISOString(),
    threshold: 65,
    scored: true,
  });

  assert.deepEqual(result.retired, ["Beta"]);
  assert.equal(listBoards(db, false).find((b) => b.ident === "b")?.enabled, false);
  assert.equal(listBoards(db).some((b) => b.ident === "b"), false, "retired boards are not collected");
});

test("nothing is retired when the run did not score anything", () => {
  const db = dbWithBoards();
  seedDead(db, "greenhouse", "b", 13);

  recordBoardYield(db, {
    at: new Date().toISOString(),
    runStart: new Date(Date.now() - 60_000).toISOString(),
    threshold: 65,
    scored: false,
  });

  assert.equal(listBoards(db, false).find((b) => b.ident === "b")?.enabled, true);
});

test("discovery revives a retired board", () => {
  const db = dbWithBoards();
  seedDead(db, "greenhouse", "b", 13);
  recordBoardYield(db, {
    at: new Date().toISOString(),
    runStart: new Date(Date.now() - 60_000).toISOString(),
    threshold: 65,
    scored: true,
  });

  upsertBoards(db, [{ ats: "greenhouse", ident: "b", name: "Beta" }]);
  assert.equal(listBoards(db, false).find((b) => b.ident === "b")?.enabled, true);
});

test("the latest yield is readable for status", () => {
  const db = dbWithBoards();
  recordBoardYield(db, {
    at: new Date().toISOString(),
    runStart: new Date(Date.now() - 60_000).toISOString(),
    threshold: 65,
    scored: true,
  });

  assert.equal(latestBoardYield(db).length, 2);
});

test("pruning disables only boards that produced no scored posting", () => {
  const db = open(":memory:");
  upsertBoards(db, [
    { ats: "greenhouse", ident: "a", name: "Acme" },
    { ats: "greenhouse", ident: "b", name: "Beta" },
    { ats: "greenhouse", ident: "d", name: "Dead" },
  ]);
  // Old board, out of the window: left alone.
  upsertBoards(db, [{ ats: "greenhouse", ident: "c", name: "Old" }]);
  db.prepare("UPDATE boards SET verified_at = ? WHERE ident = 'c'").run(
    new Date(Date.now() - 3 * 86_400_000).toISOString(),
  );

  upsertJobs(db, [job("a1", "Acme"), job("b1", "Beta")]);
  saveScores(db, [{ jobId: "a1", track: "b", score: 80, reasons: [], flags: [] }], "m", "h");

  const result = pruneSilentBoards(db, new Date(Date.now() - 3_600_000).toISOString());
  assert.deepEqual(result.disabled.sort(), ["Beta", "Dead"]);
  assert.equal(result.kept, 1);

  const enabled = listBoards(db).map((b) => b.name).sort();
  assert.deepEqual(enabled, ["Acme", "Old"]);
});

test("a pruned board can be revived by name or wholesale", () => {
  const db = open(":memory:");
  upsertBoards(db, [
    { ats: "greenhouse", ident: "a", name: "Acme" },
    { ats: "greenhouse", ident: "b", name: "Beta" },
  ]);
  pruneSilentBoards(db, new Date(Date.now() - 3_600_000).toISOString());
  assert.equal(listBoards(db).length, 0);

  assert.equal(reviveBoards(db, "acme"), 1);
  assert.deepEqual(listBoards(db).map((b) => b.name), ["Acme"]);

  assert.equal(reviveBoards(db), 1);
  assert.equal(listBoards(db).length, 2);
});
