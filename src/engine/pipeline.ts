import type { Db } from "../storage/db.ts";
import {
  dropScores,
  listBoards,
  finishRun,
  markEvaluated,
  recordRejects,
  recordLearningRun,
  attemptedNames,
  recordAttempts,
  saveScores,
  saveShadowScores,
  shadowedJobIds,
  startRun,
  stats,
  topScored,
  unscoredJobs,
  upsertBoards,
  upsertJobs,
} from "../storage/db.ts";
import { loadMarket, loadProfile, loadTracks, profileHash } from "./config.ts";
import { collect } from "./ingest/index.ts";
import { boardToCompany } from "./discovery.ts";
import { hardFilter } from "./filter/rules.ts";
import { combineScoreOutcomes } from "./score/merge.ts";
import { scoreJobs } from "./score/rerank.ts";
import type { ScoreRequest } from "./score/rerank.ts";
import { provider } from "./score/llm.ts";
import { discoverFromList } from "./discover-list.ts";
import { buildLearning, hasLearning, LEARNING_VERSION, renderLearning } from "./learn.ts";
import { renderDigest, writeDigest } from "./deliver/digest.ts";
import { pushTelegram } from "./deliver/telegram.ts";
import { numEnv, log, nowIso, warn } from "./util.ts";
import type { SourceError } from "./types.ts";

/**
 * The seams the run path is built from. Production passes nothing and gets the
 * real implementations; tests pass stubs, which is why this file can now be
 * exercised without a network, a model key or a real market.
 */
export interface PipelineDeps {
  collect: typeof collect;
  scoreJobs: typeof scoreJobs;
  provider: typeof provider;
  hardFilter: typeof hardFilter;
  loadMarket: typeof loadMarket;
  loadProfile: typeof loadProfile;
  loadTracks: typeof loadTracks;
  renderDigest: typeof renderDigest;
  writeDigest: typeof writeDigest;
  pushTelegram: typeof pushTelegram;
  discoverFromList: typeof discoverFromList;
}

const realDeps: PipelineDeps = {
  collect,
  scoreJobs,
  provider,
  hardFilter,
  loadMarket,
  loadProfile,
  loadTracks,
  renderDigest,
  writeDigest,
  pushTelegram,
  discoverFromList,
};

const withDeps = (overrides?: Partial<PipelineDeps>): PipelineDeps => ({
  ...realDeps,
  ...overrides,
});

export interface CollectSummary {
  fetched: number;
  inserted: number;
  updated: number;
  rescored: number;
  errors: SourceError[];
  perSource: Record<string, number>;
}

