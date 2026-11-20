import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, setConfigDir } from "../src/engine/util.ts";
import { loadProfile, loadTracks } from "../src/engine/config.ts";
import { scoreJobs } from "../src/engine/score/rerank.ts";
import type { ScoreRequest } from "../src/engine/score/rerank.ts";
import type { ChatResult } from "../src/engine/score/llm.ts";
import type { Job } from "../src/engine/types.ts";

function configWithMarket(): string {
  const dir = mkdtempSync(join(tmpdir(), "jobpilot-score-"));
  writeFileSync(
    join(dir, "market.yaml"),
    [
      "country: IL",
      "currency: ILS",
      "comp_period: month",
      "country_names: [Israel]",
      "currency_markers: { ILS: ['₪'] }",
      "sources: {}",
      "clearance_patterns: []",
      "exclude_title_patterns: []",
      "city_aliases: {}",
      "remote_deny_regions: []",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "profile.yaml"),
    [
      "name: Test Candidate",
      "field: it",
      "experience: { total_years: 12, management_years: 4 }",
      "domains: [mobile]",
      "stack: [Kotlin]",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "tracks.yaml"),
    "tracks:\n  b:\n    label: Senior EM\n    brief: leads a team\n    title_include: [manager]\n",
    "utf8",
  );
  return dir;
}

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "https://example.com",
    locations: ["Tel Aviv, Israel"],
    remote: false,
    description: "A team of eight engineers building mobile apps.",
    lang: "en",
    country: "IL",
  };
}

function withConfig<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = configDir();
  setConfigDir(dir);
  return fn().finally(() => setConfigDir(before));
}

const reply = (payload: unknown): ChatResult => ({
  text: JSON.stringify(payload),
  model: "stub",
  tokensIn: 100,
  tokensOut: 50,
});

test("scoring runs end to end with an injected model", async () => {
  const dir = configWithMarket();
  const requests: ScoreRequest[] = [
    { job: job("a"), tracks: ["b"] },
    { job: job("b"), tracks: ["b"] },
  ];

  let seenSystem = "";
  const result = await withConfig(dir, () =>
    scoreJobs(requests, loadTracks(), loadProfile(), {
      batchSize: 5,
      concurrency: 1,
      chatFn: async (system: string) => {
        seenSystem = system;
        return reply({
          results: [
            { i: 0, scores: { b: { score: 81, reasons: ["fits"], flags: [] } } },
            { i: 1, scores: { b: { score: 63, reasons: ["partial"], flags: ["scope"] } } },
          ],
        });
      },
    }),
  );

  assert.equal(result.scores.length, 2);
  assert.deepEqual(
    result.scores.map((s) => s.score).sort(),
    [63, 81],
  );
  assert.equal(result.failed.length, 0);
  assert.equal(result.tokensIn, 100, "usage is aggregated");
  assert.ok(seenSystem.includes("strict"), "the real prompt is used");
});

test("scoring reads the market country, which is what the prompt needs", async () => {
  // Regression: loadMarket was called but never imported, so every real run
  // threw ReferenceError before reaching the model.
  const dir = configWithMarket();
  let system = "";
  await withConfig(dir, () =>
    scoreJobs([{ job: job("a"), tracks: ["b"] }], loadTracks(), loadProfile(), {
      batchSize: 1,
      concurrency: 1,
      chatFn: async (s: string) => {
        system = s;
        return reply({ results: [{ i: 0, scores: { b: { score: 70, reasons: [], flags: [] } } }] });
      },
    }),
  );
  assert.ok(system.includes("IL") || system.includes("Israel"), "the market country reaches the prompt");
});

test("a failed reply is retried, then recorded rather than scored", async () => {
  const dir = configWithMarket();
  const result = await withConfig(dir, () =>
    scoreJobs([{ job: job("a"), tracks: ["b"] }], loadTracks(), loadProfile(), {
      batchSize: 1,
      concurrency: 1,
      chatFn: async () => ({ text: "not json", model: "stub", tokensIn: 1, tokensOut: 1 }),
    }),
  );

  assert.equal(result.scores.length, 0, "no fabricated score");
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /scoring_(failed|incomplete)/);
});

test("an empty reply is not treated as a zero", async () => {
  const dir = configWithMarket();
  const result = await withConfig(dir, () =>
    scoreJobs([{ job: job("a"), tracks: ["b"] }], loadTracks(), loadProfile(), {
      batchSize: 1,
      concurrency: 1,
      chatFn: async () => ({ text: "", model: "stub", tokensIn: 1, tokensOut: 1, finishReason: "length" }),
    }),
  );
  assert.equal(result.scores.length, 0);
  assert.equal(result.failed.length, 1);
});
