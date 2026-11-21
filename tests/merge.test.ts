import { test } from "node:test";
import assert from "node:assert/strict";
import { combineScoreOutcomes, mergeScoreRuns } from "../src/engine/score/merge.ts";
import type { ScoreOutcome } from "../src/engine/score/rerank.ts";
import type { Job, Score } from "../src/engine/types.ts";

const score = (jobId: string, value: number, reasons: string[] = []): Score => ({
  jobId,
  track: "b",
  score: value,
  reasons,
  flags: [],
});

test("two samples become their average", () => {
  const merged = mergeScoreRuns([[score("a", 80)], [score("a", 60)]]);
  assert.equal(merged.scores.length, 1);
  assert.equal(merged.scores[0].score, 70);
  assert.equal(merged.spread, 10, "both samples are ten points from the mean");
});

test("reasons come from the sample closest to the average", () => {
  const merged = mergeScoreRuns([
    [score("a", 50, ["the outlier"])],
    [score("a", 80, ["the typical reading"])],
    [score("a", 82, ["the other reading"])],
  ]);
  assert.equal(merged.scores[0].score, 71);
  assert.deepEqual(merged.scores[0].reasons, ["the typical reading"]);
});

test("a posting scored in only one sample is counted as partial", () => {
  const merged = mergeScoreRuns([[score("a", 80), score("b", 70)], [score("a", 82)]]);
  assert.equal(merged.scores.length, 2);
  assert.equal(merged.partial, 1);
  assert.equal(merged.scores.find((s) => s.jobId === "b")?.score, 70);
});

test("the spread is the average distance from the reported score", () => {
  const merged = mergeScoreRuns([[score("a", 90)], [score("a", 70)]]);
  assert.equal(merged.spread, 10);

  // A third sample that agrees with one edge widens the picture.
  const three = mergeScoreRuns([[score("a", 90)], [score("a", 70)], [score("a", 90)]]);
  assert.equal(three.scores[0].score, 83);
  assert.ok(three.spread > 5, "the disagreement is not hidden by the nearest sample");
});

test("tracks are averaged separately", () => {
  const merged = mergeScoreRuns([
    [
      { jobId: "a", track: "b", score: 80, reasons: [], flags: [] },
      { jobId: "a", track: "c", score: 40, reasons: [], flags: [] },
    ],
    [
      { jobId: "a", track: "b", score: 60, reasons: [], flags: [] },
      { jobId: "a", track: "c", score: 20, reasons: [], flags: [] },
    ],
  ]);
  assert.equal(merged.scores.length, 2);
  assert.equal(merged.scores.find((s) => s.track === "b")?.score, 70);
  assert.equal(merged.scores.find((s) => s.track === "c")?.score, 30);
});

test("an empty set of runs is an empty result, not a crash", () => {
  assert.deepEqual(mergeScoreRuns([]), { scores: [], spread: 0, partial: 0 });
});

/* ---------- combining whole runs ---------- */

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: "c",
    title: "t",
    url: "",
    locations: [],
    remote: true,
    description: "x",
    lang: "en",
    country: "IL",
  };
}

function outcome(over: Partial<ScoreOutcome> = {}): ScoreOutcome {
  return {
    scores: [],
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.001,
    allowanceUsd: 0,
    model: "m",
    failed: [],
    learnedJobIds: new Set<string>(),
    ...over,
  };
}

test("token and cost totals are summed because they were spent", () => {
  const combined = combineScoreOutcomes([
    outcome({ scores: [score("a", 80)] }),
    outcome({ scores: [score("a", 60)] }),
  ]);
  assert.equal(combined.tokensIn, 200);
  assert.equal(combined.tokensOut, 100);
  assert.equal(combined.costUsd, 0.002);
});

test("a posting failed only when every sample failed it", () => {
  const first = outcome({ failed: [{ job: job("a"), reason: "x" }, { job: job("b"), reason: "y" }] });
  const second = outcome({ failed: [{ job: job("a"), reason: "x" }] });

  const combined = combineScoreOutcomes([first, second]);
  assert.deepEqual(combined.failed.map((f) => f.job.id), ["a"]);
});

test("learning counts only when every sample applied it", () => {
  const combined = combineScoreOutcomes([
    outcome({ learnedJobIds: new Set(["a", "b"]) }),
    outcome({ learnedJobIds: new Set(["a"]) }),
  ]);
  assert.deepEqual([...combined.learnedJobIds], ["a"]);
});

test("a single run passes through unchanged", () => {
  const only = outcome({ scores: [score("a", 77)] });
  const combined = combineScoreOutcomes([only]);
  assert.equal(combined.tokensIn, 100);
  assert.equal(combined.scores[0].score, 77);
});
