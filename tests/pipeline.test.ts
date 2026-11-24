import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, setConfigDir } from "../src/engine/util.ts";
import {
  attemptedNames,
  listBoards,
  open,
  saveScores,
  saveShadowScores,
  stats,
  upsertBoards,
  upsertJobs,
} from "../src/storage/db.ts";
import { runAll, runCollect, runDigest, runScore } from "../src/engine/pipeline.ts";
import { LEARNING_VERSION } from "../src/engine/learn.ts";
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

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("learned scores carry their rule version and a record of what was shown", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => ({
        ...outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 }))),
        learnedJobIds: new Set(requests.map((r) => r.job.id)),
      }),
    }),
  );

  const row = db.prepare("SELECT variant, learning_version FROM scores").get() as {
    variant: string;
    learning_version: string;
  };
  assert.equal(row.variant, "learned");
  assert.equal(row.learning_version, LEARNING_VERSION);

  const runs = db.prepare("SELECT COUNT(*) AS n FROM learning_runs").get() as { n: number };
  assert.equal(runs.n, 1, "the block that reached the model is recorded");
});

test("without learned evidence the score is baseline and no run is recorded", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 }))),
    }),
  );

  const row = db.prepare("SELECT variant, learning_version FROM scores").get() as {
    variant: string;
    learning_version: string | null;
  };
  assert.equal(row.variant, "baseline");
  assert.equal(row.learning_version, null);
  const runs = db.prepare("SELECT COUNT(*) AS n FROM learning_runs").get() as { n: number };
  assert.equal(runs.n, 0);
});

test("shadow scoring saves a baseline twin for the learned postings only", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  const calls: { learning: unknown }[] = [];
  await withEnv({ LEARNING_SHADOW: "10" }, () =>
    withConfig(dir, async () =>
      runScore(db, {}, {
        provider: () => "opencode",
        scoreJobs: async (requests, _tracks, _profile, options) => {
          calls.push({ learning: options.learning });
          return {
            ...outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 }))),
            learnedJobIds: new Set(requests.map((r) => r.job.id)),
          };
        },
      }),
    ),
  );

  assert.equal(calls.length, 2, "one learned pass and one baseline pass");
  assert.equal(calls[1].learning, undefined, "the twin is scored without learning");

  const twins = db.prepare("SELECT COUNT(*) AS n FROM shadow_scores").get() as { n: number };
  assert.equal(twins.n, 1);
});

test("nothing learned means no shadow twin is paid for", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  let calls = 0;
  await withEnv({ LEARNING_SHADOW: "10" }, () =>
    withConfig(dir, async () =>
      runScore(db, {}, {
        provider: () => "opencode",
        scoreJobs: async (requests) => {
          calls++;
          return outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 })));
        },
      }),
    ),
  );

  assert.equal(calls, 1);
  const twins = db.prepare("SELECT COUNT(*) AS n FROM shadow_scores").get() as { n: number };
  assert.equal(twins.n, 0);
});

test("two samples are averaged before a score is stored", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  let call = 0;
  const seen: number[] = [];
  await withEnv({ SCORE_SAMPLES: "2" }, () =>
    withConfig(dir, async () =>
      runScore(db, {}, {
        provider: () => "opencode",
        scoreJobs: async (requests) => {
          call++;
          const value = call === 1 ? 80 : 60;
          seen.push(value);
          return outcome(requests.map((r) => ({ jobId: r.job.id, score: value })));
        },
      }),
    ),
  );

  assert.deepEqual(seen, [80, 60], "the run really asked twice");
  const row = db.prepare("SELECT score FROM scores").get() as { score: number };
  assert.equal(row.score, 70, "the stored score is the average");
});

test("without a key the run filters and reports, but never calls the model", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  let called = false;
  const summary = await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => null,
      scoreJobs: async (requests) => {
        called = true;
        return outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 })));
      },
    }),
  );

  assert.equal(called, false);
  assert.equal(summary.eligible, 1, "the filters still did their work");
  assert.equal(summary.scored, 0);
});

test("editing the profile invalidates stored scores instead of keeping them", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager")]);

  const run = () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 }))),
    });

  await withConfig(dir, run);
  const first = db.prepare("SELECT profile_hash FROM scores").get() as { profile_hash: string };

  // A different profile means a different hash: the scores were made against
  // criteria that no longer exist.
  writeFileSync(
    join(dir, "profile.yaml"),
    "name: Test\ncountry: IL\nstack: [Kotlin]\n" +
      "experience: { total_years: 10, management_years: 3 }\n",
    "utf8",
  );
  await withConfig(dir, run);

  const second = db.prepare("SELECT profile_hash FROM scores").get() as { profile_hash: string };
  assert.notEqual(second.profile_hash, first.profile_hash);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM scores").get() as { n: number };
  assert.equal(rows.n, 1, "the old score is gone and the posting was scored again");
});

