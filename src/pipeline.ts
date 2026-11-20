import type { Db } from "./store/db.ts";
import {
  dropScores,
  listBoards,
  finishRun,
  markEvaluated,
  recordRejects,
  saveScores,
  startRun,
  stats,
  topScored,
  unscoredJobs,
  upsertJobs,
} from "./store/db.ts";
import { loadMarket, loadProfile, loadTracks, profileHash } from "./config.ts";
import { collect } from "./ingest/index.ts";
import { boardToCompany } from "./discovery.ts";
import { hardFilter } from "./filter/rules.ts";
import { scoreJobs } from "./score/rerank.ts";
import type { ScoreRequest } from "./score/rerank.ts";
import { provider } from "./score/llm.ts";
import { renderDigest, writeDigest } from "./deliver/digest.ts";
import { pushTelegram } from "./deliver/telegram.ts";
import { numEnv, log, warn } from "./util.ts";
import type { SourceError } from "./types.ts";

export interface CollectSummary {
  fetched: number;
  inserted: number;
  updated: number;
  rescored: number;
  errors: SourceError[];
  perSource: Record<string, number>;
}

export async function runCollect(db: Db): Promise<CollectSummary> {
  const market = loadMarket();

  // The tenant directory is the only source: filled by discovery, never edited
  // by hand.
  const companies = listBoards(db).map((board) => boardToCompany(board));

  if (!companies.length) {
    warn("the tenant directory is empty — nothing to collect.");
    warn('Run: npm run discover-web -- --bands "1-20"');
  }

  const { jobs, errors, perSource } = await collect(companies, market, db);
  const { inserted, updated, rescored } = upsertJobs(db, jobs);

  log(`collected ${jobs.length} postings from ${Object.keys(perSource).length} source(s)`);
  for (const [name, count] of Object.entries(perSource)) {
    log(`  ${name.padEnd(12)} ${count}`);
  }
  log(`  new ${inserted} · updated ${updated} · needs re-score ${rescored}`);

  if (errors.length) {
    warn(`${errors.length} source error(s):`);
    for (const e of errors.slice(0, 10)) warn(`  ${e.source}: ${e.message}`);
  }

  return { fetched: jobs.length, inserted, updated, rescored, errors, perSource };
}

export interface ScoreSummary {
  evaluated: number;
  eligible: number;
  scored: number;
  failed: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  rejectReasons: Record<string, number>;
}

