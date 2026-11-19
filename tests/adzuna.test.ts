import { test } from "node:test";
import assert from "node:assert/strict";
import { mapResults } from "../src/ingest/adzuna.ts";
import type { Market } from "../src/config.ts";

const market: Market = {
  country: "US",
  currency: "USD",
  comp_period: "year",
  sources: {},
  clearance_patterns: [],
  exclude_title_patterns: [],
  city_aliases: {},
  currency_markers: { USD: ["$"] },
  remote_deny_regions: [],
  adzuna_country: "us",
};

const payload = {
  count: 2,
  results: [
    {
      title: "Engineering Manager, Mobile",
      company: { display_name: "Acme" },
      location: { display_name: "New York, NY" },
      redirect_url: "https://adzuna.example/1",
      description: "Lead a mobile team.",
      created: "2026-11-01T10:00:00Z",
      salary_min: 180000,
      salary_max: 220000,
    },
    {
      title: "Team Lead",
      company: { display_name: "Remote Co" },
      location: { display_name: "Remote" },
      redirect_url: "https://adzuna.example/2",
      description: "Fully distributed team.",
    },
    { title: "" },
  ],
};

test("mapResults maps the country feed into jobs", () => {
  const jobs = mapResults(payload, market);
  assert.equal(jobs.length, 2, "an untitled posting is skipped");
  assert.equal(jobs[0].title, "Engineering Manager, Mobile");
  assert.equal(jobs[0].company, "Acme");
  assert.deepEqual(jobs[0].locations, ["New York, NY"]);
  assert.equal(jobs[0].url, "https://adzuna.example/1");
});

test("mapResults turns an annual salary range into compensation", () => {
  const [job] = mapResults(payload, market);
  assert.equal(job.comp?.amount, 180000, "the lower bound is used");
  assert.equal(job.comp?.currency, "USD");
  assert.equal(job.comp?.period, "year");
});

test("mapResults detects a remote posting from its location", () => {
  const jobs = mapResults(payload, market);
  assert.equal(jobs[1].remote, true);
  assert.equal(jobs[0].remote, false);
});

test("mapResults ignores a salary that is not a real figure", () => {
  const tiny = mapResults(
    { results: [{ title: "Lead", company: { display_name: "X" }, salary_min: 5 }] },
    market,
  );
  assert.equal(tiny[0].comp, undefined);
});

test("mapResults tolerates a payload with no results", () => {
  assert.equal(mapResults({}, market).length, 0);
  assert.equal(mapResults(null, market).length, 0);
});

test("jobs carry the market country", () => {
  const [job] = mapResults(payload, market);
  assert.equal(job.country, "US");
});
