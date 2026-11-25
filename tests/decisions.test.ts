import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearAllDecisions,
  clearDecision,
  decisionHistory,
  listConstraints,
  listDecisions,
  open,
  proposeConstraints,
  recordDecision,
  saveScores,
  setConstraintStatus,
  upsertJobs,
} from "../src/storage/db.ts";

test("setting a decision is recorded in the log", () => {
  const db = open(":memory:");
  recordDecision(db, "job-1", "applied", "great fit");

  const history = decisionHistory(db);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, "set");
  assert.equal(history[0].label, "applied");
  assert.equal(history[0].note, "great fit");
});

test("undoing one keeps the fact that it happened", () => {
  const db = open(":memory:");
  recordDecision(db, "job-1", "skipped", "too far");
  assert.equal(clearDecision(db, "job-1"), true);

  assert.equal(listDecisions(db).length, 0, "the current state is empty");
  const history = decisionHistory(db);
  assert.equal(history.length, 2);
  assert.equal(history[0].action, "cleared", "newest first");
  assert.equal(history[0].label, "skipped", "the label that was cleared");
  assert.equal(history[0].note, "too far");
});

test("undoing something that was never decided logs nothing", () => {
  const db = open(":memory:");
  assert.equal(clearDecision(db, "job-1"), false);
  assert.equal(decisionHistory(db).length, 0);
});

test("a decision changed and cleared again leaves every step", () => {
  const db = open(":memory:");
  recordDecision(db, "job-1", "skipped");
  clearDecision(db, "job-1");
  recordDecision(db, "job-1", "applied");
  clearDecision(db, "job-1");

  const actions = decisionHistory(db).map((h) => `${h.action}:${h.label}`);
  assert.deepEqual(actions, ["cleared:applied", "set:applied", "cleared:skipped", "set:skipped"]);
  assert.equal(listDecisions(db).length, 0);
});

test("the log can be limited without losing the newest entry", () => {
  const db = open(":memory:");
  recordDecision(db, "a", "applied");
  recordDecision(db, "b", "skipped");
  recordDecision(db, "c", "applied");

  const recent = decisionHistory(db, 2);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].jobId, "c");
});

test("restoring everything clears the decisions and records each one", () => {
  const db = open(":memory:");
  recordDecision(db, "a", "applied");
  recordDecision(db, "b", "skipped", "too far");

  assert.equal(clearAllDecisions(db), 2);
  assert.equal(listDecisions(db).length, 0);

  const cleared = decisionHistory(db).filter((h) => h.action === "cleared");
  assert.equal(cleared.length, 2);
  assert.ok(cleared.some((h) => h.note === "too far"), "the note survives in the log");
});

test("restoring everything when nothing is hidden is a no-op", () => {
  const db = open(":memory:");
  assert.equal(clearAllDecisions(db), 0);
});

function scoredJob(id: string) {
  return {
    id,
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "",
    locations: ["Tel Aviv"],
    remote: true,
    description: "Lead.",
    lang: "en",
    country: "IL",
  };
}

test("restoring withdraws the proposal, keeps the confirmed rule and the score", () => {
  const db = open(":memory:");
  upsertJobs(db, [scoredJob("a")]);
  saveScores(db, [{ jobId: "a", track: "b", score: 80, reasons: [], flags: [] }], "m", "h");
  recordDecision(db, "a", "skipped", "too far and no more adtech");
  proposeConstraints(db, [
    { kind: "location_penalty", note: "too far", jobId: "a" },
    { kind: "domain_penalty", value: "adtech", note: "no more adtech", jobId: "a" },
  ]);
  setConstraintStatus(db, "location_penalty", "confirmed");

  clearDecision(db, "a");

  assert.deepEqual(
    listConstraints(db).map((c) => c.id),
    ["location_penalty"],
    "a proposal dies with its decision; a confirmed rule the user accepted does not",
  );
  const scores = db.prepare("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
  assert.equal(scores.n, 1, "restoring a decision never touches the score");
});

test("restoring everything withdraws every proposal it clears", () => {
  const db = open(":memory:");
  upsertJobs(db, [scoredJob("a"), scoredJob("b")]);
  saveScores(
    db,
    [
      { jobId: "a", track: "b", score: 80, reasons: [], flags: [] },
      { jobId: "b", track: "b", score: 70, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );
  recordDecision(db, "a", "skipped", "too far");
  recordDecision(db, "b", "applied");
  proposeConstraints(db, [
    { kind: "location_penalty", note: "too far", jobId: "a" },
    { kind: "seniority_penalty", note: "too junior", jobId: "b" },
  ]);
  setConstraintStatus(db, "seniority_penalty", "confirmed");

  assert.equal(clearAllDecisions(db), 2);
  assert.deepEqual(listConstraints(db).map((c) => c.id), ["seniority_penalty"]);
  const scores = db.prepare("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
  assert.equal(scores.n, 2, "scores survive a bulk restore");
});
