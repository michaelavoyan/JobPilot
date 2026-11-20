import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server/server.ts";

// Read-only routes only: these tests must never write to the user's database.
const server = startServer({ port: 0 });
const port = await new Promise<number>((resolve) => {
  if (server.listening) {
    resolve((server.address() as AddressInfo).port);
    return;
  }
  server.once("listening", () => resolve((server.address() as AddressInfo).port));
});
const base = `http://127.0.0.1:${port}`;

after(() => server.close());

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
  assert.ok(Array.isArray(body.jobs));
  assert.equal(typeof body.total, "number");
  assert.equal(typeof body.postings, "number");
  assert.ok(body.jobs.length <= 3, "the limit is respected");
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
