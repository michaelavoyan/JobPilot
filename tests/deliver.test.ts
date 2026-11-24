import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDigest } from "../src/engine/deliver/digest.ts";
import { detect } from "../src/engine/discover.ts";
import type { Track } from "../src/engine/config.ts";
import type { ScoredJob } from "../src/engine/types.ts";

const tracks: Track[] = [
  { key: "a_director", label: "Director", enabled: true, weight: 0.9, order: 3, brief: "", title_include: [], title_exclude: [] },
  { key: "b_senior_em", label: "Senior EM", enabled: true, weight: 1, order: 1, brief: "", title_include: [], title_exclude: [] },
  { key: "c_ai_lead", label: "AI Lead", enabled: true, weight: 1.1, order: 2, brief: "", title_include: [], title_exclude: [] },
];

function scored(over: Partial<ScoredJob> = {}): ScoredJob {
  return {
    id: "1",
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "https://example.com",
    locations: ["Tel Aviv"],
    remote: false,
    description: "Great role.",
    lang: "en",
    country: "IL",
    track: "b_senior_em",
    score: 80,
    reasons: ["fits"],
    flags: [],
    ...over,
  };
}

test("digest groups by track order, not config order", () => {
  const md = renderDigest(
    [
      scored({ id: "1", track: "a_director", score: 70 }),
      scored({ id: "2", track: "b_senior_em", score: 80 }),
      scored({ id: "3", track: "c_ai_lead", score: 75 }),
    ],
    tracks,
    { minScore: 65, maxRows: 15 },
  );
  const b = md.indexOf("## Senior EM");
  const c = md.indexOf("## AI Lead");
  const a = md.indexOf("## Director");
  assert.ok(b >= 0 && c > b && a > c, "expected B, then C, then A");
});

test("a job that fits two tracks appears once, under its best score", () => {
  const md = renderDigest(
    [
      scored({ id: "1", track: "b_senior_em", score: 72 }),
      scored({ id: "1", track: "a_director", score: 81 }),
    ],
    tracks,
    { minScore: 65, maxRows: 15 },
  );
  assert.equal(md.match(/Acme · Engineering Manager/g)?.length, 1);
  assert.ok(md.includes("### 81"));
});

test("digest respects the row cap", () => {
  const jobs = Array.from({ length: 10 }, (_, i) =>
    scored({ id: String(i), score: 90 - i, company: `Co${i}` }),
  );
  const md = renderDigest(jobs, tracks, { minScore: 65, maxRows: 3 });
  assert.equal(md.match(/^\### /gm)?.length, 3);
});

test("empty digest explains what to do next", () => {
  const md = renderDigest([], tracks, { minScore: 90, maxRows: 15 });
  assert.ok(md.includes("No matches"));
});

test("digest renders a markdown link", () => {
  const md = renderDigest([scored()], tracks, { minScore: 65, maxRows: 15 });
  assert.ok(md.includes("[Apply](https://example.com)"));
});

test("detect parses the four supported ATS hosts", async () => {
  const gh = await detect("https://boards.greenhouse.io/acme", "Acme");
  assert.equal(gh.company.source, "greenhouse");
  assert.equal(gh.company.slug, "acme");

  const lever = await detect("https://jobs.lever.co/acme");
  assert.equal(lever.company.source, "lever");

  const ashby = await detect("https://jobs.ashbyhq.com/acme");
  assert.equal(ashby.company.source, "ashby");
});

test("detect refuses unsupported hosts with a clear message", async () => {
  await assert.rejects(
    () => detect("https://www.alljobs.co.il/"),
    /unsupported host/,
  );
});

test("machine flags are shown as words", () => {
  const md = renderDigest([scored({ flags: ["org_size_unclear", "aws_infra_gap"] })], tracks, {
    minScore: 65,
    maxRows: 15,
  });
  assert.match(md, /org size unclear/);
  assert.match(md, /aws infra gap/);
  assert.doesNotMatch(md, /org_size_unclear/);
});

test("the location is shown once, not once per spelling", () => {
  const md = renderDigest(
    [
      scored({
        locations: [
          "Tel Aviv-Yafo, Gush Dan, Israel",
          "Tel Aviv, Israel - HQ",
          "Tel Aviv-Yafo",
        ],
      }),
    ],
    tracks,
    { minScore: 65, maxRows: 15 },
  );
  assert.equal((md.match(/Tel Aviv-Yafo, Gush Dan/g) ?? []).length, 1);
  assert.doesNotMatch(md, /Israel - HQ/, "the other spellings are dropped");
});
