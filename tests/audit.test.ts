import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { open, saveScores, upsertJobs } from "../src/storage/db.ts";
import { writeRunReport } from "../src/engine/audit.ts";
import type { Job } from "../src/engine/types.ts";

function job(): Job {
  return {
    id: "job1",
    source: "test",
    company: "Acme",
    title: "Mobile Team Lead",
    url: "https://example.com/1",
    locations: ["Tel Aviv"],
    remote: false,
    description: "x",
    lang: "en",
    country: "IL",
  };
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "jobpilot-runs-"));
}

test("a report is written with options, filters and results", () => {
  const dir = freshDir();
  const db = open(":memory:");
  upsertJobs(db, [job()]);
  saveScores(db, [{ jobId: "job1", track: "b_senior_em", score: 84, reasons: ["fits"], flags: [] }], "m", "h");

  const file = writeRunReport(db, "score", { scored: 1 }, dir);
  const report = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

  assert.equal(report.action, "score");
  assert.ok(report.started, "the report is timestamped");
  assert.ok(report.options, "options are recorded");
  assert.ok(report.filters, "the filters applied are recorded");
  assert.ok(report.results, "results are recorded");
  assert.equal(report.detail.scored, 1);
});

test("results list the scored matches with their reasons", () => {
  const dir = freshDir();
  const db = open(":memory:");
  upsertJobs(db, [job()]);
  saveScores(db, [{ jobId: "job1", track: "b_senior_em", score: 84, reasons: ["fits"], flags: ["remote"] }], "m", "h");

  const report = JSON.parse(readFileSync(writeRunReport(db, "run", {}, dir), "utf8")) as Record<string, any>;
  const [match] = report.results.matches;
  assert.equal(match.score, 84);
  assert.equal(match.company, "Acme");
  assert.deepEqual(match.reasons, ["fits"]);
  assert.deepEqual(match.flags, ["remote"]);
  assert.equal(match.url, "https://example.com/1");
});

test("filters record the rejection reasons", () => {
  const dir = freshDir();
  const db = open(":memory:");
  upsertJobs(db, [job()]);
  db.prepare("INSERT INTO rejects (job_id, track, reason, at) VALUES (?,?,?,?)").run(
    "job1",
    "b_senior_em",
    "title_not_in_track",
    new Date().toISOString(),
  );

  const report = JSON.parse(readFileSync(writeRunReport(db, "digest", {}, dir), "utf8")) as Record<string, any>;
  const reasons = report.filters.rejections as { reason: string; n: number }[];
  assert.equal(reasons[0].reason, "title_not_in_track");
  assert.equal(reasons[0].n, 1);
});

test("each run gets its own file", async () => {
  const dir = freshDir();
  const db = open(":memory:");
  upsertJobs(db, [job()]);
  writeRunReport(db, "collect", {}, dir);
  await new Promise((r) => setTimeout(r, 1100));
  writeRunReport(db, "collect", {}, dir);
  assert.equal(readdirSync(dir).length, 2);
});

test("reports are valid JSON with a trailing newline", () => {
  const dir = freshDir();
  const db = open(":memory:");
  const text = readFileSync(writeRunReport(db, "stats", {}, dir), "utf8");
  assert.ok(text.endsWith("\n"));
  assert.doesNotThrow(() => JSON.parse(text));
});
