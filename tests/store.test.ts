import { test } from "node:test";
import assert from "node:assert/strict";
import {
  open,
  upsertJobs,
  unscoredJobs,
  deactivateMissing,
  recordRejects,
  markEvaluated,
  saveScores,
  dropScores,
  clearDecision,
  listBoards,
  recordBoardMiss,
  upsertBoards,
  funnelCounts,
  topScored,
  recordDecision,
} from "../src/store/db.ts";
import type { Job } from "../src/types.ts";

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: "job1",
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "https://example.com/1",
    locations: ["Tel Aviv"],
    remote: false,
    description: "A description long enough to be hashed and compared across runs.",
    lang: "en",
    country: "IL",
    ...over,
  };
}

test("upsert is idempotent", () => {
  const db = open(":memory:");
  const first = upsertJobs(db, [makeJob()]);
  assert.equal(first.inserted, 1);

  const second = upsertJobs(db, [makeJob()]);
  assert.equal(second.inserted, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.rescored, 0);
});

test("changed description drops existing scores so the job is re-scored", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob()]);
  saveScores(db, [{ jobId: "job1", track: "b_senior_em", score: 70, reasons: [], flags: [] }], "m", "h");
  markEvaluated(db, ["job1"]);
  assert.equal(unscoredJobs(db, 10).length, 0);

  upsertJobs(db, [makeJob({ description: "Completely different text, now with new requirements." })]);
  assert.equal(unscoredJobs(db, 10).length, 1);
});

test("an evaluated job is not queued again, scored or not", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob()]);
  recordRejects(db, [{ jobId: "job1", track: "b_senior_em", reason: "title_not_in_track" }]);
  markEvaluated(db, ["job1"]);
  assert.equal(unscoredJobs(db, 10).length, 0);
});

test("a job that failed to score stays queued until it is marked evaluated", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob()]);
  recordRejects(db, [{ jobId: "job1", track: "a_director", reason: "title_not_in_track" }]);
  // Rejected on one track but never scored: still pending.
  assert.equal(unscoredJobs(db, 10).length, 1);
  markEvaluated(db, ["job1"]);
  assert.equal(unscoredJobs(db, 10).length, 0);
});

test("deactivateMissing only touches the given source", () => {
  const db = open(":memory:");
  upsertJobs(db, [
    makeJob({ id: "a", source: "greenhouse" }),
    makeJob({ id: "b", source: "greenhouse" }),
    makeJob({ id: "c", source: "lever" }),
  ]);
  const n = deactivateMissing(db, "greenhouse", ["a"]);
  assert.equal(n, 1);
  const rows = db.prepare("SELECT id, active FROM jobs ORDER BY id").all() as Record<string, unknown>[];
  assert.equal(rows.find((r) => r.id === "b")!.active, 0);
  assert.equal(rows.find((r) => r.id === "c")!.active, 1);
});

test("topScored respects threshold and excludes decided jobs", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob({ id: "job1" }), makeJob({ id: "job2" })]);
  saveScores(
    db,
    [
      { jobId: "job1", track: "b_senior_em", score: 80, reasons: ["fits"], flags: [] },
      { jobId: "job2", track: "b_senior_em", score: 40, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );

  assert.equal(topScored(db, 65, 10).length, 1);
  recordDecision(db, "job1", "skipped");
  assert.equal(topScored(db, 65, 10).length, 0);
});

test("recordDecision advances a stage in place", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob()]);
  recordDecision(db, "job1", "applied");
  recordDecision(db, "job1", "interview");
  const rows = db.prepare("SELECT label, updated_at FROM decisions").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1, "advancing must not create a second row");
  assert.equal(rows[0].label, "interview");
  assert.ok(rows[0].updated_at);
});

