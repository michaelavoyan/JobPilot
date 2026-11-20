import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Db } from "../storage/db.ts";
import { funnelCounts, rejectSummary, scoreDistribution, stats, topScored } from "../storage/db.ts";
import { loadMarket, loadProfile, loadTracks } from "./config.ts";
import { numEnv, ROOT } from "./util.ts";

export function runsDir(): string {
  return resolve(ROOT, "runs");
}

/**
 * Every invocation leaves a JSON snapshot: the inputs it ran with, the rules
 * that filtered, and the results it produced. The database answers "what do I
 * know"; this answers "what did the last run see and decide".
 */
export function writeRunReport(
  db: Db,
  action: string,
  detail: Record<string, unknown> = {},
  dir = runsDir(),
): string {
  const now = new Date();
  const report: Record<string, unknown> = {
    action,
    started: now.toISOString(),
    options: collectOptions(),
    filters: collectFilters(db),
    results: collectResults(db),
    detail,
  };

  mkdirSync(dir, { recursive: true });
  const stamp =
    process.env.JOBPILOT_SESSION ?? now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = resolve(dir, `${stamp}-${action}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
  return file;
}

function collectOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = {
    market: null,
    profile: null,
    tracks: [],
    tuning: {
      minScore: numEnv("MIN_SCORE", 65),
      batchSize: numEnv("BATCH_SIZE", 6),
      concurrency: numEnv("LLM_CONCURRENCY", 2),
      maxDigestRows: numEnv("MAX_DIGEST_ROWS", 15),
    },
  };

  try {
    const m = loadMarket();
    options.market = {
      country: m.country,
      currency: m.currency,
      compPeriod: m.comp_period,
      sources: Object.entries(m.sources)
        .filter(([, v]) => v.enabled)
        .map(([name]) => name),
    };
  } catch {
    /* no market configured */
  }

  try {
    const p = loadProfile();
    options.profile = {
      years: p.experience.total_years,
      managementYears: p.experience.management_years,
      domains: p.domains,
      interests: p.interests,
      compFloor: p.comp_floor,
      commuteRadius: { cities: p.locations.allowed, regions: p.locations.regions },
      authorizationMustPass: p.authorization_must_pass,
    };
  } catch {
    /* no profile configured */
  }

  try {
    options.tracks = loadTracks()
      .filter((t) => t.enabled)
      .map((t) => ({
        key: t.key,
        label: t.label,
        titleInclude: t.title_include,
        titleExclude: t.title_exclude,
      }));
  } catch {
    /* no tracks configured */
  }

  return options;
}

function collectFilters(db: Db): Record<string, unknown> {
  let clearance: string[] = [];
  let remoteDeny: string[] = [];
  let titleTraps: string[] = [];
  try {
    const m = loadMarket();
    clearance = m.clearance_patterns;
    remoteDeny = m.remote_deny_regions;
    titleTraps = m.exclude_title_patterns;
  } catch {
    /* ignore */
  }

  return {
    rules: {
      title: "track include / exclude lists",
      seniorityTraps: titleTraps,
      clearancePatterns: clearance,
      remoteDenyRegions: remoteDeny,
      location: "commute radius, or remote unless region-denied",
      salaryFloor: "rejects below 85% of comp_floor when both are known",
    },
    rejections: rejectSummary(db, 30),
    scoresByTrack: scoreDistribution(db),
  };
}

function collectResults(db: Db): Record<string, unknown> {
  const matches = topScored(db, 0, 50).map((j) => ({
    id: j.id,
    score: j.score,
    track: j.track,
    company: j.company,
    title: j.title,
    locations: j.locations,
    remote: j.remote,
    url: j.url,
    reasons: j.reasons,
    flags: j.flags,
  }));

  return {
    counts: stats(db),
    funnel: funnelCounts(db),
    matches,
  };
}
