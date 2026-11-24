import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, setConfigDir } from "../src/engine/util.ts";
import { open, saveScores, stats, upsertBoards, upsertJobs, listBoards } from "../src/storage/db.ts";
import { runAll, runCollect, runDigest, runScore } from "../src/engine/pipeline.ts";
import type { Job } from "../src/engine/types.ts";

/** A config directory whose sources are all disabled, so nothing hits the network. */
function quietConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobpilot-config-"));
  writeFileSync(
    join(dir, "market.yaml"),
    [
      "country: IL",
      "currency: ILS",
      "comp_period: month",
      "country_names: [Israel]",
      "currency_markers: { ILS: ['₪'] }",
      "sources:",
      "  comeet: { enabled: false }",
      "  greenhouse: { enabled: false }",
      "  lever: { enabled: false }",
      "  ashby: { enabled: false }",
      "  adzuna: { enabled: false }",
      "  remoteok: { enabled: false }",
      "clearance_patterns: []",
      "exclude_title_patterns: []",
      "city_aliases: {}",
      "remote_deny_regions: []",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "profile.yaml"),
    "name: Test\ncountry: IL\nexperience:\n  total_years: 10\n  management_years: 3\n",
    "utf8",
  );
  writeFileSync(join(dir, "tracks.yaml"), "tracks:\n  b:\n    label: B\n    title_include: [manager]\n", "utf8");
  return dir;
}

async function withConfig<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = configDir();
  setConfigDir(dir);
  try {
    // Await inside the guard: resetting the directory before an async body
    // finishes was letting it read the wrong config.
    return await fn();
  } finally {
    setConfigDir(before);
  }
}

test("collect reads companies from the directory, not a file", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "greenhouse", ident: "acme", name: "Acme", openRoles: 5 }]);

  const summary = await withConfig(dir, async () => runCollect(db));
  // Sources are disabled, so nothing is fetched — but the run must complete and
  // must not complain that no companies exist.
  assert.equal(summary.fetched, 0);
  assert.deepEqual(Object.keys(summary.perSource), []);
});

test("an empty directory collects nothing and does not throw", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");

  const summary = await withConfig(dir, async () => runCollect(db));
  assert.equal(summary.fetched, 0);
  assert.equal(summary.inserted, 0);
});

test("the directory survives a collect run", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "lever", ident: "acme", name: "Acme" }]);

  await withConfig(dir, async () => runCollect(db));
  assert.equal(listBoards(db).length, 1, "collecting must not consume the directory");
});

function job(id: string, title: string): Job {
  return {
    id,
    source: "test",
    company: "Acme",
    title,
    url: "https://example.com/job",
    locations: ["Tel Aviv"],
    remote: true,
    description: "Lead the team.",
    lang: "en",
    country: "IL",
  };
}

/** The minimum a stubbed scoring pass must return. */
function outcome(scores: { jobId: string; score: number }[], failed: Job[] = []) {
  return {
    scores: scores.map((s) => ({ ...s, track: "b", reasons: ["stub"], flags: [] })),
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0,
    allowanceUsd: 0,
    model: "stub",
    failed: failed.map((j) => ({ job: j, reason: "stub failure" })),
    learnedJobIds: new Set<string>(),
  };
}

test("a scoring run filters first and scores only the survivors", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager"), job("b", "Sales Manager")]);

  const asked: string[] = [];
  const summary = await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => {
        asked.push(...requests.map((r) => r.job.title));
        return outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 })));
      },
    }),
  );

  assert.equal(summary.evaluated, 2);
  assert.equal(summary.eligible, 1, "the sales title never reaches the model");
  assert.equal(summary.scored, 1);
  assert.deepEqual(asked, ["Engineering Manager"]);
  assert.ok(
    Object.keys(summary.rejectReasons).some((r) => r.includes("sales")),
    "the rejection is recorded with its reason",
  );

  const scores = db.prepare("SELECT job_id FROM scores").all() as { job_id: string }[];
  assert.deepEqual(scores.map((s) => s.job_id), ["a"]);
});

test("a failed model call writes no score rather than a zero", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  const summary = await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => outcome([], requests.map((r) => r.job)),
    }),
  );

  assert.equal(summary.scored, 0);
  assert.equal(summary.failed, 1);
  const scores = db.prepare("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
  assert.equal(scores.n, 0, "a fake zero would poison ranking and the eval set");
});

test("the digest renders the matches and does not push when Telegram is off", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);
  saveScores(
    db,
    [{ jobId: "a", track: "b", score: 82, reasons: ["fits"], flags: [] }],
    "stub",
    "hash",
  );

  let written = "";
  const summary = await withConfig(dir, async () =>
    runDigest(db, {
      writeDigest: (markdown) => {
        written = markdown;
        return "out/digest.md";
      },
      pushTelegram: async () => false,
    }),
  );

  assert.equal(summary.matches, 1);
  assert.equal(summary.pushed, false);
  assert.match(written, /Acme/);
  assert.match(written, /Engineering Manager/);
  assert.match(written, /82/);
});

test("a full run collects, scores and digests in order", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");

  const summary = await withConfig(dir, async () =>
    runAll(db, {
      collect: async () => ({
        jobs: [job("a", "Engineering Manager")],
        errors: [],
        perSource: { stub: 1 },
      }),
      provider: () => "opencode",
      scoreJobs: async (requests) =>
        outcome(requests.map((r) => ({ jobId: r.job.id, score: 79 }))),
      writeDigest: () => "out/digest.md",
      pushTelegram: async () => false,
    }),
  );

  assert.equal(summary.collected, 1);
  assert.equal(summary.evaluated, 1);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.scored, 1);
  assert.equal(summary.matches, 1);
  assert.equal(summary.digest, "out/digest.md");

  const st = stats(db);
  assert.equal(st.jobs, 1, "the collected posting is stored");
  assert.equal(st.scored, 1);
});
