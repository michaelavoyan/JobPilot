import type { Constraint, Db } from "../storage/db.ts";
import { listConstraints } from "../storage/db.ts";
import type { Profile } from "./config.ts";
import { describeConstraint } from "./notes.ts";
import type { ConstraintKind } from "./notes.ts";

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

export interface Preference {
  term: string;
  /** How many labelled postings mentioned it in each group. */
  applied: number;
  skipped: number;
  /** Applied rate among postings that mention it, 0..1. */
  appliedRate: number;
  /** Applied rate among all labelled postings — the comparison. */
  baselineRate: number;
}

export interface LearningProfile {
  applied: number;
  skipped: number;
  /** Whether the sample is large enough to say anything about the score scale. */
  enoughLabels: boolean;
  /** Terms that appeared disproportionately in the postings the user applied to. */
  preferences: Preference[];
  /** Constraints stated in notes and **confirmed by the user**. */
  constraints: Constraint[];
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
/** A term must appear in this many labelled postings before it means anything. */
const MIN_TERM = 4;
/** A rate difference smaller than this is indistinguishable from noise. */
const MIN_LIFT = 0.3;
const MAX_PREFERENCES = 3;

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
export function buildLearning(db: Db, profile?: Profile): LearningProfile {
  const rows = db
    .prepare(
      `SELECT d.label AS label, s.track AS track, s.score AS score, s.reasons AS reasons,
              j.title AS title, j.company AS company, j.description AS description
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

  const preferences = profile ? derivePreferences(rows, profile) : [];

  return {
    applied: applied.length,
    skipped: skipped.length,
    enoughLabels: enoughOverall,
    preferences,
    constraints: listConstraints(db, "confirmed"),
    byTrack,
    trackCalibration,
    suggestedMinScore,
    appliedExamples: pick(applied, "", MAX_EXAMPLES, MIN_APPLIED),
    skippedExamples: pick(skipped, "", 2, MIN_SKIPPED),
  };
}

/**
 * Which of the candidate's own domains and technologies show up in the roles
 * they accept far more often than in the ones they skip.
 *
 * This is correlation in a small sample, so it is reported as a hint and gated
 * on both frequency and lift. A term seen twice is an anecdote.
 */
function derivePreferences(rows: Row[], profile: Profile): Preference[] {
  const applied = rows.filter((r) => r.label === "applied" || r.label === "shortlisted");
  const skipped = rows.filter((r) => r.label === "skipped");
  if (!applied.length || !skipped.length) return [];

  const baselineRate = applied.length / rows.length;
  const terms = [...new Set([...profile.domains, ...profile.stack])]
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3);

  const scored: Preference[] = [];
  for (const term of terms) {
    const has = (r: Row) => String(r.description ?? "").toLowerCase().includes(term);
    const a = applied.filter(has).length;
    const s = skipped.filter(has).length;
    if (a + s < MIN_TERM) continue;
    const appliedRate = a / (a + s);
    if (appliedRate - baselineRate < MIN_LIFT) continue;
    scored.push({ term, applied: a, skipped: s, appliedRate, baselineRate });
  }

  return scored
    .sort((a, b) => b.appliedRate - a.appliedRate)
    .slice(0, MAX_PREFERENCES)
    .map((p) => ({
      ...p,
      appliedRate: Math.round(p.appliedRate * 100) / 100,
      baselineRate: Math.round(p.baselineRate * 100) / 100,
    }));
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

  const extra: string[] = [];
  if (learning.preferences.length) {
    extra.push("Roles they accept mention these more often than the ones they skip:");
    extra.push(...learning.preferences.map((p) => `- ${p.term}`));
  }
  if (learning.constraints.length) {
    extra.push("");
    extra.push("They stated these constraints themselves:");
    extra.push(
      ...learning.constraints.map(
        (c) => `- ${describeConstraint(c.kind as ConstraintKind, c.value)} (\"${c.note}\")`,
      ),
    );
  }

  if (!sections.length && !extra.length) return "";

  const hasLabels = learning.applied > 0 || learning.skipped > 0;
  const head = hasLabels
    ? [
        `Learned from this candidate's own decisions (${learning.applied} applied, ${learning.skipped} skipped).`,
        "",
        ...sections,
        ...(sections.length && extra.length ? [""] : []),
      ]
    : [];

  return [
    ...head,
    ...extra,
    "",
    "Use this as calibration evidence only. It tells you where their bar sits,",
    "not which of the current jobs to accept.",
  ].join("\n");
}
