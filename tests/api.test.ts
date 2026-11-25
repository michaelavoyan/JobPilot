import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setConfigDir } from "../src/engine/util.ts";
import { decisionHistory, listDecisions, open, saveScores, upsertJobs } from "../src/storage/db.ts";
import type { Job } from "../src/engine/types.ts";
import { startServer } from "../src/server/server.ts";

/**
 * A disposable config. The suite must never read or write the installation the
 * user is actually using, which is what it did while these routes were only
 * exercised with GETs.
 */
const dir = mkdtempSync(join(tmpdir(), "jobpilot-api-"));
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
setConfigDir(dir);

function job(id: string, title: string): Job {
  return {
    id,
    source: "test",
    company: "Acme",
    title,
    url: "https://example.com/job",
    locations: ["Tel Aviv"],
    remote: false,
    description: "Lead the team.",
    lang: "en",
    country: "IL",
  };
}

const db = open();
upsertJobs(db, [job("job-1", "Engineering Manager"), job("job-2", "Support Lead")]);
saveScores(
  db,
  [
    { jobId: "job-1", track: "b", score: 88, reasons: ["fits"], flags: ["org_size_unclear"] },
    { jobId: "job-2", track: "b", score: 40, reasons: ["not a fit"], flags: [] },
  ],
  "stub",
  "hash",
);

