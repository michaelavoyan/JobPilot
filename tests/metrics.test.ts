import { test } from "node:test";
import assert from "node:assert/strict";
import { auc, bootstrapAuc, shadowStats } from "../src/engine/report.ts";

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
