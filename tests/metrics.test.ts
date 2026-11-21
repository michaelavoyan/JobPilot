import { test } from "node:test";
import assert from "node:assert/strict";
import { auc, bootstrapAuc, shadowStats } from "../src/engine/report.ts";
import { open, saveScores, saveShadowScores, shadowPairs, upsertJobs } from "../src/storage/db.ts";
import type { Job } from "../src/engine/types.ts";

test("a clean separation gives an AUC of 1", () => {
  assert.equal(auc([80, 90], [40, 50]), 1);
});

test("a complete inversion gives 0", () => {
  assert.equal(auc([30, 40], [70, 80]), 0);
});

test("ties count as half", () => {
  assert.equal(auc([70], [70]), 0.5);
});

test("one class alone says nothing", () => {
  assert.equal(auc([80, 90], []), undefined);
  assert.equal(auc([], [40]), undefined);
});

test("a partial overlap lands between the extremes", () => {
  // positives 70,90 ; negatives 60,80 -> 3 of 4 pairs won
  assert.equal(auc([70, 90], [60, 80]), 0.75);
});

test("the bootstrap interval brackets the point estimate", () => {
  const pos = [80, 82, 85, 88, 90];
  const neg = [40, 45, 50, 52, 55];
  const point = auc(pos, neg)!;
  const ci = bootstrapAuc(pos, neg)!;
  assert.ok(ci.low <= point && point <= ci.high, `${ci.low}..${ci.high} must contain ${point}`);
});

test("the bootstrap is deterministic for a fixed seed", () => {
  const pos = [70, 75, 80, 85];
  const neg = [50, 55, 60, 65];
  assert.deepEqual(bootstrapAuc(pos, neg, 200, 7), bootstrapAuc(pos, neg, 200, 7));
});

test("an interval that includes 0.5 is reported as such, not hidden", () => {
  const pos = [70, 60, 80];
  const neg = [65, 75, 55];
  const ci = bootstrapAuc(pos, neg)!;
  assert.ok(ci.low <= 0.5, "overlapping groups must produce a wide interval");
});

test("shadowStats summarises paired scores", () => {
  const stats = shadowStats([
    { jobId: "a", learned: 82, baseline: 70, label: "applied" },
    { jobId: "b", learned: 60, baseline: 62, label: "skipped" },
    { jobId: "c", learned: 50, baseline: 50 },
  ]);
  assert.equal(stats.n, 3);
  assert.equal(stats.labelled, 2);
  assert.equal(stats.meanDelta, 3.3, "(12 - 2 + 0) / 3");
  assert.equal(stats.aucLearned, 1, "the applied posting outranks the skipped one");
  assert.equal(stats.aucBaseline, 1);
});

test("shadowStats reports nothing for an empty set", () => {
  const stats = shadowStats([]);
  assert.equal(stats.n, 0);
  assert.equal(stats.aucLearned, undefined);
});

test("unlabelled pairs contribute to counts but not to AUC", () => {
  const stats = shadowStats([{ jobId: "a", learned: 80, baseline: 70 }]);
  assert.equal(stats.n, 1);
  assert.equal(stats.labelled, 0);
  assert.equal(stats.aucLearned, undefined, "no labels, no conclusion");
});

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: "c",
    title: "t",
    url: "https://example.com",
    locations: [],
    remote: true,
    description: "x",
    lang: "en",
    country: "IL",
  };
}

test("precision compares the best few under each variant", () => {
  const stats = shadowStats([
    { jobId: "a", learned: 90, baseline: 60, label: "applied" },
    { jobId: "b", learned: 80, baseline: 90, label: "skipped" },
    { jobId: "c", learned: 30, baseline: 80, label: "applied" },
  ]);

  // k=3: both variants rank all three, so precision is the same 2/3.
  assert.equal(stats.precision?.k, 3);
  assert.equal(stats.precision?.learned, 2 / 3);
  assert.equal(stats.precision?.baseline, 2 / 3);
});

test("precision is capped at ten and undefined without labels", () => {
  const pairs = Array.from({ length: 12 }, (_, i) => ({
    jobId: `j${i}`,
    learned: 50 + i,
    baseline: 50 + i,
    label: i < 6 ? "applied" : "skipped",
  }));
  assert.equal(shadowStats(pairs).precision?.k, 10);

  const unlabelled = shadowStats([{ jobId: "a", learned: 80, baseline: 70 }]);
  assert.equal(unlabelled.precision, undefined);
});

test("shadow scores round-trip and pair with the learned score", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h", {
    variant: "learned",
    learningAt: "2026-01-01T00:00:00.000Z",
  });
  saveShadowScores(db, [{ jobId: "a", track: "b", score: 70, reasons: [], flags: [] }], "m");

  assert.deepEqual(shadowPairs(db), [{ jobId: "a", track: "b", learned: 82, baseline: 70 }]);
});

test("a posting scored only once way is not a pair", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h");
  assert.deepEqual(shadowPairs(db), []);
});
