import type { Db } from "../storage/db.ts";
import {
  decisions,
  funnelCounts,
  rejectSummary,
  scoreDistribution,
  shadowPairs,
  staleShadowPairs,
  stats,
} from "../storage/db.ts";
import type { Track } from "./config.ts";
import { LEARNING_VERSION } from "./learn.ts";
import { log } from "./util.ts";

type Row = Record<string, unknown>;

/**
 * Funnel arithmetic, kept pure so the rates can be tested without a database.
 * "Reached stage X" counts everything at or past X, because a posting that got
 * an interview also got an application.
 */
export function funnelLines(counts: { stage: string; n: number }[]): string[] {
  const at = (stage: string) => counts.find((c) => c.stage === stage)?.n ?? 0;
  const appliedPlus = at("applied") + at("screening") + at("interview") + at("offer");
  const screeningPlus = at("screening") + at("interview") + at("offer");
  const interviewPlus = at("interview") + at("offer");
  const offerPlus = at("offer");

  const pct = (part: number, whole: number) =>
    whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;

  const lines: string[] = [];
  lines.push(`shortlisted      ${at("shortlisted")}`);
  lines.push(`applied          ${appliedPlus}`);
  if (appliedPlus) {
    lines.push(`  screening      ${screeningPlus}   (${pct(screeningPlus, appliedPlus)} of applied)`);
    lines.push(`  interview      ${interviewPlus}   (${pct(interviewPlus, appliedPlus)} of applied)`);
    lines.push(`  offer          ${offerPlus}   (${pct(offerPlus, interviewPlus)} of interviews)`);
  }
  lines.push(`rejected         ${at("rejected")}`);
  lines.push(`skipped          ${at("skipped")}`);

  if (appliedPlus < 10) {
    lines.push("");
    lines.push(`only ${appliedPlus} application(s) logged — rates stabilise around 10`);
  }
  return lines;
}

export function printStats(db: Db, tracks: Track[]): void {
  const s = stats(db);
  log(`postings known     ${s.jobs}`);
  log(`postings active    ${s.active}`);
  log(`scores stored      ${s.scored}`);
  log(`rejections logged  ${s.rejects}`);
  log(`labels             ${s.decisions}`);

  const dist = scoreDistribution(db);
  if (dist.length) {
    log("\nscores by track:");
    for (const track of tracks) {
      const rows = dist.filter((d) => d.track === track.key);
      if (!rows.length) continue;
      const total = rows.reduce((a, r) => a + r.n, 0);
      const line = rows
        .map((r) => `${r.bucket}-${r.bucket + 9}:${r.n}`)
        .join("  ");
      log(`  ${track.key.padEnd(12)} n=${String(total).padEnd(4)} ${line}`);
    }
  }

  const rejects = rejectSummary(db, 10);
  if (rejects.length) {
    log("\ntop rejection reasons (why postings were dropped):");
    for (const r of rejects) log(`  ${r.reason.padEnd(28)} ${r.n}`);
  }
}

/**
 * Probability that a random positive outranks a random negative.
 * Returns undefined unless both classes exist — an AUC of one class is 0.5 by
 * definition and says nothing.
 */
export function auc(positives: number[], negatives: number[]): number | undefined {
  if (!positives.length || !negatives.length) return undefined;
  let wins = 0;
  let ties = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p > n) wins++;
      else if (p === n) ties++;
    }
  }
  return (wins + 0.5 * ties) / (positives.length * negatives.length);
}

/** Deterministic PRNG, so a reported interval is reproducible. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bootstrapAuc(
  positives: number[],
  negatives: number[],
  iterations = 400,
  seed = 42,
): { low: number; high: number } | undefined {
  if (!positives.length || !negatives.length) return undefined;
  const random = seeded(seed);
  const draw = (values: number[]) =>
    Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const value = auc(draw(positives), draw(negatives));
    if (value !== undefined) samples.push(value);
  }
  if (!samples.length) return undefined;
  samples.sort((a, b) => a - b);
  return {
    low: samples[Math.floor(samples.length * 0.025)],
    high: samples[Math.floor(samples.length * 0.975)],
  };
}

export interface ShadowPair {
  jobId: string;
  learned: number;
  baseline: number;
  label?: string;
}

/** Learned against baseline, on the postings that were scored both ways. */
export function shadowStats(pairs: ShadowPair[]): {
  n: number;
  labelled: number;
  meanDelta: number;
  agreement: number;
  aucLearned?: number;
  aucBaseline?: number;
  aucCi?: { low: number; high: number };
  /** Of the best few labelled postings under each variant, how many were applied to. */
  precision?: { k: number; learned: number; baseline: number };
} {
  if (!pairs.length) {
    return { n: 0, labelled: 0, meanDelta: 0, agreement: 0 };
  }

  const delta = pairs.reduce((sum, p) => sum + (p.learned - p.baseline), 0) / pairs.length;
  const agreement =
    pairs.filter((p) => Math.abs(p.learned - p.baseline) <= 5).length / pairs.length;

  const labelled = pairs.filter((p) => p.label);
  const positives = labelled.filter((p) => p.label === "applied" || p.label === "shortlisted");
  const negatives = labelled.filter((p) => p.label === "skipped");

  const learnedPos = positives.map((p) => p.learned);
  const learnedNeg = negatives.map((p) => p.learned);
  const basePos = positives.map((p) => p.baseline);
  const baseNeg = negatives.map((p) => p.baseline);

  const k = Math.min(10, labelled.length);
  const positive = (p: ShadowPair) => p.label === "applied" || p.label === "shortlisted";
  const at = (key: "learned" | "baseline") =>
    k
      ? [...labelled].sort((a, b) => b[key] - a[key]).slice(0, k).filter(positive).length / k
      : 0;

  return {
    n: pairs.length,
    labelled: labelled.length,
    meanDelta: Math.round(delta * 10) / 10,
    agreement: Math.round(agreement * 100) / 100,
    aucLearned: auc(learnedPos, learnedNeg),
    aucBaseline: auc(basePos, baseNeg),
    aucCi: bootstrapAuc(learnedPos, learnedNeg),
    precision: k ? { k, learned: at("learned"), baseline: at("baseline") } : undefined,
  };
}