const server = startServer({ port: 0 });
const port = await new Promise<number>((resolve) => {
  if (server.listening) {
    resolve((server.address() as AddressInfo).port);
    return;
  }
  server.once("listening", () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("health answers", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean };
  assert.equal(body.ok, true);
});

test("state exposes exactly one field", async () => {
  const body = (await (await fetch(`${base}/api/state`)).json()) as {
    fields: { id: string; label: string }[];
  };
  assert.equal(body.fields.length, 1);
  assert.equal(body.fields[0].label, "Hi-Tech & Software");
});

test("state no longer advertises a company count", async () => {
  const body = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
  assert.equal("companies" in body, false, "companies live in the directory now");
});

test("jobs returns matches, a total and a posting count", async () => {
  const body = (await (await fetch(`${base}/api/jobs?min=0&limit=3`)).json()) as {
    jobs: unknown[];
    total: number;
    postings: number;
  };
  assert.equal(body.jobs.length, 2);
  assert.equal(body.total, 2);
  assert.equal(body.postings, 2);
});

test("api responses are never cached", async () => {
  for (const path of ["/api/state", "/api/jobs", "/api/decisions"]) {
    const res = await fetch(base + path);
    assert.equal(res.headers.get("cache-control"), "no-store", `${path} must not be cached`);
  }
});

test("decisions are listed with their stage", async () => {
  const body = (await (await fetch(`${base}/api/decisions`)).json()) as {
    decisions: { jobId: string; label: string }[];
  };
  assert.ok(Array.isArray(body.decisions));
  for (const decision of body.decisions) {
    assert.equal(typeof decision.jobId, "string");
    assert.equal(typeof decision.label, "string");
  }
});

test("unknown routes are 404", async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test("path traversal is refused", async () => {
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test("a decision is recorded, hides the posting, and can be undone", async () => {
  const res = await fetch(`${base}/api/feedback`, json({ jobId: "job-1", label: "applied" }));
  assert.equal(res.status, 200);

  let ids = listDecisions(db).map((d) => d.jobId);
  assert.ok(ids.includes("job-1"), "the decision is stored");

  const listed = (await (await fetch(`${base}/api/jobs?min=0`)).json()) as { jobs: { id: string }[] };
  assert.equal(
    listed.jobs.some((j) => j.id === "job-1"),
    false,
    "a decided posting is hidden from the list",
  );

  assert.equal((await fetch(`${base}/api/undo`, json({ jobId: "job-1" }))).status, 200);
  ids = listDecisions(db).map((d) => d.jobId);
  assert.equal(ids.includes("job-1"), false, "undo clears it");
});

test("a note on a decision proposes a constraint but changes nothing", async () => {
  await fetch(`${base}/api/feedback`, json({ jobId: "job-2", label: "skipped", note: "no more adtech" }));

  const learning = (await (await fetch(`${base}/api/learning`)).json()) as {
    constraints: { id: string; status: string }[];
  };
  const proposed = learning.constraints.find((c) => c.id === "domain_penalty:adtech");
  assert.ok(proposed, "the note is read");
  assert.equal(proposed.status, "proposed", "nothing is applied before confirmation");
});

test("a proposed constraint can be confirmed and then removed", async () => {
  const confirm = await fetch(
    `${base}/api/learning/constraint`,
    json({ id: "domain_penalty:adtech", status: "confirmed" }),
  );
  assert.equal(confirm.status, 200);

  const rejected = await fetch(
    `${base}/api/learning/constraint`,
    json({ id: "domain_penalty:adtech", status: "rejected" }),
  );
  assert.equal(rejected.status, 200);

  const learning = (await (await fetch(`${base}/api/learning`)).json()) as {
    constraints: { id: string; status: string }[];
  };
  assert.equal(
    learning.constraints.find((c) => c.id === "domain_penalty:adtech")?.status,
    "rejected",
  );
});

test("feedback rejects an unknown posting and a bad stage", async () => {
  assert.equal(
    (await fetch(`${base}/api/feedback`, json({ jobId: "nope", label: "applied" }))).status,
    404,
  );
  assert.equal(
    (await fetch(`${base}/api/feedback`, json({ jobId: "job-1", label: "maybe" }))).status,
    400,
  );
});

test("interests are saved and come back in state", async () => {
  const res = await fetch(`${base}/api/interests`, json({ interests: ["platform", "node"] }));
  assert.equal(res.status, 200);

  const state = (await (await fetch(`${base}/api/state`)).json()) as { interests: string[] };
  assert.deepEqual(state.interests, ["platform", "node"]);
  assert.match(readFileSync(join(dir, "profile.yaml"), "utf8"), /platform/);
});

test("an unsupported field is refused before it is written", async () => {
  const res = await fetch(`${base}/api/field`, json({ field: "finance" }));
  assert.equal(res.status, 400);
  assert.doesNotMatch(readFileSync(join(dir, "profile.yaml"), "utf8"), /finance/);
});

test("a request from another site is refused", async () => {
  const res = await fetch(`${base}/api/health`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("a cross-site GET cannot start a run", async () => {
  // `/api/run` is a GET because the page reads it as an event stream. Without
  // this guard an <img> tag on any website could spend the user's credits.
  const res = await fetch(`${base}/api/run?action=stats`, {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(res.status, 403);
});

test("a foreign Origin is refused even when Sec-Fetch-Site is absent", async () => {
  const res = await fetch(`${base}/api/learning/constraint`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ id: "x", status: "confirmed" }),
  });
  assert.equal(res.status, 403);
});

test("a same-origin request reaches its route", async () => {
  const res = await fetch(`${base}/api/learning/constraint`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ id: "no-such-constraint", status: "confirmed" }),
  });
  assert.equal(res.status, 404, "refused only for the missing id, not the origin");
});

test("a body that is not JSON is refused before it is parsed", async () => {
  const res = await fetch(`${base}/api/undo`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ jobId: "x" }),
  });
  assert.equal(res.status, 415);
});

test("an oversized body is refused with 413", async () => {
  const res = await fetch(`${base}/api/undo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: "x", padding: "x".repeat(1_100_000) }),
  });
  assert.equal(res.status, 413);
});

test("restore all clears every decision and keeps the log", async () => {
  await fetch(`${base}/api/feedback`, json({ jobId: "job-1", label: "applied" }));
  await fetch(`${base}/api/feedback`, json({ jobId: "job-2", label: "skipped" }));

  const res = await fetch(`${base}/api/undo`, json({ all: true }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { cleared: number };
  assert.ok(body.cleared >= 2, "both decisions were cleared");
  assert.equal(listDecisions(db).length, 0);

  const cleared = decisionHistory(db).filter((h) => h.action === "cleared");
  assert.ok(cleared.length >= 2, "the history survives the bulk clear");
});
