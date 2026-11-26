import type { Db } from "../../storage/db.ts";
import {
  attemptedNames,
  finishRun,
  listBoards,
  recordAttempts,
  recordBoardYield,
  recordPolicyRun,
  startRun,
  upsertBoards,
} from "../../storage/db.ts";
import { discoverFromList } from "../discover-list.ts";
import { discoverCompanies, marketCities, parseBands, searchConfigured } from "../discovery.ts";
import { loadMarket } from "../config.ts";
import { runCollect, runDigest, runScore } from "../pipeline.ts";
import { join } from "node:path";
import { backupDatabase } from "../../storage/backup.ts";
import { configDir, env, log, nowIso, numEnv } from "../util.ts";
import { policyVersion } from "./plan.ts";
import type { AgentPolicy, Plan } from "./plan.ts";

export interface AgentDeps {
  discoverFromList: typeof discoverFromList;
  discoverCompanies: typeof discoverCompanies;
  searchConfigured: typeof searchConfigured;
  loadMarket: typeof loadMarket;
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
  discoverCompanies,
  searchConfigured,
  loadMarket,
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
  const startedAt = nowIso();
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

        if (d.searchConfigured()) {
          // Search finds companies by query. It is the precise path and the
          // only one that can reach boards the public lists do not name.
          const market = d.loadMarket();
          const found = await d.discoverCompanies({
            market,
            cities: marketCities(market),
            bands: parseBands(env("AGENT_BANDS") ?? "1-20,21-100"),
            maxQueries: numEnv("AGENT_MAX_QUERIES", 40),
            maxBoards: policy.discoveryLimit,
          });
          const fresh = found.boards.filter(
            (b) => !boards.some((x) => x.ats === b.ats && x.ident === (b.slug ?? b.uid)),
          );
          if (fresh.length) {
            upsertBoards(
              db,
              fresh.map((b) => ({
                ats: b.ats,
                ident: b.slug ?? b.uid!,
                token: b.token,
                name: b.name,
                openRoles: b.openRoles,
              })),
            );
          }
          result.boardsAdded = fresh.length;
          log(
            `discovery: ${found.stats.queries} queries · ${found.stats.inBands} in band · ` +
              `${fresh.length} new board(s)`,
          );
          for (const error of found.errors.slice(0, 3)) log(`  ${error}`);
        } else {
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
        }
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

    const yields = recordBoardYield(db, {
      at: nowIso(),
      runStart: startedAt,
      threshold: numEnv("MIN_SCORE", 65),
      scored: result.scored > 0,
    });
    if (yields.retired.length) {
      log(`retired ${yields.retired.length} board(s): ${yields.retired.slice(0, 5).join(", ")}`);
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
    const yields = recordBoardYield(db, {
      at: nowIso(),
      runStart: startedAt,
      threshold: numEnv("MIN_SCORE", 65),
      scored: result.scored > 0,
    });
    if (yields.retired.length) {
      log(`retired ${yields.retired.length} board(s): ${yields.retired.slice(0, 5).join(", ")}`);
    }

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
    // A failed plan is still a decision worth explaining later.
    recordPolicyRun(db, {
      version: policyVersion(policy),
      plan: JSON.stringify(plan),
      result: JSON.stringify({ error: (err as Error).message, ...result }),
      runId,
    });
    throw err;
  }
}
