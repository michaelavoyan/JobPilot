import { test } from "node:test";
import assert from "node:assert/strict";
import { precisionAt } from "../src/engine/report.ts";

const rows = (spec: [number, string][]) =>
  spec.map(([score, label], i) => ({ track: "b_senior_em", score, label, i }));

test("precision@10 counts applied and shortlisted as hits", () => {
  const data = rows([
    [90, "applied"],
    [85, "applied"],
    [80, "skipped"],
    [75, "shortlisted"],
    [70, "skipped"],
    [65, "skipped"],
    [60, "skipped"],
    [55, "skipped"],
    [50, "skipped"],
    [45, "skipped"],
  ]);
  assert.equal(precisionAt(data, "b_senior_em"), 0.3);
});

test("precision@10 only looks at the top ten", () => {
  const data = rows([
    [90, "skipped"],
    [89, "skipped"],
    [88, "skipped"],
    [87, "skipped"],
    [86, "skipped"],
    [85, "skipped"],
    [84, "skipped"],
    [83, "skipped"],
    [82, "skipped"],
    [81, "skipped"],
    [10, "applied"],
    [9, "applied"],
  ]);
  assert.equal(precisionAt(data, "b_senior_em"), 0);
});

test("precision uses fewer than ten when fewer are labelled", () => {
  const data = rows([
    [80, "applied"],
    [70, "skipped"],
  ]);
  assert.equal(precisionAt(data, "b_senior_em"), 0.5);
});

test("precision ignores other tracks", () => {
  const data = [
    { track: "a_director", score: 99, label: "applied" },
    { track: "b_senior_em", score: 50, label: "skipped" },
  ];
  assert.equal(precisionAt(data, "b_senior_em"), 0);
});

test("precision is null when a track has no labels", () => {
  assert.equal(precisionAt([], "b_senior_em"), null);
});

test("precision sorts by score, not insertion order", () => {
  const data = [
    { track: "b_senior_em", score: 40, label: "skipped" },
    { track: "b_senior_em", score: 90, label: "applied" },
  ];
  assert.equal(precisionAt(data, "b_senior_em"), 0.5);
});
