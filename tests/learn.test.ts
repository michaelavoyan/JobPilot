import { test } from "node:test";
import assert from "node:assert/strict";
import { open, recordDecision, saveScores, upsertJobs } from "../src/storage/db.ts";
import { buildLearning, renderLearning } from "../src/engine/learn.ts";
import type { Job } from "../src/engine/types.ts";

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: `Company ${id}`,
    title: `Role ${id}`,
    url: "https://example.com",
    locations: ["Tel Aviv"],
    remote: false,
    description: "x",
    lang: "en",
    country: "IL",
  };
}

/** n labelled postings at the given score, all in one track. */
function seed(db: ReturnType<typeof open>, label: string, scores: number[], prefix: string) {
  scores.forEach((score, i) => {
    const id = `${prefix}${i}`;
    upsertJobs(db, [job(id)]);
    saveScores(db, [{ jobId: id, track: "b", score, reasons: ["because"], flags: [] }], "m", "h");
    recordDecision(db, id, label);
  });
}

test("nothing is claimed from too few labels", () => {
  const db = open(":memory:");
  seed(db, "applied", [85, 80], "a");
  seed(db, "skipped", [40, 45, 50], "s");

  const learning = buildLearning(db);
  assert.equal(learning.applied, 2);
  assert.equal(learning.skipped, 3);
  assert.equal(learning.suggestedMinScore, undefined, "two examples cannot set a threshold");
  assert.deepEqual(learning.appliedExamples, [], "no examples until the sample is usable");
  assert.equal(renderLearning(learning), "", "nothing is injected into the prompt");
});

test("a real gap yields a threshold at the midpoint", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const learning = buildLearning(db);
  // applied median 85, skipped median 56 -> midpoint 71
  assert.equal(learning.suggestedMinScore, 71);
  assert.ok(learning.appliedExamples.length > 0);
  assert.ok(learning.skippedExamples.length > 0);
});

test("overlapping distributions never move the threshold", () => {
  const db = open(":memory:");
  seed(db, "applied", [70, 72, 74, 76, 78], "a");
  seed(db, "skipped", [68, 70, 72, 74, 76, 78, 80, 82, 84, 86], "s");

  const learning = buildLearning(db);
  assert.equal(learning.suggestedMinScore, undefined, "no separation, no suggestion");
  assert.ok(learning.appliedExamples.length > 0, "examples are still useful as evidence");
});

test("examples are the ones nearest the middle of each group", () => {
  const db = open(":memory:");
  seed(db, "applied", [10, 80, 81, 82, 99], "a");

  const learning = buildLearning(db);
  const scores = learning.appliedExamples.map((e) => e.score).sort((a, b) => a - b);
  assert.deepEqual(scores, [80, 81, 82], "the outliers are not chosen");
});

test("calibration is reported per track", () => {
  const db = open(":memory:");
  seed(db, "applied", [85], "a");
  seed(db, "skipped", [50], "s");
  upsertJobs(db, [job("other")]);
  saveScores(db, [{ jobId: "other", track: "c", score: 70, reasons: [], flags: [] }], "m", "h");
  recordDecision(db, "other", "applied");

  const learning = buildLearning(db);
  const tracks = learning.trackCalibration.map((t) => t.track).sort();
  assert.deepEqual(tracks, ["b", "c"]);
  assert.equal(learning.trackCalibration.find((t) => t.track === "c")!.applied, 1);
});

test("the prompt block states counts and disclaims itself", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const text = renderLearning(buildLearning(db));
  assert.match(text, /5 applied, 10 skipped/);
  assert.match(text, /They applied to:/);
  assert.match(text, /They skipped:/);
  assert.match(text, /calibration evidence only/);
});

test("shortlisted counts as a positive decision", () => {
  const db = open(":memory:");
  seed(db, "shortlisted", [80, 82, 85, 88, 90], "a");
  const learning = buildLearning(db);
  assert.equal(learning.applied, 5);
  assert.ok(learning.appliedExamples.length > 0);
  // Without any skips there is nothing to separate the two groups from.
  assert.equal(learning.suggestedMinScore, undefined);
});
