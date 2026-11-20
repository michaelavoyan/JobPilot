import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPositions } from "../src/engine/ingest/comeet.ts";
import type { Market } from "../src/engine/config.ts";

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

const company = { name: "Acme", source: "comeet", uid: "72.006", token: "t" };

// Shape taken from a live Careers API response: a top-level array, no
// `description` field, text inside `details`.
const payload = [
  {
    uid: "AA.123",
    name: "Mobile Team Lead",
    workplace_type: "Remote",
    location: { name: "Tel Aviv, Israel", city: "Tel Aviv", country: "IL" },
    url_active_page: "https://acme.com/job/1",
    time_updated: "2026-01-02T10:00:00Z",
    details: [
      { name: "Description", value: "<p>Lead the mobile group.</p>" },
      { name: "Requirements", value: "<ul><li>Kotlin</li></ul>" },
    ],
  },
  {
    uid: "AA.124",
    name: "מנהל פיתוח",
    workplace_type: "On-site",
    location: { name: "Herzliya", city: "Herzliya", country: "IL" },
    url_active_page: "",
    details: [],
  },
  { name: "", workplace_type: "Remote" },
];

test("mapPositions handles a top-level array", () => {
  const jobs = mapPositions(payload, company, market);
  assert.equal(jobs.length, 2, "the untitled posting is skipped");
  assert.equal(jobs[0].title, "Mobile Team Lead");
});

test("mapPositions reads descriptors from the details array", () => {
  const [job] = mapPositions(payload, company, market);
  assert.ok(job.description.includes("Lead the mobile group"));
  assert.ok(job.description.includes("Kotlin"));
  assert.ok(!job.description.includes("<p>"), "html must be stripped");
});

test("mapPositions maps workplace_type to remote", () => {
  const [remoteJob, onSite] = mapPositions(payload, company, market);
  assert.equal(remoteJob.remote, true);
  assert.equal(onSite.remote, false);
});

test("mapPositions keeps a Hebrew title and detects the language", () => {
  const [, hebrew] = mapPositions(payload, company, market);
  assert.equal(hebrew.title, "מנהל פיתוח");
  assert.ok(["he", "mixed", "und"].includes(hebrew.lang));
});

test("mapPositions falls back to a hosted URL", () => {
  const [, hebrew] = mapPositions(payload, company, market);
  assert.ok(hebrew.url.includes("AA.124"));
});

test("mapPositions tolerates an object-shaped response", () => {
  const jobs = mapPositions({ positions: payload.slice(0, 1) }, company, market);
  assert.equal(jobs.length, 1);
});

test("mapPositions returns nothing for an unexpected payload", () => {
  assert.equal(mapPositions(null, company, market).length, 0);
  assert.equal(mapPositions({ error: "nope" }, company, market).length, 0);
});
