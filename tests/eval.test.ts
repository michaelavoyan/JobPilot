import { test } from "node:test";
import assert from "node:assert/strict";
import { open, recordDecision, saveScores, upsertJobs } from "../src/storage/db.ts";
import { runEval } from "../src/engine/report.ts";
import type { Track } from "../src/engine/config.ts";
import type { Job } from "../src/engine/types.ts";

function job(id: string): Job {
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

const track: Track = {
  key: "b",
  label: "Senior EM",
  enabled: true,
  weight: 1,
  order: 1,
  brief: "",
  title_include: [],
  title_exclude: [],
};

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

function seed() {
  const db = open(":memory:");
  upsertJobs(db, [job("new"), job("old")]);
  saveScores(
    db,
    [
      { jobId: "new", track: "b", score: 80, reasons: [], flags: [] },
      { jobId: "old", track: "b", score: 30, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );
  recordDecision(db, "new", "applied");
  recordDecision(db, "old", "skipped");

  // Age one decision beyond the holdout window.
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  db.prepare("UPDATE decisions SET at = ?, updated_at = ? WHERE job_id = ?").run(old, old, "old");
  return db;
}

test("a holdout measures only labels made after the window", () => {
  const db = seed();
  const lines = capture(() => runEval(db, [track], { holdoutDays: 30 }));
  assert.ok(
    lines.some((l) => l.includes("holdout: 1 of 2")),
    "the split is reported, not silent",
  );
  assert.ok(
    lines.some((l) => l.includes("1/1 = 1.00")),
    "precision is computed on the recent label only",
  );
  assert.ok(
    lines.some((l) => l.includes("holdout window")),
    "an empty holdout says so instead of blaming the shadow setting",
  );
});

test("without a holdout every label counts", () => {
  const db = seed();
  const lines = capture(() => runEval(db, [track]));
  assert.ok(lines.some((l) => l.includes("labels: 2")));
  assert.ok(lines.some((l) => l.includes("1/2 = 0.50")));
  assert.ok(!lines.some((l) => l.includes("holdout")), "no split is implied");
});

test("a stage moved today is recent even when the decision is old", () => {
  const db = seed();
  db.prepare("UPDATE decisions SET updated_at = ? WHERE job_id = ?").run(
    new Date().toISOString(),
    "old",
  );

  const lines = capture(() => runEval(db, [track], { holdoutDays: 30 }));
  assert.ok(
    lines.some((l) => l.includes("holdout: 2 of 2")),
    "the holdout follows the latest change, not the first click",
  );
});
