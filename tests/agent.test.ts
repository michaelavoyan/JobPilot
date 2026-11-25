import { test } from "node:test";
import assert from "node:assert/strict";
import {
  latestBoardYield,
  open,
  policyHistory,
  recordAttempts,
  recordDecision,
  runHistory,
  saveScores,
  upsertBoards,
  upsertJobs,
} from "../src/storage/db.ts";
import { planDay, policyVersion } from "../src/engine/agent/plan.ts";
import type { AgentPolicy, AgentState } from "../src/engine/agent/plan.ts";
import { agentState } from "../src/engine/agent/state.ts";
import { executePlan } from "../src/engine/agent/execute.ts";
import type { Job } from "../src/engine/types.ts";

const policy: AgentPolicy = { monthlyCapUsd: 5, minMatchesPerWeek: 3, discoveryLimit: 10 };

function state(over: Partial<AgentState> = {}): AgentState {
  return {
    boards: 10,
    matchesLast7: 5,
    spendLast30Usd: 0,
    providerConfigured: true,
    daysSinceDiscovery: null,
    ...over,
  };
}

const kinds = (plan: ReturnType<typeof planDay>) => plan.actions.map((a) => a.kind);

test("a thin week sends it looking for companies", () => {
  const plan = planDay(state({ matchesLast7: 1 }), policy);
  assert.deepEqual(kinds(plan), ["discover", "collect", "score", "digest"]);
  assert.match(plan.actions[0].reason, /1 match\(es\) in 7 days/);
});

test("a healthy week does not waste discovery", () => {
  const plan = planDay(state({ matchesLast7: 4 }), policy);
  assert.deepEqual(kinds(plan), ["collect", "score", "digest"]);
  assert.ok(plan.notes.some((n) => /discovery skipped/.test(n)));
});

test("an empty directory discovers even when matches exist", () => {
  const plan = planDay(state({ boards: 0, matchesLast7: 9 }), policy);
  assert.equal(plan.actions[0].kind, "discover");
  assert.match(plan.actions[0].reason, /directory is empty/);
});

test("the monthly cap stops scoring but not collecting", () => {
  const plan = planDay(state({ spendLast30Usd: 5 }), policy);
  assert.deepEqual(kinds(plan), ["collect", "digest"]);
  assert.ok(plan.notes.some((n) => /cap/.test(n)));
});

test("no key means collect and digest only", () => {
  const plan = planDay(state({ providerConfigured: false }), policy);
  assert.deepEqual(kinds(plan), ["collect", "digest"]);
  assert.ok(plan.notes.some((n) => /no model key/.test(n)));
});

function job(id: string): Job {
  return {
    id,
    source: "test",
    company: "Acme",
    title: "Engineering Manager",
    url: "",
    locations: ["Tel Aviv"],
    remote: true,
    description: "Lead.",
    lang: "en",
    country: "IL",
  };
}

test("state counts undecided recent matches, spend and discovery age", () => {
  const db = open(":memory:");
  upsertBoards(db, [
    { ats: "greenhouse", ident: "a", name: "A" },
    { ats: "greenhouse", ident: "b", name: "B" },
  ]);
  upsertJobs(db, [job("m"), job("decided")]);
  saveScores(
    db,
    [
      { jobId: "m", track: "b", score: 80, reasons: [], flags: [] },
      { jobId: "decided", track: "b", score: 90, reasons: [], flags: [] },
    ],
    "m",
    "h",
  );
  recordDecision(db, "decided", "applied");
  db.prepare("INSERT INTO runs (id, started, cost_usd) VALUES (?, ?, ?)").run(
    "r1",
    new Date().toISOString(),
    0.75,
  );
  recordAttempts(db, ["Some Co"]);

  const s = agentState(db, { threshold: 65, providerConfigured: true });
  assert.equal(s.boards, 2);
  assert.equal(s.matchesLast7, 1, "the decided posting is not a match to chase");
  assert.equal(s.spendLast30Usd, 0.75);
  assert.equal(s.daysSinceDiscovery, 0);
});

test("executing a plan adds boards and calls each step once", async () => {
  const db = open(":memory:");
  const plans = { collect: 0, score: 0, digest: 0 };
  const result = await executePlan(
    db,
    planDay(state({ boards: 0 }), policy),
    policy,
    {
      discoverFromList: async () => ({
        names: 1,
        probed: 1,
        hits: [{ name: "New Co", source: "greenhouse", ident: "newco", openRoles: 4 }],
        checked: ["New Co"],
        errors: [],
      }),
      runCollect: async () => {
        plans.collect++;
        return { fetched: 3, inserted: 3, updated: 0, rescored: 0, errors: [], perSource: {} };
      },
      runScore: async () => {
        plans.score++;
        return {
          evaluated: 0, eligible: 0, scored: 2, failed: 0, tokensIn: 0, tokensOut: 0,
          costUsd: 0, rejectReasons: {},
        };
      },
      runDigest: async () => {
        plans.digest++;
        return { matches: 1, path: "out/x.md", pushed: false };
      },
      backup: () => "stub-backup",
    },
  );

  assert.equal(result.boardsAdded, 1);
  assert.equal(result.collected, 3);
  assert.equal(result.scored, 2);
  assert.equal(result.matches, 1);
  assert.deepEqual(plans, { collect: 1, score: 1, digest: 1 });

  const runs = runHistory(db);
  assert.equal(runs.length, 1, "an agent run is a run, visible to health");
  assert.equal(runs[0].scored, 2);
  assert.equal(runs[0].errors.length, 0);

  assert.equal(latestBoardYield(db).length, 1, "the run records what the board produced");

  const policies = policyHistory(db);
  assert.equal(policies.length, 1, "the plan and its result are recorded");
  assert.match(policies[0].plan, /"kind":"discover"/);
  assert.equal(policies[0].version, policyVersion(policy));
});

test("the policy fingerprint is stable and short", () => {
  assert.match(policyVersion(policy), /^[0-9a-f]{8}$/);
  assert.equal(policyVersion(policy), policyVersion({ ...policy }));
});

test("a failed plan is recorded as a run and a policy entry", async () => {
  const db = open(":memory:");

  await assert.rejects(
    () =>
      executePlan(db, planDay(state({ boards: 0 }), policy), policy, {
        discoverFromList: async () => {
          throw new Error("search offline");
        },
        backup: () => "stub-backup",
      }),
    /search offline/,
  );

  const [run] = runHistory(db);
  assert.match(run.errors[0].message, /search offline/);
  const [entry] = policyHistory(db);
  assert.match(String(entry.result), /search offline/);
});
