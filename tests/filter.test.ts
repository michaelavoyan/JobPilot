import { test } from "node:test";
import assert from "node:assert/strict";
import { hardFilter } from "../src/filter/rules.ts";
import type { Market, Profile, Track } from "../src/config.ts";
import type { Job } from "../src/types.ts";

const profile: Profile = {
  name: "Test",
  country: "IL",
  experience: { total_years: 19, management_years: 9, max_team_size: 20 },
  domains: [],
  stack: [],
  ai_practice: [],
  people_management: [],
  comp_floor: null,
  authorization_must_pass: true,
  locations: {
    allowed: ["Tel Aviv", "Herzliya"],
    regions: ["מרכז"],
    remote_ok: true,
    hybrid_ok: true,
    onsite_only_ok: false,
  },
};

const market: Market = {
  country: "IL",
  currency: "ILS",
  comp_period: "month",
  sources: {},
  clearance_patterns: ["סיווג ביטחוני", "security clearance"],
  exclude_title_patterns: ["\\bintern\\b", "\\bjunior\\b", "\\bמתמחה\\b"],
  city_aliases: {},
  currency_markers: { ILS: ["₪", 'ש"ח'] },
  country_names: ["Israel"],
  remote_deny_regions: [],
};

const emTrack: Track = {
  key: "b_senior_em",
  label: "Senior EM",
  enabled: true,
  weight: 1,
  order: 1,
  brief: "",
  title_include: ["engineering manager", "team lead", "head of engineering"],
  title_exclude: ["vp ", "chief"],
};

function job(over: Partial<Job> = {}): Job {
  return {
    id: "x",
    source: "test",
    company: "Acme",
    title: "Engineering Manager, Mobile",
    url: "https://example.com",
    locations: ["Tel Aviv"],
    remote: false,
    description: "We are hiring an engineering manager for our mobile group. ".repeat(10),
    lang: "en",
    country: "IL",
    ...over,
  };
}

test("accepts a matching title in radius", () => {
  const v = hardFilter(job(), emTrack, profile, market);
  assert.equal(v.ok, true);
});

test("rejects a title outside the track", () => {
  const v = hardFilter(job({ title: "Sales Director" }), emTrack, profile, market);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "title_not_in_track");
});

test("business development is not mistaken for a development manager", () => {
  const strict = { ...emTrack, title_exclude: ["business development"] };
  const v = hardFilter(
    job({ title: "Business Development Manager" }),
    strict,
    profile,
    market,
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, "title_exclude:business development");
});

test("rejects a track-level exclusion", () => {
  const v = hardFilter(job({ title: "VP Engineering" }), emTrack, profile, market);
  assert.equal(v.ok, false);
  assert.equal(v.reason, "title_exclude:vp ");
});

test("rejects intern and junior titles", () => {
  assert.equal(hardFilter(job({ title: "Engineering Manager Intern" }), emTrack, profile, market).ok, false);
  assert.equal(hardFilter(job({ title: "Junior Engineering Manager" }), emTrack, profile, market).ok, false);
});

test("rejects security clearance requirements in Hebrew and English", () => {
  const he = hardFilter(job({ description: "נדרש סיווג ביטחוני בתוקף" }), emTrack, profile, market);
  assert.equal(he.ok, false);
  assert.equal(he.reason, "clearance_required");

  const en = hardFilter(job({ description: "Must hold a valid security clearance." }), emTrack, profile, market);
  assert.equal(en.ok, false);
});

test("clearance filter can be disabled", () => {
  const relaxed = { ...profile, authorization_must_pass: false };
  const v = hardFilter(job({ description: "נדרש סיווג ביטחוני" }), emTrack, relaxed, market);
  assert.equal(v.ok, true);
});

test("rejects out-of-radius on-site roles but keeps remote ones", () => {
  const far = hardFilter(job({ locations: ["Beer Sheva"] }), emTrack, profile, market);
  assert.equal(far.ok, false);
  assert.equal(far.reason, "location");

  const remote = hardFilter(job({ locations: ["Beer Sheva"], remote: true }), emTrack, profile, market);
  assert.equal(remote.ok, true);
});

test("with no commute radius, in-country on-site roles still pass", () => {
  const fresh = { ...profile, locations: { ...profile.locations, allowed: [], regions: [] } };
  const v = hardFilter(job({ locations: ["Beer Sheva, Israel"] }), emTrack, fresh, market);
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("location_unfiltered"));
});

test("with no commute radius, a foreign posting is still rejected", () => {
  const fresh = { ...profile, locations: { ...profile.locations, allowed: [], regions: [] } };
  const v = hardFilter(
    job({ locations: ["Austin, TX"] }),
    emTrack,
    fresh,
    market,
  );
  assert.equal(v.ok, false);
  assert.equal(v.reason, "location_country");
});

test("unknown location passes with a flag rather than a silent drop", () => {
  const v = hardFilter(job({ locations: [] }), emTrack, profile, market);
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("location_unclear"));
});

test("a remote role tied to another region is rejected", () => {
  const scoped = { ...market, remote_deny_regions: ["united states", "emea"] };
  const v = hardFilter(
    job({ remote: true, locations: ["Remote - United States"] }),
    emTrack,
    profile,
    scoped,
  );
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /^remote_region:/);
});

test("worldwide remote is accepted despite the deny list", () => {
  const scoped = { ...market, remote_deny_regions: ["united states"] };
  const v = hardFilter(
    job({ remote: true, locations: ["Remote - Worldwide"] }),
    emTrack,
    profile,
    scoped,
  );
  assert.equal(v.ok, true);
});

test("a remote role with no region stated is accepted", () => {
  const scoped = { ...market, remote_deny_regions: ["united states"] };
  const v = hardFilter(job({ remote: true, locations: ["Remote"] }), emTrack, profile, scoped);
  assert.equal(v.ok, true);
});

test("salary floor rejects only when both sides are known", () => {
  const withFloor = { ...profile, comp_floor: { amount: 50000, currency: "ILS", period: "month" as const } };

  const below = hardFilter(job({ comp: { amount: 30000, currency: "ILS", period: "month" } }), emTrack, withFloor, market);
  assert.equal(below.ok, false);
  assert.equal(below.reason, "comp_below_floor");

  const unknown = hardFilter(job({ comp: undefined }), emTrack, withFloor, market);
  assert.equal(unknown.ok, true);

  const above = hardFilter(job({ comp: { amount: 70000, currency: "ILS", period: "month" } }), emTrack, withFloor, market);
  assert.equal(above.ok, true);
});

test("flags thin descriptions instead of rejecting them", () => {
  const v = hardFilter(job({ description: "short" }), emTrack, profile, market);
  assert.equal(v.ok, true);
  assert.ok(v.flags.includes("insufficient_text"));
});