export async function runCollect(
  db: Db,
  deps: Partial<PipelineDeps> = {},
): Promise<CollectSummary> {
  const d = withDeps(deps);
  const market = d.loadMarket();

  // The tenant directory is the only source: filled by discovery, never edited
  // by hand.
  const companies = listBoards(db).map((board) => boardToCompany(board));

  if (!companies.length) {
    warn("the tenant directory is empty — nothing to collect.");
    warn('Run: npm run discover-web -- --bands "1-20"');
  }

  const { jobs, errors, perSource } = await d.collect(companies, market, db);
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

export async function runScore(
  db: Db,
  options: { rescore?: boolean } = {},
  deps: Partial<PipelineDeps> = {},
): Promise<ScoreSummary> {
  const d = withDeps(deps);
  const profile = d.loadProfile();
  const tracks = d.loadTracks().filter((t) => t.enabled);
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
  const market = d.loadMarket();

  for (const job of jobs) {
    const eligibleFor: string[] = [];
    for (const track of tracks) {
      const verdict = d.hardFilter(job, track, profile, market);
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

  if (!d.provider()) {
    warn("no LLM key configured — filtering only, nothing scored.");
    warn("set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env");
    return summary;
  }

  const learning = buildLearning(db, profile);
  // Constraints or preferences alone are learning too: a confirmed note must
  // reach the scorer even before there are enough labels for examples.
  const usingLearning = hasLearning(learning, tracks.map((t) => t.key));
  if (usingLearning) {
    const parts: string[] = [];
    if (learning.applied || learning.skipped) {
      parts.push(`${learning.applied} applied and ${learning.skipped} skipped postings`);
    }
    if (learning.constraints.length) {
      parts.push(`${learning.constraints.length} confirmed constraint(s)`);
    }
    log(`learning from ${parts.join(" and ")}`);
  }

  // One sample is the default. Two halves the model's run-to-run noise at
  // twice the cost, which is the user's trade to make, not a silent default.
  const samples = Math.min(3, Math.max(1, numEnv("SCORE_SAMPLES", 1)));
  const scoreOptions = {
    batchSize: numEnv("BATCH_SIZE", 6),
    concurrency: numEnv("LLM_CONCURRENCY", 2),
    learning: usingLearning ? learning : undefined,
  };

  const scoreWithSamples = async (
    reqs: typeof requests,
    opts: Parameters<typeof scoreJobs>[3],
  ) => {
    if (samples === 1) return d.scoreJobs(reqs, tracks, profile, opts);
    const runs = [];
    for (let i = 0; i < samples; i++) {
      runs.push(await d.scoreJobs(reqs, tracks, profile, opts));
    }
    return combineScoreOutcomes(runs);
  };

  const outcome = await scoreWithSamples(requests, scoreOptions);

  // A bounded shadow pass: the same postings scored without learning, so the
  // comparison in `eval` has something to compare against. Off unless enabled,
  // because it doubles the cost of the postings it touches. Only postings that
  // really were scored with learning are worth a baseline twin.
  const shadowCount = outcome.learnedJobIds.size ? numEnv("LEARNING_SHADOW", 0) : 0;
  if (shadowCount > 0 && outcome.scores.length) {
    // Prefer postings that have no baseline twin yet. Taking the first N every
    // run would shadow the same ten forever, and the comparison needs twenty
    // pairs before it may report an interval.
    const alreadyShadowed = new Set(shadowedJobIds(db, LEARNING_VERSION));
    const learnedRequests = requests.filter((r) => outcome.learnedJobIds.has(r.job.id));
    const shadowRequests = [
      ...learnedRequests.filter((r) => !alreadyShadowed.has(r.job.id)),
      ...learnedRequests.filter((r) => alreadyShadowed.has(r.job.id)),
    ].slice(0, shadowCount);
    if (shadowRequests.length) {
      const shadowOptions = {
        batchSize: numEnv("BATCH_SIZE", 6),
        concurrency: 1,
      };
      const baseline = await scoreWithSamples(shadowRequests, shadowOptions);

      if (baseline.scores.length) {
        saveShadowScores(db, baseline.scores, baseline.model, LEARNING_VERSION);
        log(`shadow-scored ${baseline.scores.length} posting(s) without learning`);
      }
    }
  }

  if (usingLearning && outcome.scores.length && !outcome.learnedJobIds.size) {
    warn(
      "nothing learned applies to the tracks in this batch; every score was written as baseline",
    );
  }

  if (outcome.scores.length) {
    // Split the run: a batch whose prompt carried no learned evidence is a
    // baseline score and must not be counted in the comparison.
    const learnedScores = outcome.scores.filter((s) => outcome.learnedJobIds.has(s.jobId));
    const baselineScores = outcome.scores.filter((s) => !outcome.learnedJobIds.has(s.jobId));
    if (baselineScores.length) {
      saveScores(db, baselineScores, outcome.model, pHash);
    }
    if (learnedScores.length) {
      saveScores(db, learnedScores, outcome.model, pHash, {
        variant: "learned",
        learningAt: nowIso(),
        version: LEARNING_VERSION,
      });
    }

    if (learnedScores.length) {
      // The exact block that reached the model, so a past score can be
      // explained rather than guessed at.
      recordLearningRun(db, {
        labels: learning.applied + learning.skipped,
        version: LEARNING_VERSION,
        payload: renderLearning(
          learning,
          tracks.map((t) => t.key),
        ),
      });
    }
  }
  if (samples > 1 && "spread" in outcome) {
    log(
      `averaged ${samples} samples · mean distance from the reported score ` +
        `${(outcome as { spread: number }).spread} points`,
    );
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

export async function runDigest(db: Db, deps: Partial<PipelineDeps> = {}): Promise<DigestSummary> {
  const d = withDeps(deps);
  const tracks = d.loadTracks().filter((t) => t.enabled);
  const minScore = numEnv("MIN_SCORE", 65);
  const maxRows = numEnv("MAX_DIGEST_ROWS", 15);

  const jobs = topScored(db, minScore, 200);
  const markdown = d.renderDigest(jobs, tracks, { minScore, maxRows });
  const path = d.writeDigest(markdown);
  const pushed = await d.pushTelegram(
    [...jobs].sort((a, b) => b.score - a.score).slice(0, 5),
    5,
  );

  log(`${jobs.length} match(es) at or above ${minScore}${pushed ? " · pushed to telegram" : ""}`);
  return { matches: jobs.length, path, pushed };
}

export async function runAll(
  db: Db,
  deps: Partial<PipelineDeps> = {},
): Promise<{
  collected: number;
  inserted: number;
  evaluated: number;
  eligible: number;
  scored: number;
  costUsd: number;
  matches: number;
  digest?: string;
}> {
  const d = withDeps(deps);
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
    // Optional: grow the directory before collecting, so a new board is used
    // in the same run. Names probed before are skipped, so this is a one-off
    // cost rather than a daily sweep of every company ever seen.
    if (numEnv("DISCOVER_ON_RUN", 0) > 0) {
      const boards = listBoards(db, false);
      const normName = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
      const skip = new Set([
        ...boards.map((b) => normName(b.name)),
        ...[...attemptedNames(db)].map(normName),
      ]);
      const found = await d.discoverFromList({
        limit: numEnv("DISCOVER_LIMIT", 40),
        skip,
      });
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
      log(`discovery: ${found.probed} company(ies) checked · ${fresh.length} new board(s)`);
    }

    const c = await runCollect(db, d);
    collected = c.fetched;
    inserted = c.inserted;
    errors = c.errors;

    const s = await runScore(db, {}, d);
    filtered = s.evaluated - s.eligible;
    evaluated = s.evaluated;
    eligible = s.eligible;
    scored = s.scored;
    tokensIn = s.tokensIn;
    tokensOut = s.tokensOut;
    costUsd = s.costUsd;

    const digest = await runDigest(db, d);
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