test("a run where nothing passes the filters stops before the model", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Sales Manager")]);

  let called = false;
  const summary = await withConfig(dir, async () =>
    runScore(db, {}, {
      provider: () => "opencode",
      scoreJobs: async (requests) => {
        called = true;
        return outcome([]);
      },
    }),
  );

  assert.equal(called, false);
  assert.equal(summary.eligible, 0);
  assert.equal(summary.scored, 0);
});

test("a failed run is recorded before the error is rethrown", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");

  await assert.rejects(
    () =>
      withConfig(dir, async () =>
        runAll(db, {
          collect: async () => {
            throw new Error("network down");
          },
        }),
      ),
    /network down/,
  );

  const row = db.prepare("SELECT errors FROM runs").get() as { errors: string };
  assert.match(String(row.errors), /network down/, "the failure is visible in the run log");
});

test("shadow scoring moves on to postings that have no twin yet", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertJobs(db, [job("a", "Engineering Manager"), job("b", "Engineering Manager")]);

  // "a" already has a baseline twin from an earlier run.
  saveShadowScores(
    db,
    [{ jobId: "a", track: "b", score: 70, reasons: [], flags: [] }],
    "stub",
    LEARNING_VERSION,
  );

  const shadowed: string[] = [];
  let call = 0;
  await withEnv({ LEARNING_SHADOW: "1" }, () =>
    withConfig(dir, async () =>
      runScore(db, {}, {
        provider: () => "opencode",
        scoreJobs: async (requests, _tracks, _profile, options) => {
          call++;
          if (call === 2) shadowed.push(...requests.map((r) => r.job.id));
          return {
            ...outcome(requests.map((r) => ({ jobId: r.job.id, score: 80 }))),
            learnedJobIds: new Set(requests.map((r) => r.job.id)),
          };
        },
      }),
    ),
  );

  assert.deepEqual(shadowed, ["b"], "the posting without a twin is chosen, not the first one");
});

test("a run can grow the directory before collecting", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");
  upsertBoards(db, [{ ats: "greenhouse", ident: "old", name: "Old Co" }]);

  let skipSeen: Set<string> | undefined;
  const summary = await withEnv({ DISCOVER_ON_RUN: "1", DISCOVER_LIMIT: "5" }, () =>
    withConfig(dir, async () =>
      runAll(db, {
        discoverFromList: async (options) => {
          skipSeen = options?.skip;
          return {
            names: 2,
            probed: 2,
            hits: [
              { name: "New Co", source: "greenhouse", ident: "newco", openRoles: 3 },
              { name: "Ghost Co", source: "ashby", ident: "ghostco", openRoles: 1 },
            ],
            checked: ["New Co", "Ghost Co"],
            errors: [],
          };
        },
        collect: async () => ({ jobs: [], errors: [], perSource: {} }),
        writeDigest: () => "out/digest.md",
        pushTelegram: async () => false,
      }),
    ),
  );

  const names = listBoards(db).map((b) => b.name).sort();
  assert.deepEqual(names, ["Ghost Co", "New Co", "Old Co"]);
  assert.equal(summary.collected, 0);
  assert.ok(skipSeen?.has("oldco"), "known companies are not probed again");
  assert.deepEqual([...attemptedNames(db)].sort(), ["Ghost Co", "New Co"]);
});

test("a second run does not probe the same companies again", async () => {
  const dir = quietConfigDir();
  const db = open(":memory:");

  const run = () =>
    withEnv({ DISCOVER_ON_RUN: "1" }, () =>
      withConfig(dir, async () =>
        runAll(db, {
          discoverFromList: async () => ({
            names: 1,
            probed: 1,
            hits: [{ name: "Probed Co", source: "greenhouse", ident: "probedco", openRoles: 1 }],
            checked: ["Probed Co"],
            errors: [],
          }),
          collect: async () => ({ jobs: [], errors: [], perSource: {} }),
          writeDigest: () => "out/digest.md",
          pushTelegram: async () => false,
        }),
      ),
    );

  await run();

  let skipSeen: Set<string> | undefined;
  await withEnv({ DISCOVER_ON_RUN: "1" }, () =>
    withConfig(dir, async () =>
      runAll(db, {
        discoverFromList: async (options) => {
          skipSeen = options?.skip;
          return { names: 0, probed: 0, hits: [], checked: [], errors: [] };
        },
        collect: async () => ({ jobs: [], errors: [], perSource: {} }),
        writeDigest: () => "out/digest.md",
        pushTelegram: async () => false,
      }),
    ),
  );

  assert.ok(skipSeen?.has("probedco"), "a name probed once is not probed daily");
});
