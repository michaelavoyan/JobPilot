import type { Db } from "../../storage/db.ts";
import { listBoards } from "../../storage/db.ts";
import type { AgentState } from "./plan.ts";

export interface StateOptions {
  threshold: number;
  providerConfigured: boolean;
  /** Injected so the state can be tested without waiting a week. */
  now?: Date;
}

function daysBetween(from: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000);
}

/** Everything the planner is allowed to know, read from the database. */
export function agentState(db: Db, options: StateOptions): AgentState {
  const now = options.now ?? new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const matches = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores s
       LEFT JOIN decisions d ON d.job_id = s.job_id
       WHERE s.score >= ? AND s.scored_at >= ? AND d.job_id IS NULL`,
    )
    .get(options.threshold, weekAgo) as { n: number };

  const spend = db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS v FROM runs WHERE started >= ?")
    .get(monthAgo) as { v: number };

  const discovery = db
    .prepare("SELECT MAX(at) AS at FROM discovery_attempts")
    .get() as { at: string | null };

  return {
    boards: listBoards(db).length,
    matchesLast7: Number(matches.n ?? 0),
    spendLast30Usd: Number(spend.v ?? 0),
    providerConfigured: options.providerConfigured,
    daysSinceDiscovery: discovery.at ? daysBetween(discovery.at, now) : null,
  };
}
