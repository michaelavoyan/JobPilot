import { test } from "node:test";
import assert from "node:assert/strict";
import { funnelLines } from "../src/engine/report.ts";
import { isStage, STAGES } from "../src/storage/db.ts";

const counts = (spec: Record<string, number>) =>
  Object.entries(spec).map(([stage, n]) => ({ stage, n }));

test("funnel counts an interview as having reached applied", () => {
  const lines = funnelLines(counts({ applied: 5, screening: 2, interview: 1, offer: 1 }));
  const applied = lines.find((l) => l.startsWith("applied"));
  assert.match(applied!, /\b9\b/, "5 + 2 + 1 + 1 reach at least applied");
});

test("funnel reports conversion from applied to interview", () => {
  const lines = funnelLines(counts({ applied: 8, screening: 2, interview: 2, offer: 0 }));
  const interview = lines.find((l) => l.includes("interview"));
  // applied total = 12, interviews = 2 -> 17%
  assert.match(interview!, /17%/);
});

test("funnel reports offers as a share of everyone who reached interview", () => {
  const lines = funnelLines(counts({ interview: 3, offer: 1 }));
  const offer = lines.find((l) => l.trim().startsWith("offer"));
  // 3 still at interview, 1 already at offer -> 4 reached interview, 1 offer.
  assert.match(offer!, /25%/);
});

test("funnel shows a dash rather than dividing by zero", () => {
  const lines = funnelLines(counts({ shortlisted: 2, skipped: 4 }));
  assert.ok(lines.every((l) => !l.includes("NaN")));
  assert.ok(lines.every((l) => !l.includes("Infinity")));
});

test("funnel warns when the sample is too small", () => {
  const lines = funnelLines(counts({ applied: 3 }));
  assert.match(lines.join("\n"), /only 3 application/);
});

test("funnel stays quiet once ten applications exist", () => {
  const lines = funnelLines(counts({ applied: 10 }));
  assert.ok(!lines.join("\n").includes("only"));
});

test("stage values are validated", () => {
  for (const stage of STAGES) assert.equal(isStage(stage), true);
  assert.equal(isStage("hired"), false);
  assert.equal(isStage(""), false);
});
