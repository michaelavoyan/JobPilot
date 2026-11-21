import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listConstraints,
  open,
  proposeConstraints,
  recordDecision,
  saveScores,
  setConstraintStatus,
  upsertJobs,
} from "../src/storage/db.ts";
import { buildLearning, hasLearning, LEARNING_VERSION, renderLearning } from "../src/engine/learn.ts";
import type { Job } from "../src/engine/types.ts";

function job(id: string, description = "x"): Job {
  return {
    id,
    source: "test",
    company: `Company ${id}`,
    title: `Role ${id}`,
    url: "https://example.com",
    locations: ["Tel Aviv"],
    remote: false,
    description,
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
  assert.equal(learning.enoughLabels, false, "and the UI must not pretend they do");
  assert.deepEqual(learning.appliedExamples, [], "no examples until the sample is usable");
  assert.equal(renderLearning(learning, ["b"]), "", "nothing is injected into the prompt");
});

test("a real gap yields a threshold at the midpoint", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const learning = buildLearning(db);
  // applied median 85, skipped median 56 -> midpoint 71
  assert.equal(learning.suggestedMinScore, 71);
  assert.equal(learning.enoughLabels, true);
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

test("the suggested bar actually reaches the prompt", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const learning = buildLearning(db);
  assert.equal(learning.suggestedMinScore, 71);
  assert.match(renderLearning(learning, ["b"]), /their bar is around 71/);
});

test("an overlapping sample states no bar in the prompt", () => {
  const db = open(":memory:");
  seed(db, "applied", [70, 72, 74, 76, 78], "a");
  seed(db, "skipped", [68, 70, 72, 74, 76, 78, 80, 82, 84, 86], "s");

  assert.doesNotMatch(renderLearning(buildLearning(db), ["b"]), /their bar is around/);
});

test("a track with its own separation is described in its own section", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const text = renderLearning(buildLearning(db), ["b"]);
  assert.match(text, /In this track their applications score around 85, their skips around 57/);
});

test("the prompt block states counts and disclaims itself", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const text = renderLearning(buildLearning(db), ["b"]);
  assert.match(text, /5 applied, 10 skipped/);
  assert.match(text, /They applied to:/);
  assert.match(text, /They skipped:/);
  assert.match(text, /calibration evidence only/);
});

test("examples are scoped to the track being scored", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 85, 88, 90], "a");
  seed(db, "skipped", [40, 45, 50, 52, 55, 58, 60, 62, 64, 66], "s");

  const learning = buildLearning(db);
  assert.ok(renderLearning(learning, ["b"]).includes("## b"), "the track with labels is shown");
  assert.equal(renderLearning(learning, ["c"]), "", "a track with no labels gets nothing");

  // A track whose own sample is thinner than three gets no section.
  upsertJobs(db, [job("lonely")]);
  saveScores(db, [{ jobId: "lonely", track: "z", score: 75, reasons: [], flags: [] }], "m", "h");
  recordDecision(db, "lonely", "applied");
  assert.equal(renderLearning(buildLearning(db), ["z"]), "", "one label is not a pattern");
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

/* ---------- constraints stated in notes ---------- */

test("a proposal is not a constraint until it is confirmed", () => {
  const db = open(":memory:");
  proposeConstraints(db, [{ kind: "location_penalty", note: "too far" }]);

  assert.deepEqual(buildLearning(db).constraints, [], "proposed is not confirmed");
  assert.equal(listConstraints(db, "proposed").length, 1);
});

test("confirmed constraints reach the prompt, with the user's own words", () => {
  const db = open(":memory:");
  proposeConstraints(db, [{ kind: "domain_penalty", value: "adtech", note: "no more adtech" }]);
  setConstraintStatus(db, "domain_penalty:adtech", "confirmed");

  const text = renderLearning(buildLearning(db), []);
  assert.match(text, /adtech/);
  assert.match(text, /no more adtech/, "the note is quoted, not paraphrased");
});

test("a constraint alone does not claim there are decisions behind it", () => {
  const db = open(":memory:");
  proposeConstraints(db, [{ kind: "location_penalty", note: "too far" }]);
  setConstraintStatus(db, "location_penalty", "confirmed");

  const text = renderLearning(buildLearning(db), []);
  assert.match(text, /too far/);
  assert.doesNotMatch(text, /0 applied, 0 skipped/);
});

test("a rejected constraint never reaches the prompt", () => {
  const db = open(":memory:");
  proposeConstraints(db, [{ kind: "location_penalty", note: "too far" }]);
  setConstraintStatus(db, "location_penalty", "rejected");

  assert.deepEqual(buildLearning(db).constraints, []);
  assert.equal(renderLearning(buildLearning(db), []), "");
});

test("the same constraint from two notes is stored once", () => {
  const db = open(":memory:");
  const first = proposeConstraints(db, [{ kind: "location_penalty", note: "too far" }]);
  const second = proposeConstraints(db, [{ kind: "location_penalty", note: "commute is long" }]);
  assert.equal(first, 1);
  assert.equal(second, 0);
  assert.equal(listConstraints(db).length, 1);
});

/* ---------- preferences derived from labels ---------- */

test("a term must appear often enough before it is called a preference", () => {
  const db = open(":memory:");
  seedWith(db, "applied", [80], "a", "we use kubernetes");
  seedWith(db, "skipped", [50], "s", "we use kubernetes");

  const learning = buildLearning(db, profileWith(["kubernetes"]));
  assert.deepEqual(learning.preferences, [], "two mentions prove nothing");
});

