import type { Score } from "../types.ts";
import type { ScoreOutcome } from "./rerank.ts";

export interface MergedScores {
  scores: Score[];
  /** Mean distance between each sample and the merged score, in points. */
  spread: number;
  /** Postings that only one sample scored. */
  partial: number;
}

/**
 * Averages repeated scorings of the same postings.
 *
 * The model is not deterministic even at temperature 0: two identical runs of
 * the same 45 postings differed by up to 16 points. Averaging two samples
 * halves the variance, at twice the model cost, which is why the caller decides
 * how many samples to take.
 *
 * The reasons come from the sample nearest the average rather than being
 * concatenated, so the sentence a user reads belongs to the score they see.
 */
export function mergeScoreRuns(runs: Score[][]): MergedScores {
  if (!runs.length) return { scores: [], spread: 0, partial: 0 };

  const byKey = new Map<string, Score[]>();
  for (const run of runs) {
    for (const score of run) {
      const key = `${score.jobId}\u0000${score.track}`;
      const list = byKey.get(key);
      if (list) list.push(score);
      else byKey.set(key, [score]);
    }
  }

  let spreadTotal = 0;
  let partial = 0;
  const scores: Score[] = [];

  for (const samples of byKey.values()) {
    if (samples.length < runs.length) partial++;
    const mean = samples.reduce((sum, s) => sum + s.score, 0) / samples.length;
    const merged = Math.round(mean);

    // The sample closest to the mean supplies the wording; ties go to the first.
    let nearest = samples[0];
    for (const sample of samples) {
      if (Math.abs(sample.score - mean) < Math.abs(nearest.score - mean)) nearest = sample;
    }

    // Averaged over every sample, not just the chosen one: the point is how
    // much the model disagreed with itself.
    spreadTotal +=
      samples.reduce((sum, s) => sum + Math.abs(s.score - mean), 0) / samples.length;
    scores.push({
      jobId: nearest.jobId,
      track: nearest.track,
      score: merged,
      reasons: nearest.reasons,
      flags: nearest.flags,
    });
  }

  return {
    scores,
    spread: scores.length ? Math.round((spreadTotal / scores.length) * 10) / 10 : 0,
    partial,
  };
}

/**
 * Several complete runs of the same requests, as one outcome.
 *
 * Tokens and cost are summed because they were spent. A posting counts as
 * failed only when every run failed it: one bad batch should not discard the
 * work the other samples produced.
 */
export function combineScoreOutcomes(runs: ScoreOutcome[]): ScoreOutcome & { spread: number } {
  if (!runs.length) {
    return {
      scores: [],
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      allowanceUsd: 0,
      model: "",
      failed: [],
      learnedJobIds: new Set<string>(),
      spread: 0,
    };
  }
  if (runs.length === 1) {
    const [only] = runs;
    const merged = mergeScoreRuns([only.scores]);
    return { ...only, spread: merged.spread };
  }

  const merged = mergeScoreRuns(runs.map((r) => r.scores));
  const [first] = runs;

  return {
    scores: merged.scores,
    tokensIn: runs.reduce((sum, r) => sum + r.tokensIn, 0),
    tokensOut: runs.reduce((sum, r) => sum + r.tokensOut, 0),
    costUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
    allowanceUsd: runs.reduce((sum, r) => sum + r.allowanceUsd, 0),
    model: runs[runs.length - 1].model,
    failed: first.failed.filter((f) => runs.every((r) => r.failed.some((g) => g.job.id === f.job.id))),
    learnedJobIds: runs.reduce(
      (kept, r) => new Set([...kept].filter((id) => r.learnedJobIds.has(id))),
      new Set(first.learnedJobIds),
    ),
    spread: merged.spread,
  };
}