test("a decision can be cleared so the posting returns", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob({ id: "job1" })]);
  saveScores(db, [{ jobId: "job1", track: "b_senior_em", score: 80, reasons: [], flags: [] }], "m", "h");
  recordDecision(db, "job1", "skipped");
  assert.equal(topScored(db, 0, 10).length, 0, "a decided posting is hidden");

  assert.equal(clearDecision(db, "job1"), true);
  assert.equal(topScored(db, 0, 10).length, 1, "clearing the decision brings it back");
  assert.equal(clearDecision(db, "job1"), false, "clearing twice is a no-op");
});

test("funnelCounts returns stages in pipeline order", () => {
  const db = open(":memory:");
  upsertJobs(db, [makeJob({ id: "a" }), makeJob({ id: "b" }), makeJob({ id: "c" })]);
  recordDecision(db, "a", "interview");
  recordDecision(db, "b", "applied");
  recordDecision(db, "c", "skipped");
  const counts = funnelCounts(db);
  assert.deepEqual(
    counts.map((c) => c.stage),
    ["applied", "interview", "skipped"],
  );
});

test("discovered boards are remembered and deduplicated", () => {
  const db = open(":memory:");
  upsertBoards(db, [
    { ats: "greenhouse", ident: "acme", name: "Acme", openRoles: 12 },
    { ats: "lever", ident: "other", name: "Other", openRoles: 3 },
  ]);
  assert.equal(listBoards(db).length, 2);

  upsertBoards(db, [{ ats: "greenhouse", ident: "acme", name: "Acme", openRoles: 20 }]);
  const boards = listBoards(db);
  assert.equal(boards.length, 2, "a known board is updated, not duplicated");
  assert.equal(boards.find((b) => b.ident === "acme")!.openRoles, 20);
});

test("re-upserting a Comeet board keeps its token when none is supplied", () => {
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "comeet", ident: "72.006", token: "abc", name: "Acme" }]);
  upsertBoards(db, [{ ats: "comeet", ident: "72.006", name: "Acme", openRoles: 12 }]);
  const [board] = listBoards(db);
  assert.equal(board.token, "abc", "the token must not be lost");
  assert.equal(board.openRoles, 12);
});

test("a board that keeps failing is retired", () => {
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "lever", ident: "gone", name: "Gone" }]);
  for (let i = 0; i < 13; i++) recordBoardMiss(db, "lever", "gone");
  assert.equal(listBoards(db).length, 1, "still active before the limit");

  recordBoardMiss(db, "lever", "gone");
  assert.equal(listBoards(db).length, 0, "retired after the limit");
  assert.equal(listBoards(db, false).length, 1, "but still on record");
});

test("re-discovering a retired board revives it", () => {
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "lever", ident: "back", name: "Back" }]);
  for (let i = 0; i < 14; i++) recordBoardMiss(db, "lever", "back");
  assert.equal(listBoards(db).length, 0);

  upsertBoards(db, [{ ats: "lever", ident: "back", name: "Back", openRoles: 5 }]);
  assert.equal(listBoards(db).length, 1);
});

test("dropScores removes a stale verdict for one track only", () => {  const db = open(":memory:");
  upsertJobs(db, [makeJob()]);
  saveScores(
    db,
    [
      { jobId: "job1", track: "b_senior_em", score: 80, reasons: [], flags: [] },
      { jobId: "job1", track: "a_director", score: 50, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );
  dropScores(db, [{ jobId: "job1", track: "a_director" }]);
  const rows = topScored(db, 0, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].track, "b_senior_em");
});

test("topScored returns reasons and locations parsed from JSON", () => {  const db = open(":memory:");
  upsertJobs(db, [makeJob({ id: "job1", locations: ["Tel Aviv", "Herzliya"] })]);
  saveScores(db, [{ jobId: "job1", track: "b_senior_em", score: 90, reasons: ["a", "b"], flags: ["remote"] }], "m", "h");
  const [row] = topScored(db, 65, 10);
  assert.deepEqual(row.locations, ["Tel Aviv", "Herzliya"]);
  assert.deepEqual(row.reasons, ["a", "b"]);
  assert.deepEqual(row.flags, ["remote"]);
});
