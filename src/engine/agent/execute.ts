import type { Db } from "../../storage/db.ts";
import {
  attemptedNames,
  finishRun,
  listBoards,
  recordAttempts,
  recordPolicyRun,
  startRun,
  upsertBoards,
} from "../../storage/db.ts";
import { discoverFromList } from "../discover-list.ts";
import { runCollect, runDigest, runScore } from "../pipeline.ts";
import { join } from "node:path";
import { backupDatabase } from "../../storage/backup.ts";
import { configDir, log } from "../util.ts";
import { policyVersion } from "./plan.ts";
import type { AgentPolicy, Plan } from "./plan.ts";

export interface AgentDeps {
  discoverFromList: typeof discoverFromList;
  runCollect: typeof runCollect;
  runScore: typeof runScore;
  runDigest: typeof runDigest;
  backup: (db: Db) => string;
}

export interface AgentResult {
  boardsAdded: number;
  collected: number;
  scored: number;
  matches: number;
}

const real: AgentDeps = {
  discoverFromList,
  runCollect,
  runScore,
  runDigest,
  backup: (db) => backupDatabase(db, join(configDir(), "backups")),
};

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Execute a plan with the existing commands. No new behaviour lives here:
 * every step is a function the CLI already exposed, and the result is recorded
 * as a run plus a policy row so a plan can be read back later.
 */
export async function executePlan(
  db: Db,
  plan: Plan,
  policy: AgentPolicy,
  deps: Partial<AgentDeps> = {},
): Promise<AgentResult> {
  const d = { ...real, ...deps };
  const result: AgentResult = { boardsAdded: 0, collected: 0, scored: 0, matches: 0 };
  const runId = startRun(db);
  log(`backup: ${d.backup(db)}`);
  let newJobs = 0;
  let filtered = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;

  try {
    for (const action of plan.actions) {
      if (action.kind === "discover") {
        const boards = listBoards(db, false);
        const skip = new Set([
          ...boards.map((b) => norm(b.name)),
          ...[...attemptedNames(db)].map(norm),
        ]);
        const found = await d.discoverFromList({ limit: policy.discoveryLimit, skip });
        const fresh = found.hits.filter(
          (h) => !boards.some((b) => b.ats === h.source && b.ident === h.ident),
        );
        if (fresh.length) {
          upsertBoards(
            db,
            fresh.map((h) => ({ ats: h.source, ident: h.ident, name: h.name })),
          );
        }
        recordAttempts(db, found.checked);
        result.boardsAdded = fresh.length;
      } else if (action.kind === "collect") {
        const summary = await d.runCollect(db);
        result.collected = summary.fetched;
        newJobs = summary.inserted;
      } else if (action.kind === "score") {
        const summary = await d.runScore(db);
        result.scored = summary.scored;
        filtered = summary.evaluated - summary.eligible;
        tokensIn = summary.tokensIn;
        tokensOut = summary.tokensOut;
        costUsd = summary.costUsd;
      } else {
        result.matches = (await d.runDigest(db)).matches;
      }
    }

    finishRun(db, runId, {
      collected: result.collected,
      newJobs,
      filtered,
      scored: result.scored,
      tokensIn,
      tokensOut,
      costUsd,
    });
    recordPolicyRun(db, {
      version: policyVersion(policy),
      plan: JSON.stringify(plan),
      result: JSON.stringify(result),
      runId,
    });
    return result;
  } catch (err) {
    finishRun(db, runId, {
      collected: result.collected,
      newJobs,
      filtered,
      scored: result.scored,
      tokensIn,
      tokensOut,
      costUsd,
      errors: [{ source: "agent", message: (err as Error).message }],
    });
    throw err;
  }
}