export async function runScore(db: Db, options: { rescore?: boolean } = {}): Promise<ScoreSummary> {
  const profile = loadProfile();
  const tracks = loadTracks().filter((t) => t.enabled);
  const pHash = profileHash(profile, tracks);

  // Editing profile.yaml or tracks.yaml invalidates stored scores by design.
  const cleared = db.prepare("DELETE FROM scores WHERE profile_hash != ?").run(pHash);
  if (Number(cleared.changes) > 0) {
    log(`profile or tracks changed — re-scoring ${cleared.changes} posting(s)`);
    db.exec("UPDATE jobs SET evaluated = 0 WHERE id NOT IN (SELECT job_id FROM scores)");
  }
  if (options.rescore) {
    const cleared = db.prepare("DELETE FROM rejects").run();
    db.exec("UPDATE jobs SET evaluated = 0");
    log(`--rescore: cleared ${cleared.changes} rejection record(s), queueing every posting`);
  }

  const jobs = unscoredJobs(db, 1_000_000);

  const summary: ScoreSummary = {
    evaluated: jobs.length,
    eligible: 0,
    scored: 0,
    failed: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    rejectReasons: {},
  };

  if (!jobs.length) {
    log("nothing new to score");
    return summary;
  }

  const requests: ScoreRequest[] = [];
  const rejects: { jobId: string; track: string; reason: string }[] = [];
  const staleTracks: { jobId: string; track: string }[] = [];
  const market = loadMarket();

  for (const job of jobs) {
    const eligibleFor: string[] = [];
    for (const track of tracks) {
      const verdict = hardFilter(job, track, profile, market);
      if (verdict.ok) {
        eligibleFor.push(track.key);
      } else {
        const reason = verdict.reason ?? "filtered";
        rejects.push({ jobId: job.id, track: track.key, reason });
        staleTracks.push({ jobId: job.id, track: track.key });
        summary.rejectReasons[reason] = (summary.rejectReasons[reason] ?? 0) + 1;
      }
    }
    if (eligibleFor.length) {
      requests.push({ job, tracks: eligibleFor });
      summary.eligible++;
    }
  }

  recordRejects(db, rejects);
  dropScores(db, staleTracks);
  markEvaluated(
    db,
    jobs.map((j) => j.id),
  );

  log(
    `evaluated ${summary.evaluated} posting(s) · ${summary.eligible} passed the filters · ${rejects.length} rejection(s)`,
  );
  const topReasons = Object.entries(summary.rejectReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  for (const [reason, n] of topReasons) log(`  ${reason.padEnd(28)} ${n}`);

  if (!requests.length) return summary;

  if (!provider()) {
    warn("no LLM key configured — filtering only, nothing scored.");
    warn("set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env");
    return summary;
  }

  const outcome = await scoreJobs(requests, tracks, profile, {
    batchSize: numEnv("BATCH_SIZE", 6),
    concurrency: numEnv("LLM_CONCURRENCY", 2),
  });

  if (outcome.scores.length) {
    saveScores(db, outcome.scores, outcome.model, pHash);
  }
  summary.scored = new Set(outcome.scores.map((s) => s.jobId)).size;
  summary.failed = outcome.failed.length;
  summary.tokensIn = outcome.tokensIn;
  summary.tokensOut = outcome.tokensOut;
  summary.costUsd = outcome.costUsd;

  const costNote =
    outcome.allowanceUsd > 0
      ? `$${outcome.allowanceUsd.toFixed(4)} of plan allowance`
      : `~$${outcome.costUsd.toFixed(3)}`;

  log(
    `scored ${summary.scored} posting(s)${summary.failed ? `, ${summary.failed} failed` : ""} ` +
      `· ${outcome.tokensIn + outcome.tokensOut} tokens · ${costNote}`,
  );
  for (const f of outcome.failed.slice(0, 5)) warn(`  ${f.job.company} — ${f.job.title}: ${f.reason}`);

  return summary;
}

export interface DigestSummary {
  matches: number;
  path?: string;
  pushed: boolean;
}

export async function runDigest(db: Db): Promise<DigestSummary> {
  const tracks = loadTracks().filter((t) => t.enabled);
  const minScore = numEnv("MIN_SCORE", 65);
  const maxRows = numEnv("MAX_DIGEST_ROWS", 15);

  const jobs = topScored(db, minScore, 200);
  const markdown = renderDigest(jobs, tracks, { minScore, maxRows });
  const path = writeDigest(markdown);
  const pushed = await pushTelegram(
    [...jobs].sort((a, b) => b.score - a.score).slice(0, 5),
    5,
  );

  log(`${jobs.length} match(es) at or above ${minScore}${pushed ? " · pushed to telegram" : ""}`);
  return { matches: jobs.length, path, pushed };
}

export async function runAll(db: Db): Promise<{
  collected: number;
  inserted: number;
  evaluated: number;
  eligible: number;
  scored: number;
  costUsd: number;
  matches: number;
  digest?: string;
}> {
  const runId = startRun(db);
  let collected = 0;
  let inserted = 0;
  let filtered = 0;
  let evaluated = 0;
  let eligible = 0;
  let scored = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let errors: SourceError[] = [];
  let digestMatches = 0;
  let digestPath: string | undefined;

  try {
    const c = await runCollect(db);
    collected = c.fetched;
    inserted = c.inserted;
    errors = c.errors;

    const s = await runScore(db);
    filtered = s.evaluated - s.eligible;
    evaluated = s.evaluated;
    eligible = s.eligible;
    scored = s.scored;
    tokensIn = s.tokensIn;
    tokensOut = s.tokensOut;
    costUsd = s.costUsd;

    const digest = await runDigest(db);
    digestMatches = digest.matches;
    digestPath = digest.path;

    const st = stats(db);
    log(
      `\nrun complete · ${st.jobs} postings known · ${st.scored} scores · ${st.decisions} labelled`,
    );
  } catch (err) {
    warn(`run failed: ${(err as Error).message}`);
    finishRun(db, runId, {
      collected,
      newJobs: inserted,
      filtered,
      scored,
      tokensIn,
      tokensOut,
      costUsd,
      errors: [...errors, { source: "run", message: (err as Error).message }],
    });
    throw err;
  }

  finishRun(db, runId, {
    collected,
    newJobs: inserted,
    filtered,
    scored,
    tokensIn,
    tokensOut,
    costUsd,
    errors,
  });

  return {
    collected,
    inserted,
    evaluated,
    eligible,
    scored,
    costUsd,
    matches: digestMatches,
    digest: digestPath,
  };
}
