import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyNote, describeConstraint } from "../src/engine/notes.ts";

const kinds = (note: string) => classifyNote(note).map((c) => c.kind);

test("a long commute is read as a location penalty", () => {
  assert.deepEqual(kinds("too far, the commute is brutal"), ["location_penalty"]);
});

test("a Hebrew note about travel is read the same way", () => {
  assert.deepEqual(kinds("רחוק לי, הרבה נסיעות"), ["location_penalty"]);
});

test("seniority is only inferred from an explicit statement", () => {
  assert.deepEqual(kinds("too junior for me"), ["seniority_penalty"]);
  assert.deepEqual(kinds("this is a step down"), ["seniority_penalty"]);
});

test("hands-on is read as such, and a plain title is not", () => {
  assert.deepEqual(kinds("wanted hands-on coding, not for me"), ["hands_on_penalty"]);
  assert.deepEqual(kinds("Mobile Team Lead"), [], "a job title is not a note about one");
});

test("a domain named in a rejection becomes a domain constraint", () => {
  const found = classifyNote("no more adtech");
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "domain_penalty");
  assert.equal(found[0].value, "adtech");
});

test("a domain that is not in the list is not invented", () => {
  assert.deepEqual(classifyNote("no more spreadsheets"), []);
});

test("plain approval states no constraint", () => {
  assert.deepEqual(classifyNote("great fit, applied"), []);
  assert.deepEqual(classifyNote(""), []);
});

test("one note can yield more than one constraint", () => {
  const found = kinds("too far, and I don't want adtech");
  assert.ok(found.includes("location_penalty"));
  assert.ok(found.includes("domain_penalty"));
});

test("the same note does not produce the same constraint twice", () => {
  const found = kinds("too far and the commute is long");
  assert.deepEqual(found, ["location_penalty"]);
});

test("constraints read as directions, not field names", () => {
  assert.match(describeConstraint("location_penalty"), /far away/);
  assert.match(describeConstraint("domain_penalty", "adtech"), /adtech/);
  assert.doesNotMatch(describeConstraint("domain_penalty", "adtech"), /_/);
});
