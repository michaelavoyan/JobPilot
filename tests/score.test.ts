import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, parseBatch } from "../src/engine/score/rerank.ts";
import type { ScoreRequest } from "../src/engine/score/rerank.ts";
import type { Job } from "../src/engine/types.ts";

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "https://example.com",
    locations: ["Tel Aviv"],
    remote: false,
    description: "x",
    lang: "en",
    country: "IL",
  };
}

const batch: ScoreRequest[] = [
  { job: job("a"), tracks: ["b_senior_em", "a_director"] },
  { job: job("b"), tracks: ["b_senior_em"] },
];

test("extractJson handles a fenced block", () => {
  const parsed = extractJson('```json\n{"results":[]}\n```') as { results: unknown[] };
  assert.deepEqual(parsed.results, []);
});

test("extractJson handles prose around the object", () => {
  const parsed = extractJson('Here you go:\n{"results":[{"i":0}]}\nHope that helps.') as {
    results: unknown[];
  };
  assert.equal(parsed.results.length, 1);
});

test("extractJson survives braces inside strings", () => {
  const parsed = extractJson('{"results":[{"i":0,"scores":{"t":{"score":50,"reasons":["a {b} c"]}}}]}') as {
    results: { scores: { t: { reasons: string[] } } }[];
  };
  assert.equal(parsed.results[0].scores.t.reasons[0], "a {b} c");
});

test("extractJson returns null on garbage", () => {
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{"unclosed": '), null);
});

test("parseBatch clamps and validates scores", () => {
  const payload = {
    results: [
      {
        i: 0,
        scores: {
          b_senior_em: { score: 140, reasons: ["a", "b", "c", "d"], flags: [] },
          a_director: { score: "42", reasons: "not-an-array", flags: ["scope"] },
        },
      },
      { i: 1, scores: { b_senior_em: { score: 70, reasons: ["ok"], flags: [] } } },
    ],
  };
  const { scores, missing } = parseBatch(payload, batch);
  assert.equal(missing.length, 0);
  assert.equal(scores.length, 3);

  const clamped = scores.find((s) => s.jobId === "a" && s.track === "b_senior_em")!;
  assert.equal(clamped.score, 100, "score above 100 is clamped");
  assert.equal(clamped.reasons.length, 3, "reasons capped at 3");

  const coerced = scores.find((s) => s.jobId === "a" && s.track === "a_director")!;
  assert.equal(coerced.score, 42);
  assert.deepEqual(coerced.reasons, [], "non-array reasons become empty");
});

test("parseBatch reports missing indices instead of writing zeros", () => {
  const payload = { results: [{ i: 0, scores: { b_senior_em: { score: 80, reasons: [], flags: [] } } }] };
  const { scores, missing } = parseBatch(payload, batch);
  assert.equal(scores.length, 1);
  assert.deepEqual(missing, [0, 1], "job 0 is missing a track, job 1 is absent entirely");
});

test("parseBatch rejects a non-object payload", () => {
  const { scores, missing } = parseBatch(null, batch);
  assert.equal(scores.length, 0);
  assert.deepEqual(missing, [0, 1]);
});

test("parseBatch ignores unknown track keys", () => {
  const payload = {
    results: [
      {
        i: 1,
        scores: {
          b_senior_em: { score: 55, reasons: [], flags: [] },
          c_ai_lead: { score: 99, reasons: [], flags: [] },
        },
      },
    ],
  };
  const { scores } = parseBatch(payload, batch);
  assert.equal(scores.length, 1);
  assert.equal(scores[0].track, "b_senior_em");
});