/**
 * Of the k best-ranked labelled postings, the fraction you would apply to.
 * Exported so the number can be tested without a database.
 */
export function precisionAt(
  rows: { track: string; score: number; label: string }[],
  track: string,
  k = 10,
): number | null {
  const group = rows
    .filter((r) => r.track === track)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  if (!group.length) return null;
  const hits = group.filter((r) => r.label === "applied" || r.label === "shortlisted").length;
  return hits / group.length;
}

/**
 * Precision@10 is the metric that matters: of the ten best-ranked postings you
 * actually reviewed, how many would you apply to? Labels only exist for jobs
 * you looked at, so this is directional rather than absolute.
 */
export function runEval(db: Db, tracks: Track[]): void {
  const labels = decisions(db);
  const positives = labels.filter((l) => l.label === "applied" || l.label === "shortlisted").length;
  const negatives = labels.filter((l) => l.label === "skipped").length;

  log(`labels: ${labels.length} (${positives} positive, ${negatives} negative)`);

  if (labels.length < 30) {
    log(
      `\nnot enough data to trust the ranking (${labels.length}/30 labels).\n` +
        "Label roughly 30 postings with: npm run feedback -- <id> applied|skipped",
    );
  }

  const rows = db
    .prepare(
      `SELECT s.track, s.score, d.label
       FROM scores s JOIN decisions d ON d.job_id = s.job_id
       ORDER BY s.track, s.score DESC`,
    )
    .all() as Row[];

  if (!rows.length) {
    log("\nno scored postings have labels yet.");
    return;
  }

  log("\nprecision@10 by track:");
  for (const track of tracks) {
    const value = precisionAt(
      rows.map((r) => ({
        track: String(r.track),
        score: Number(r.score),
        label: String(r.label),
      })),
      track.key,
      10,
    );
    if (value === null) continue;
    const group = rows.filter((r) => String(r.track) === track.key).slice(0, 10);
    const hits = group.filter((r) => r.label === "applied" || r.label === "shortlisted").length;
    log(`  ${track.key.padEnd(12)} ${hits}/${group.length} = ${value.toFixed(2)}`);
  }

  const byLang = db
    .prepare(
      `SELECT j.lang, COUNT(*) AS n, ROUND(AVG(s.score), 1) AS avg
       FROM scores s JOIN jobs j ON j.id = s.job_id
       GROUP BY j.lang ORDER BY n DESC`,
    )
    .all() as Row[];
  if (byLang.length) {
    log("\naverage score by language (watch for Hebrew under-scoring):");
    for (const r of byLang) {
      log(`  ${String(r.lang).padEnd(6)} n=${String(r.n).padEnd(5)} avg=${r.avg}`);
    }
  }

  const pairs = shadowPairs(db, LEARNING_VERSION).map((p) => ({
    ...p,
    label: labels.find((l) => l.jobId === p.jobId)?.label,
  }));
  if (pairs.length) {
    const stats = shadowStats(pairs);
    log("\nlearning compared with baseline (same postings, scored twice):");
    log(`  ${stats.n} posting(s), ${stats.labelled} labelled`);
    log(`  mean change ${stats.meanDelta > 0 ? "+" : ""}${stats.meanDelta} points · ${Math.round(stats.agreement * 100)}% agree within 5`);
    if (stats.precision) {
      log(
        `  of the top ${stats.precision.k} labelled: ${Math.round(stats.precision.learned * 100)}% applied ` +
          `with learning, ${Math.round(stats.precision.baseline * 100)}% without`,
      );
    }
    if (stats.aucLearned !== undefined && stats.aucBaseline !== undefined && stats.aucCi) {
      log(
        `  AUC learned ${stats.aucLearned.toFixed(2)} (95% CI ${stats.aucCi.low.toFixed(2)}–${stats.aucCi.high.toFixed(2)}) ` +
          `· baseline ${stats.aucBaseline.toFixed(2)}`,
      );
      if (stats.aucCi.low <= 0.5) {
        log("  the interval includes 0.5 — this is not evidence of an improvement yet");
      }
    } else {
      log("  not enough labelled pairs to compare yet (need both applied and skipped)");
    }
  } else {
    log("\nno shadow scoring yet. Set LEARNING_SHADOW=10 in .env to measure learning.");
  }

  const stale = staleShadowPairs(db, LEARNING_VERSION);
  if (stale) {
    log(
      `  ${stale} pair(s) were scored under older learning rules and are not compared; ` +
        `rescore with LEARNING_SHADOW to refresh them`,
    );
  }

  const rejects = rejectSummary(db);
  if (rejects.length) {
    log("\ntop rejection reasons (watch for over-filtering):");
    for (const r of rejects.slice(0, 10)) log(`  ${r.reason.padEnd(28)} ${r.n}`);
  }
}
