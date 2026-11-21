import type { Db } from "../storage/db.ts";
import type { Score } from "./types.ts";

export interface LearningExample {
  title: string;
  company: string;
  score: number;
  reasons: string[];
}

export interface TrackCalibration {
  track: string;
  applied: number;
  skipped: number;
  appliedMedian?: number;
  skippedMedian?: number;
}

export interface LearningProfile {
  applied: number;
  skipped: number;
  trackCalibration: TrackCalibration[];
  /** Only set when the two distributions separate enough to mean anything. */
  suggestedMinScore?: number;
  appliedExamples: LearningExample[];
  skippedExamples: LearningExample[];
}

/** Below this, any pattern is noise. Two examples are not a preference. */
const MIN_APPLIED = 5;
const MIN_SKIPPED = 10;
/** A gap smaller than this cannot justify moving a threshold. */
const MIN_GAP = 8;
const MAX_EXAMPLES = 3;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function parseReasons(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).slice(0, 2) : [];
  } catch {
    return [];
  }
}

type Row = Record<string, unknown>;

/**
 * Everything the agent can honestly conclude from the labels so far.
 *
 * This is measurement, not training: no weights change, no prompt is rewritten
 * from a handful of clicks. What it produces is calibration evidence — where
 * this user's applications actually sit against the score scale — plus a few
 * of their own decisions as worked examples.
 */
export function buildLearning(db: Db): LearningProfile {
  const rows = db
    .prepare(
      `SELECT d.label AS label, s.track AS track, s.score AS score, s.reasons AS reasons,
              j.title AS title, j.company AS company
       FROM decisions d
       JOIN scores s ON s.job_id = d.job_id
       JOIN jobs j ON j.id = d.job_id`,
    )
    .all() as Row[];

  const applied = rows.filter((r) => r.label === "applied" || r.label === "shortlisted");
  const skipped = rows.filter((r) => r.label === "skipped");

  const tracks = [...new Set(rows.map((r) => String(r.track)))].sort();
  const trackCalibration: TrackCalibration[] = tracks.map((track) => {
    const a = applied.filter((r) => r.track === track).map((r) => Number(r.score));
    const s = skipped.filter((r) => r.track === track).map((r) => Number(r.score));
    return {
      track,
      applied: a.length,
      skipped: s.length,
      appliedMedian: median(a),
      skippedMedian: median(s),
    };
  });

  const allApplied = applied.map((r) => Number(r.score));
  const allSkipped = skipped.map((r) => Number(r.score));
  const appliedMedian = median(allApplied);
  const skippedMedian = median(allSkipped);

  let suggestedMinScore: number | undefined;
  if (
    applied.length >= MIN_APPLIED &&
    skipped.length >= MIN_SKIPPED &&
    appliedMedian !== undefined &&
    skippedMedian !== undefined
  ) {
    const gap = appliedMedian - skippedMedian;
    if (gap >= MIN_GAP) {
      suggestedMinScore = Math.round(skippedMedian + gap / 2);
    }
  }

  const pick = (rows: Row[], count: number): LearningExample[] => {
    if (rows.length < MIN_APPLIED) return [];
    const scores = rows.map((r) => Number(r.score));
    const centre = median(scores) ?? 0;
    return [...rows]
      .sort((a, b) => Math.abs(Number(a.score) - centre) - Math.abs(Number(b.score) - centre))
      .slice(0, count)
      .map((r) => ({
        title: String(r.title),
        company: String(r.company),
        score: Number(r.score),
        reasons: parseReasons(String(r.reasons ?? "[]")),
      }));
  };

  return {
    applied: applied.length,
    skipped: skipped.length,
    trackCalibration,
    suggestedMinScore,
    appliedExamples: pick(applied, MAX_EXAMPLES),
    skippedExamples: pick(skipped, 2),
  };
}

/** Rendered into the scoring prompt. Empty string when there is nothing to say. */
export function renderLearning(learning: LearningProfile | undefined): string {
  if (!learning) return "";
  const usable =
    learning.appliedExamples.length > 0 || learning.skippedExamples.length > 0;
  if (!usable) return "";

  const lines: string[] = [];
  lines.push(
    `Learned from this candidate's own decisions: ${learning.applied} applied, ${learning.skipped} skipped.`,
  );

  if (learning.suggestedMinScore !== undefined) {
    lines.push(
      `Their applications sit well above their skips; the boundary is around ${learning.suggestedMinScore}.`,
    );
  }

  if (learning.appliedExamples.length) {
    lines.push("", "They applied to:");
    for (const e of learning.appliedExamples) {
      lines.push(`- ${e.title} at ${e.company} (scored ${e.score})`);
    }
  }
  if (learning.skippedExamples.length) {
    lines.push("", "They skipped:");
    for (const e of learning.skippedExamples) {
      lines.push(`- ${e.title} at ${e.company} (scored ${e.score})`);
    }
  }

  lines.push(
    "",
    "Use this as calibration evidence only. It tells you where their bar sits,",
    "not which of the current jobs to accept.",
  );

  return lines.join("\n");
}
