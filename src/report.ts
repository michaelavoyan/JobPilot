import type { Db } from "./store/db.ts";
import { decisions, funnelCounts, rejectSummary, scoreDistribution, stats } from "./store/db.ts";
import type { Track } from "./config.ts";
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

  const rejects = rejectSummary(db);
  if (rejects.length) {
    log("\ntop rejection reasons (watch for over-filtering):");
    for (const r of rejects.slice(0, 10)) log(`  ${r.reason.padEnd(28)} ${r.n}`);
  }
}
