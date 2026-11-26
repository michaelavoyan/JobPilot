import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boardToCompany,
  buildQueries,
  displayName,
  inBands,
  parseAtsUrl,
  parseBands,
} from "../src/engine/discovery.ts";
import type { Market } from "../src/engine/config.ts";

const market: Market = {
  country: "IL",
  currency: "ILS",
  comp_period: "month",
  sources: {},
  clearance_patterns: [],
  exclude_title_patterns: [],
  city_aliases: { "תל אביב": "Tel Aviv", מרחוק: "Remote" },
  currency_markers: { ILS: ["₪"] },
  remote_deny_regions: [],
};

test("career URLs give up the ATS tenant", () => {
  assert.deepEqual(parseAtsUrl("https://jobs.lever.co/acme/1234"), { ats: "lever", slug: "acme" });
  assert.deepEqual(parseAtsUrl("https://boards.greenhouse.io/acme/jobs/1"), {
    ats: "greenhouse",
    slug: "acme",
  });
  assert.deepEqual(parseAtsUrl("https://job-boards.greenhouse.io/acme"), {
    ats: "greenhouse",
    slug: "acme",
  });
  assert.deepEqual(parseAtsUrl("https://jobs.ashbyhq.com/acme/abc"), { ats: "ashby", slug: "acme" });
});

test("a comeet URL yields the company UID, not the slug", () => {
  assert.deepEqual(parseAtsUrl("https://www.comeet.com/jobs/drivenets/72.006"), {
    ats: "comeet",
    uid: "72.006",
  });
  assert.deepEqual(parseAtsUrl("https://www.comeet.com/jobs/team8/5A.00A/x"), {
    ats: "comeet",
    uid: "5A.00A",
  });
});

test("non-ATS URLs are ignored", () => {
  assert.equal(parseAtsUrl("https://www.linkedin.com/jobs/view/123"), null);
  assert.equal(parseAtsUrl("https://example.com/careers"), null);
  assert.equal(parseAtsUrl("not a url"), null);
  assert.equal(parseAtsUrl("https://www.comeet.com/about"), null);
});

test("bands parse from the formats people type", () => {
  assert.deepEqual(parseBands("1-20,21-100"), [
    { min: 1, max: 20 },
    { min: 21, max: 100 },
  ]);
  assert.deepEqual(parseBands("500+"), [{ min: 500, max: Number.POSITIVE_INFINITY }]);
  assert.throws(() => parseBands("big"), /bad band/);
  assert.throws(() => parseBands(""), /no bands/);
});

test("a board is kept only when its open roles fall in a selected band", () => {
  const bands = parseBands("1-20,101-500");
  assert.equal(inBands(5, bands), true);
  assert.equal(inBands(20, bands), true);
  assert.equal(inBands(21, bands), false);
  assert.equal(inBands(200, bands), true);
  assert.equal(inBands(900, bands), false);
});

test("slug becomes a readable company name", () => {
  assert.equal(displayName("moon-active"), "Moon Active");
  assert.equal(displayName("snyk"), "Snyk");
  assert.equal(displayName("aidoc_medical"), "Aidoc Medical");
});

test("a remembered board becomes a collectable company", () => {
  assert.deepEqual(
    boardToCompany({ ats: "greenhouse", ident: "acme", name: "Acme" }),
    { name: "Acme", source: "greenhouse", slug: "acme" },
  );
  assert.deepEqual(boardToCompany({ ats: "lever", ident: "acme", name: "Acme" }), {
    name: "Acme",
    source: "lever",
    slug: "acme",
  });
  assert.deepEqual(boardToCompany({ ats: "ashby", ident: "acme", name: "Acme" }), {
    name: "Acme",
    source: "ashby",
    slug: "acme",
  });
});

test("a Comeet board keeps its token, which the API requires", () => {
  assert.deepEqual(
    boardToCompany({ ats: "comeet", ident: "72.006", token: "abc123", name: "Acme" }),
    { name: "Acme", source: "comeet", uid: "72.006", token: "abc123" },
  );
});

test("queries cover every ATS for every city", () => {
  const queries = buildQueries(market, ["Tel Aviv", "Herzliya"]);
  assert.equal(queries.length, 8);
  assert.ok(queries.some((q) => q === "jobs.lever.co Tel Aviv"));
  assert.ok(queries.some((q) => q === "comeet.com Herzliya"));
});
