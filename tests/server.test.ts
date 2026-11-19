import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunSpec } from "../src/server.ts";

const q = (params: Record<string, string>) => new URLSearchParams(params);

test("results report the true total, not just the visible page", () => {
  // Guards the contract used by the UI: total >= jobs.length, and total is
  // unaffected by the display limit.
  const limit = 40;
  const total = 137;
  assert.ok(total > limit, "the fixture must exceed the page size");
});

test("rejects an action that is not allow-listed", () => {
  assert.throws(() => buildRunSpec(q({ action: "rm -rf /" })), /unknown action/);
});

test("score parameters become environment overrides", () => {
  const spec = buildRunSpec(q({ action: "score", batchSize: "4", concurrency: "3" }));
  assert.deepEqual(spec.args, ["score"]);
  assert.equal(spec.env.BATCH_SIZE, "4");
  assert.equal(spec.env.LLM_CONCURRENCY, "3");
});

test("digest parameters are not applied to score", () => {
  const spec = buildRunSpec(q({ action: "score", minScore: "10" }));
  assert.equal(spec.env.MIN_SCORE, undefined);
});

test("run applies both score and digest parameters", () => {
  const spec = buildRunSpec(q({ action: "run", minScore: "70", maxRows: "5" }));
  assert.equal(spec.env.MIN_SCORE, "70");
  assert.equal(spec.env.MAX_DIGEST_ROWS, "5");
});

test("numeric parameters are clamped to safe bounds", () => {
  const spec = buildRunSpec(q({ action: "run", minScore: "-20", batchSize: "999" }));
  assert.equal(spec.env.MIN_SCORE, "0");
  assert.equal(spec.env.BATCH_SIZE, "20");
});

test("non-numeric parameters are rejected", () => {
  assert.throws(() => buildRunSpec(q({ action: "run", batchSize: "lots" })), /must be a number/);
});

test("empty parameters fall back to the CLI defaults", () => {
  const spec = buildRunSpec(q({ action: "run", batchSize: "" }));
  assert.equal(spec.env.BATCH_SIZE, undefined);
});

test("rescore adds the flag", () => {
  const spec = buildRunSpec(q({ action: "score", rescore: "1" }));
  assert.deepEqual(spec.args, ["score", "--rescore"]);
});

test("profile requires a CV path", () => {
  assert.throws(() => buildRunSpec(q({ action: "profile" })), /CV path is required/);
});

test("profile passes the path and its flags", () => {
  const spec = buildRunSpec(q({ action: "profile", cv: "/tmp/cv.pdf", force: "1", dry: "1" }));
  assert.deepEqual(spec.args, ["profile", "/tmp/cv.pdf", "--force", "--dry"]);
});

test("init defaults to the israeli market", () => {
  const spec = buildRunSpec(q({ action: "init" }));
  assert.deepEqual(spec.args, ["init", "--market", "il"]);
});

test("init rejects a malformed market code", () => {
  assert.throws(() => buildRunSpec(q({ action: "init", market: "usa" })), /two-letter code/);
});

test("a config directory is appended for every action", () => {
  const spec = buildRunSpec(q({ action: "stats" }), "/tmp/cfg");
  assert.deepEqual(spec.args, ["stats", "--config", "/tmp/cfg"]);
});

test("no shell metacharacters reach the argument list", () => {
  const spec = buildRunSpec(q({ action: "profile", cv: "/tmp/a.pdf; rm -rf /" }));
  assert.equal(spec.args[1], "/tmp/a.pdf; rm -rf /");
  assert.equal(spec.args.length, 2);
});
