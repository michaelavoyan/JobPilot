import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearDecision,
  decisionHistory,
  listDecisions,
  open,
  recordDecision,
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
