import { test } from "node:test";
import assert from "node:assert/strict";
import { auc, bootstrapAuc, shadowStats } from "../src/engine/report.ts";
import {
  learningRuns,
  open,
  recordLearningRun,
  saveScores,
  saveShadowScores,
  shadowPairs,
  staleShadowPairs,
  upsertJobs,
} from "../src/storage/db.ts";
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

/** Ten applied above ten skipped: the clearest possible separation. */
function separablePairs(): Parameters<typeof shadowStats>[0] {
  return [
    ...Array.from({ length: 10 }, (_, i) => ({
      jobId: `p${i}`,
      learned: 80 + i,
      baseline: 70 + i,
      label: "applied",
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      jobId: `n${i}`,
      learned: 40 + i,
      baseline: 40 + i,
      label: "skipped",
    })),
  ];
}

test("shadowStats summarises paired scores", () => {
  const stats = shadowStats(separablePairs());
  assert.equal(stats.n, 20);
  assert.equal(stats.labelled, 20);
  assert.equal(stats.meanDelta, 5, "learned scores sit five points higher");
  assert.equal(stats.comparison?.aucLearned, 1, "applied outranks skipped");
  assert.equal(stats.comparison?.aucBaseline, 1);
  assert.equal(stats.needed, 20);
  assert.equal(stats.solidAt, 50, "twenty pairs are a direction, not a verdict");
});

test("a handful of pairs yields no interval at all", () => {
  const stats = shadowStats([
    { jobId: "a", learned: 82, baseline: 70, label: "applied" },
    { jobId: "b", learned: 60, baseline: 62, label: "skipped" },
    { jobId: "c", learned: 50, baseline: 50 },
  ]);
  assert.equal(stats.n, 3);
  assert.equal(stats.labelled, 2);
  assert.equal(stats.meanDelta, 3.3, "(12 - 2 + 0) / 3");
  assert.equal(stats.needed, 20);
  assert.equal(stats.comparison, undefined, "the bootstrap would collapse to 1.00–1.00");
});

test("shadowStats reports nothing for an empty set", () => {
  const stats = shadowStats([]);
  assert.equal(stats.n, 0);
  assert.equal(stats.comparison, undefined);
});

test("unlabelled pairs contribute to counts but not to a comparison", () => {
  const stats = shadowStats([{ jobId: "a", learned: 80, baseline: 70 }]);
  assert.equal(stats.n, 1);
  assert.equal(stats.labelled, 0);
  assert.equal(stats.comparison, undefined, "no labels, no conclusion");
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
  // Learning lifts every applied posting above every skipped one; the baseline
  // keeps them in the same order, so both reach 1.00 here.
  const stats = shadowStats(separablePairs());
  assert.equal(stats.comparison?.precision?.k, 10);
  assert.equal(stats.comparison?.precision?.learned, 1);
  assert.equal(stats.comparison?.precision?.baseline, 1);
});

test("precision is capped at ten and absent without labels", () => {
  const unlabelled = shadowStats([{ jobId: "a", learned: 80, baseline: 70 }]);
  assert.equal(unlabelled.comparison, undefined);

  // 25 labelled pairs: k stays at ten.
  const pairs = Array.from({ length: 25 }, (_, i) => ({
    jobId: `j${i}`,
    learned: 50 + i,
    baseline: 50 + i,
    label: i < 12 ? "applied" : "skipped",
  }));
  const stats = shadowStats(pairs);
  assert.equal(stats.labelled, 25);
  assert.equal(stats.comparison?.precision?.k, 10);
});

test("shadow scores round-trip and pair with the learned score", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h", {
    variant: "learned",
    learningAt: "2026-01-01T00:00:00.000Z",
    version: "aaaa1111",
  });
  saveShadowScores(db, [{ jobId: "a", track: "b", score: 70, reasons: [], flags: [] }], "m", "aaaa1111");

  assert.deepEqual(shadowPairs(db, "aaaa1111"), [
    { jobId: "a", track: "b", learned: 82, baseline: 70 },
  ]);
});

test("a posting scored only once way is not a pair", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h");
  assert.deepEqual(shadowPairs(db, "aaaa1111"), []);
});

test("a pair is only compared when both scores came from the same rules", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h", {
    variant: "learned",
    learningAt: "2026-01-01T00:00:00.000Z",
    version: "aaaa1111",
  });
  saveShadowScores(db, [{ jobId: "a", track: "b", score: 70, reasons: [], flags: [] }], "m", "aaaa1111");

  assert.equal(shadowPairs(db, "aaaa1111").length, 1, "same version, comparable");
  assert.equal(staleShadowPairs(db, "aaaa1111"), 0);
});

test("scores from an older rule set are counted, not silently compared", () => {
  const db = open(":memory:");
  upsertJobs(db, [job("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 82, reasons: [], flags: [] }], "m", "h", {
    variant: "learned",
    learningAt: "2026-01-01T00:00:00.000Z",
    version: "bbbb2222",
  });
  saveShadowScores(db, [{ jobId: "a", track: "b", score: 70, reasons: [], flags: [] }], "m", "aaaa1111");

  assert.deepEqual(shadowPairs(db, "bbbb2222"), [], "different rules, no comparison");
  assert.equal(staleShadowPairs(db, "bbbb2222"), 1, "but the mismatch is reported");
});

test("a learning run keeps the block that reached the model", () => {
  const db = open(":memory:");
  recordLearningRun(db, { labels: 7, version: "abc12345", payload: "They applied to: X" });

  const runs = learningRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].labels, 7);
  assert.equal(runs[0].version, "abc12345");
  assert.match(runs[0].payload, /They applied to/);
});