test("preferences wait for the same sample as everything else", () => {
  const db = open(":memory:");
  // Four applied and five skipped: below the plan's 5/10 rule.
  seedWith(db, "applied", [70, 71, 72, 73], "a", "make platform");
  seedWith(db, "skipped", [80, 81, 82, 83, 84], "s", "make backend");

  const learning = buildLearning(db, profileWith(["make"]));
  assert.equal(learning.enoughLabels, false);
  assert.deepEqual(learning.preferences, [], "a common build tool is not a preference");
});

test("a term concentrated in applications becomes a preference", () => {
  const db = open(":memory:");
  seedWith(db, "applied", [70, 78, 82, 84, 86], "a", "platform engineering in node");
  seedWith(db, "skipped", [40, 44, 48, 50, 52, 54, 56, 58, 60, 62], "s", "backend in java");

  const learning = buildLearning(db, profileWith(["node"]));
  assert.equal(learning.enoughLabels, true);
  assert.equal(learning.preferences.length, 1);
  assert.equal(learning.preferences[0].term, "node");
  assert.equal(learning.preferences[0].applied, 5);
  assert.equal(learning.preferences[0].skipped, 0);
});

test("a term that appears equally on both sides is not a preference", () => {
  const db = open(":memory:");
  seedWith(db, "applied", [70, 78, 82, 84, 86], "a", "node platform");
  seedWith(db, "skipped", [40, 44, 48, 50, 52, 54, 56, 58, 60, 62], "s", "node backend");

  assert.deepEqual(buildLearning(db, profileWith(["node"])).preferences, []);
});

test("preferences and constraints are rendered side by side", () => {
  const db = open(":memory:");
  seedWith(db, "applied", [70, 78, 82, 84, 86], "a", "node platform");
  seedWith(db, "skipped", [40, 44, 48, 50, 52, 54, 56, 58, 60, 62], "s", "java backend");
  proposeConstraints(db, [{ kind: "domain_penalty", value: "adtech", note: "no more adtech" }]);
  setConstraintStatus(db, "domain_penalty:adtech", "confirmed");

  const text = renderLearning(buildLearning(db, profileWith(["node"])), []);
  assert.match(text, /mention these more often/);
  assert.match(text, /- node/);
  assert.match(text, /stated these constraints themselves/);
  assert.match(text, /adtech/);
});

/** n labelled postings at the given scores, each with the same description. */
function seedWith(
  db: ReturnType<typeof open>,
  label: string,
  scores: number[],
  prefix: string,
  description: string,
) {
  scores.forEach((score, i) => {
    const id = `${prefix}${i}`;
    upsertJobs(db, [job(id, description)]);
    saveScores(db, [{ jobId: id, track: "b", score, reasons: [], flags: [] }], "m", "h");
    recordDecision(db, id, label);
  });
}

function profileWith(stack: string[]) {
  return {
    name: "t",
    country: "IL",
    experience: { total_years: 10, management_years: 4 },
    domains: [],
    interests: [],
    stack,
    ai_practice: [],
    people_management: [],
    locations: { allowed: [], regions: [], remote_ok: true, hybrid_ok: true, onsite_only_ok: true },
    tracks: [],
  } as unknown as Parameters<typeof buildLearning>[1];
}

test("the rules version is stable and short", () => {
  assert.match(LEARNING_VERSION, /^[0-9a-f]{8}$/);
  assert.equal(LEARNING_VERSION, LEARNING_VERSION, "same rules, same version");
});

/* ---------- which decisions count as evidence ---------- */

test("a later funnel stage counts as a positive, not as nothing", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82], "a");
  seed(db, "interview", [86, 88], "i");
  seed(db, "offer", [90], "o");
  seed(db, "skipped", [50, 52, 54, 56, 58, 60, 62, 64, 66, 68], "s");

  const learning = buildLearning(db);
  assert.equal(learning.applied, 5);
  assert.equal(learning.skipped, 10);
  assert.equal(learning.enoughLabels, true);
});

test("rejected is neither a preference nor a rejection of the role", () => {
  const db = open(":memory:");
  seed(db, "applied", [80, 82, 84, 86, 88], "a");
  seed(db, "rejected", [90, 92], "r");

  const learning = buildLearning(db);
  assert.equal(learning.applied, 5, "not counted as applied");
  assert.equal(learning.skipped, 0, "and not counted as skipped");
});

test("preferences compare against decisions, not against every row", () => {
  const db = open(":memory:");
  seedWith(db, "applied", [70, 78, 82, 84, 86], "a", "node platform");
  seedWith(db, "skipped", [40, 44, 48, 50, 52, 54, 56, 58, 60, 62], "s", "java backend");
  // A rejected decision says nothing about preference and must not dilute the
  // baseline into making every term look preferred.
  seedWith(db, "rejected", [88, 90, 92, 94], "r", "java backend");

  const learning = buildLearning(db, profileWith(["node"]));
  assert.equal(learning.preferences.length, 1);
  assert.equal(learning.preferences[0].baselineRate, 0.33, "5 of 15 decisions, not 5 of 19");
});

test("a confirmed constraint is enough to score with learning", () => {
  const db = open(":memory:");
  assert.equal(hasLearning(buildLearning(db), ["b"]), false, "nothing learned from nothing");

  proposeConstraints(db, [{ kind: "location_penalty", note: "too far" }]);
  assert.equal(hasLearning(buildLearning(db), ["b"]), false, "a proposal changes nothing");

  setConstraintStatus(db, "location_penalty", "confirmed");
  assert.equal(hasLearning(buildLearning(db), ["b"]), true, "a confirmed one must reach the scorer");
});
