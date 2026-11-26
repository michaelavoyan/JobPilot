import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => parse(readFileSync(resolve(root, path), "utf8")) as Record<string, any>;

test("the required check runs the declared floor and cannot write", () => {
  const wf = read(".github/workflows/test.yml");
  assert.deepEqual(wf.permissions, { contents: "read" });
  assert.ok(wf.jobs.test, "the required check exists");
  assert.equal(wf.jobs.test.steps[1].with["node-version"], 24);
  assert.ok(wf.jobs["test-next"], "the newer line is watched");
  assert.ok(wf.jobs.audit, "dependency advisories are visible");
});

test("tests can be started by hand", () => {
  const wf = read(".github/workflows/test.yml");
  assert.ok("workflow_dispatch" in wf.on, "a manual run is possible");
});

test("a release refuses a tag that is not a complete release", () => {
  const wf = read(".github/workflows/release.yml");
  assert.deepEqual(wf.permissions, { contents: "write" });
  assert.deepEqual(wf.on.push.tags, ["v*"]);
  assert.equal(wf.on.workflow_dispatch.inputs.tag.required, true, "a failed release can be retried");

  const steps = wf.jobs.release.steps as { name?: string; run?: string }[];
  const runs = steps.map((s) => s.run ?? "").join("\n");
  assert.match(runs, /\^v\[0-9\]\+/, "the tag must be vX.Y.Z");
  assert.match(runs, /package\.json/, "the tag must match the package version");
  assert.match(runs, /merge-base --is-ancestor/, "the tag must be on main");
  assert.match(runs, /is not on main/, "and say so when it is not");
  assert.match(runs, /origin\/main:docs\/releases/, "notes are read from main, so a retry can fix them");
  assert.match(runs, /docs\/releases/, "notes come from a committed file");
  assert.match(runs, /missing or empty/, "and their absence fails the release");
});
