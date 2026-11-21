import { test } from "node:test";
import assert from "node:assert/strict";
import { ashby } from "../src/engine/ingest/ashby.ts";
import { greenhouse } from "../src/engine/ingest/greenhouse.ts";
import { lever } from "../src/engine/ingest/lever.ts";
import { remoteok } from "../src/engine/ingest/remoteok.ts";
import type { IngestCtx } from "../src/engine/ingest/types.ts";
import type { Market } from "../src/engine/config.ts";

/**
 * Recorded shapes, not live calls: these tests must run offline and must fail
 * when a provider changes a field the adapter depends on.
 */

const market: Market = {
  country: "IL",
  currency: "ILS",
  comp_period: "month",
  sources: {},
  clearance_patterns: [],
  exclude_title_patterns: [],
  city_aliases: { "תל אביב": "Tel Aviv" },
  currency_markers: { ILS: ["₪"] },
  remote_deny_regions: [],
};

const ctx = (source: string, slug = "acme"): IngestCtx => ({
  companies: [{ name: "Acme", source, slug }],
  market,
  warn: () => {},
});

function respond(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ---------- Greenhouse ---------- */

const greenhouseFixture = {
  jobs: [
    {
      title: "Engineering Manager",
      location: { name: "Tel Aviv" },
      offices: [{ name: "R&D" }],
      absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
      content: "<p>Lead the platform team.</p><ul><li>Node</li></ul>",
      updated_at: "2026-02-03T09:00:00Z",
    },
    { title: "", location: { name: "Nowhere" } },
  ],
};

test("greenhouse maps a live-shaped posting", async (t) => {
  t.mock.method(globalThis, "fetch", async () => respond(greenhouseFixture));
  const result = await greenhouse.fetch(ctx("greenhouse"));

  assert.equal(result.errors.length, 0);
  assert.equal(result.jobs.length, 1, "the untitled posting is skipped");
  const [job] = result.jobs;
  assert.equal(job.title, "Engineering Manager");
  assert.equal(job.company, "Acme");
  assert.equal(job.url, "https://boards.greenhouse.io/acme/jobs/1");
  assert.equal(job.country, "IL");
  assert.ok(job.locations.includes("Tel Aviv"), "the location object is unwrapped");
  assert.ok(job.description.includes("Lead the platform team"));
  assert.ok(!job.description.includes("<p>"), "html is stripped");
});

test("greenhouse reports an empty board instead of pretending it worked", async (t) => {
  t.mock.method(globalThis, "fetch", async () => respond({ jobs: [] }));
  const result = await greenhouse.fetch(ctx("greenhouse"));
  assert.equal(result.jobs.length, 0);
  assert.match(result.errors[0].message, /returned 0 jobs/);
});

test("greenhouse turns a failed request into an error entry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNRESET");
  });
  const result = await greenhouse.fetch(ctx("greenhouse"));
  assert.equal(result.jobs.length, 0);
  assert.match(result.errors[0].message, /Acme: ECONNRESET/);
});

/* ---------- Lever ---------- */

const leverFixture = [
  {
    text: "Backend Team Lead",
    categories: { location: "Herzliya" },
    hostedUrl: "https://jobs.lever.co/acme/1",
    descriptionPlain: "Own the API.",
    additionalPlain: "Hybrid, three days.",
    createdAt: 1767225600000,
  },
];

test("lever maps postings and converts its epoch timestamp", async (t) => {
  t.mock.method(globalThis, "fetch", async () => respond(leverFixture));
  const [job] = (await lever.fetch(ctx("lever"))).jobs;

  assert.equal(job.title, "Backend Team Lead");
  assert.equal(job.url, "https://jobs.lever.co/acme/1");
  assert.equal(job.postedAt, "2026-01-01T00:00:00.000Z");
  assert.ok(job.description.includes("Own the API"));
  assert.ok(job.description.includes("Hybrid"), "the additional block is kept");
  assert.equal(job.remote, false);
});

test("lever asks for json and the encoded slug", async (t) => {
  let seen = "";
  t.mock.method(globalThis, "fetch", async (url: string) => {
    seen = url;
    return respond(leverFixture);
  });
  await lever.fetch(ctx("lever", "acme co"));
  assert.match(seen, /api\.lever\.co\/v0\/postings\/acme%20co\?mode=json/);
});

/* ---------- Ashby ---------- */

const ashbyFixture = {
  jobs: [
    {
      title: "Director of Engineering",
      location: "Tel Aviv",
      secondaryLocations: [{ location: "Herzliya" }],
      isRemote: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/1",
      descriptionPlain: "Lead two groups.",
      publishedAt: "2026-03-04T08:00:00Z",
      compensationTierSummary: "₪40K - ₪55K",
    },
  ],
};

test("ashby maps a posting with compensation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => respond(ashbyFixture));
  const [job] = (await ashby.fetch(ctx("ashby"))).jobs;

  assert.equal(job.title, "Director of Engineering");
  assert.ok(job.locations.includes("Herzliya"), "secondary locations are kept");
  assert.equal(job.comp?.amount, 40000);
  assert.equal(job.comp?.currency, "ILS");
  assert.equal(job.comp?.period, "month");
});

test("ashby reads tiered compensation when the summary is not a string", async (t) => {
  const tiered = {
    jobs: [
      {
        title: "EM",
        location: "Tel Aviv",
        isRemote: true,
        compensation: {
          compensationTiers: [
            {
              components: [{ minValue: 30000, currencyCode: "ILS", interval: "MONTH" }],
            },
          ],
        },
      },
    ],
  };
  t.mock.method(globalThis, "fetch", async () => respond(tiered));
  const [job] = (await ashby.fetch(ctx("ashby"))).jobs;
  assert.equal(job.comp?.amount, 30000);
  assert.equal(job.remote, true);
});

/* ---------- RemoteOK ---------- */

const remoteokFixture = [
  { legal: "See https://remoteok.com/api for terms" },
  {
    position: "Staff Engineer",
    company: "Globex",
    url: "https://remoteok.com/jobs/1",
    location: "Worldwide",
    description: "Distributed systems.",
    date: "2026-04-05T00:00:00Z",
  },
  { position: "", company: "Broken" },
];

test("remoteok skips the legal notice and keeps real postings", async (t) => {
  t.mock.method(globalThis, "fetch", async () => respond(remoteokFixture));
  const result = await remoteok.fetch(ctx("remoteok"));

  assert.equal(result.jobs.length, 1);
  const [job] = result.jobs;
  assert.equal(job.company, "Globex");
  assert.equal(job.title, "Staff Engineer");
  assert.equal(job.remote, true);
});

test("remoteok reports a network failure without throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ETIMEDOUT");
  });
  const result = await remoteok.fetch(ctx("remoteok"));
  assert.equal(result.jobs.length, 0);
  assert.match(result.errors[0].message, /ETIMEDOUT/);
});

test("a non-200 answer becomes an error, not a crash", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 503, statusText: "Unavailable" }));
  const result = await ashby.fetch(ctx("ashby"));
  assert.equal(result.jobs.length, 0);
  assert.match(result.errors[0].message, /HTTP 503/);
});
