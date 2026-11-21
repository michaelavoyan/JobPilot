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

export interface TrackExamples {
  applied: LearningExample[];
  skipped: LearningExample[];
}

export interface LearningProfile {
  applied: number;
  skipped: number;
  /** Examples scoped to the track being scored, not to the whole history. */
  byTrack: Record<string, TrackExamples>;
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
/** A track needs its own sample before it gets its own examples. */
const MIN_TRACK = 3;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
}

/** Overlap of two short texts, normalised so long text is not rewarded. */
function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared++;
  return shared / Math.sqrt(left.size * right.size);
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

  const toExample = (r: Row): LearningExample => ({
    title: String(r.title),
    company: String(r.company),
    score: Number(r.score),
    reasons: parseReasons(String(r.reasons ?? "[]")),
  });

  /**
   * Nearest the posting being scored first (lexical overlap with the track's
   * brief), then nearest that group's median. The first term keeps examples
   * relevant; the second keeps outliers out.
   */
  const pick = (rows: Row[], query: string, count: number, minimum: number): LearningExample[] => {
    if (rows.length < minimum) return [];
    const scores = rows.map((r) => Number(r.score));
    const centre = median(scores) ?? 0;
    return [...rows]
      .sort((a, b) => {
        const sa = similarity(`${a.title} ${a.company}`, query);
        const sb = similarity(`${b.title} ${b.company}`, query);
        if (sb !== sa) return sb - sa;
        return Math.abs(Number(a.score) - centre) - Math.abs(Number(b.score) - centre);
      })
      .slice(0, count)
      .map(toExample);
  };

  const byTrack: Record<string, TrackExamples> = {};
  // The global gate comes first: per-track detail is a refinement of a sample
  // that is already large enough to say anything at all.
  const enoughOverall = applied.length >= MIN_APPLIED && skipped.length >= MIN_SKIPPED;
  for (const track of enoughOverall ? tracks : []) {
    const trackRows = rows.filter((r) => r.track === track);
    const trackApplied = trackRows.filter(
      (r) => r.label === "applied" || r.label === "shortlisted",
    );
    const trackSkipped = trackRows.filter((r) => r.label === "skipped");
    byTrack[track] = {
      applied: pick(trackApplied, track, MAX_EXAMPLES, MIN_TRACK),
      skipped: pick(trackSkipped, track, 2, MIN_TRACK),
    };
  }

  return {
    applied: applied.length,
    skipped: skipped.length,
    byTrack,
    trackCalibration,
    suggestedMinScore,
    appliedExamples: pick(applied, "", MAX_EXAMPLES, MIN_APPLIED),
    skippedExamples: pick(skipped, "", 2, MIN_SKIPPED),
  };
}

/**
 * Rendered into the scoring prompt for the given tracks only. Evidence from a
 * mobile-engineering track says nothing about a director search.
 */
export function renderLearning(learning: LearningProfile | undefined, tracks: string[]): string {
  if (!learning) return "";

  const sections: string[] = [];
  for (const track of tracks) {
    const examples = learning.byTrack[track];
    if (!examples) continue;
    if (!examples.applied.length && !examples.skipped.length) continue;

    const lines: string[] = [`## ${track}`];
    if (examples.applied.length) {
      lines.push("They applied to:");
      for (const e of examples.applied) lines.push(`- ${e.title} at ${e.company} (${e.score})`);
    }
    if (examples.skipped.length) {
      lines.push("They skipped:");
      for (const e of examples.skipped) lines.push(`- ${e.title} at ${e.company} (${e.score})`);
    }
    sections.push(lines.join("\n"));
  }

  if (!sections.length) return "";

  return [
    `Learned from this candidate's own decisions (${learning.applied} applied, ${learning.skipped} skipped).`,
    "",
    ...sections,
    "",
    "Use this as calibration evidence only. It tells you where their bar sits,",
    "not which of the current jobs to accept.",
  ].join("\n");
}
