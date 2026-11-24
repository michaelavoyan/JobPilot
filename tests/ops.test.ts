import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupDatabase, listBackups } from "../src/storage/backup.ts";
import { finishRun, open, runHistory, startRun, upsertJobs } from "../src/storage/db.ts";
import { escapeAppleScript } from "../src/engine/util.ts";
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

test("a backup is a readable copy, not an empty file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobpilot-backup-"));
  const db = open(join(dir, "jobs.db"));
  upsertJobs(db, [job("a")]);

  const path = backupDatabase(db, join(dir, "backups"));
  assert.ok(existsSync(path));
  assert.equal(listBackups(join(dir, "backups")).length, 1, "the file matches the retention pattern");

  const copy = open(path);
  const rows = copy.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number };
  assert.equal(rows.n, 1, "the snapshot contains the data that existed");
});

test("old backups are pruned, the newest kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "jobpilot-prune-"));
  const backups = join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  for (const stamp of ["20200101-000000000", "20200102-000000000", "20200103-000000000"]) {
    writeFileSync(join(backups, `jobs-${stamp}.db`), "old");
  }

  const db = open(join(dir, "jobs.db"));
  backupDatabase(db, backups, 2);

  const kept = listBackups(backups);
  assert.equal(kept.length, 2);
  assert.ok(!kept.includes("20200101-000000000"), "the oldest is gone");
});

test("the run history reports the last run and its errors", () => {
  const db = open(":memory:");
  const id = startRun(db);
  finishRun(db, id, {
    collected: 10,
    scored: 3,
    errors: [{ source: "run", message: "network down" }],
  });

  const [last] = runHistory(db, 1);
  assert.equal(last.id, id);
  assert.ok(last.finished, "the run is closed");
  assert.equal(last.scored, 3);
  assert.equal(last.errors[0].message, "network down");
});

test("notification text cannot break out of the script", () => {
  assert.equal(escapeAppleScript('he said "hi"'), 'he said \\"hi\\"');
  assert.equal(escapeAppleScript("back\\slash"), "back\\\\slash");
});
