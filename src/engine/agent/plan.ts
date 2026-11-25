/**
 * The daily plan, as a pure function.
 *
 * No model is consulted: a controller that can be read, replayed and tested is
 * worth more than one that can only be described. Every action carries the
 * reason it was chosen, so yesterday's decision can be explained today.
 */

import { createHash } from "node:crypto";

export interface AgentPolicy {
  monthlyCapUsd: number;
  minMatchesPerWeek: number;
  discoveryLimit: number;
}

export interface AgentState {
  boards: number;
  /** Postings at or above the threshold, undecided, scored in the last 7 days. */
  matchesLast7: number;
  spendLast30Usd: number;
  providerConfigured: boolean;
  /** Null when discovery has never run. */
  daysSinceDiscovery: number | null;
}

export type ActionKind = "discover" | "collect" | "score" | "digest";

export interface PlannedAction {
  kind: ActionKind;
  reason: string;
}

export interface Plan {
  actions: PlannedAction[];
  notes: string[];
}

export function planDay(state: AgentState, policy: AgentPolicy): Plan {
  const actions: PlannedAction[] = [];
  const notes: string[] = [];

  const thin = state.matchesLast7 < policy.minMatchesPerWeek;

  if (state.boards === 0) {
    actions.push({
      kind: "discover",
      reason: "the directory is empty; collecting has nothing to read",
    });
  } else if (thin) {
    actions.push({
      kind: "discover",
      reason: `${state.matchesLast7} match(es) in 7 days, below ${policy.minMatchesPerWeek}`,
    });
  } else {
    notes.push(
      `discovery skipped: ${state.matchesLast7} match(es) in 7 days is enough for now`,
    );
  }

  actions.push({ kind: "collect", reason: "new postings since the last run" });

  const overBudget = state.spendLast30Usd >= policy.monthlyCapUsd;
  if (!state.providerConfigured) {
    notes.push("no model key: collecting and digesting existing scores only");
  } else if (overBudget) {
    notes.push(
      `spend $${state.spendLast30Usd.toFixed(2)} reached the $${policy.monthlyCapUsd.toFixed(2)} cap: scoring skipped`,
    );
  } else {
    actions.push({ kind: "score", reason: "survivors of the filters are scored" });
  }

  actions.push({ kind: "digest", reason: "the shortlist is always written" });
  return { actions, notes };
}

/** A fingerprint of the rules, so a plan can be attributed to a policy. */
export function policyVersion(policy: AgentPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify({ cap: policy.monthlyCapUsd, min: policy.minMatchesPerWeek, limit: policy.discoveryLimit }))
    .digest("hex")
    .slice(0, 8);
}
