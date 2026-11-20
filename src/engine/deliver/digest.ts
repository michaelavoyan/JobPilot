import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScoredJob } from "../types.ts";
import type { Track } from "../config.ts";
import { formatComp } from "../enrich/comp.ts";
import { excerpt } from "../enrich/normalize.ts";
import { outDir, log, today } from "../util.ts";

export interface DigestOptions {
  minScore: number;
  maxRows: number;
}

export function renderDigest(
  jobs: ScoredJob[],
  tracks: Track[],
  options: DigestOptions,
): string {
  const ordered = [...tracks].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const picked: ScoredJob[] = [];

  // Best track per job: a job that fits two tracks appears once, at its
  // highest score, under that track.
  const bestByJob = new Map<string, ScoredJob>();
  for (const job of jobs) {
    const prev = bestByJob.get(job.id);
    if (!prev || job.score > prev.score) bestByJob.set(job.id, job);
  }
  const ranked = [...bestByJob.values()].sort((a, b) => b.score - a.score);

  for (const job of ranked) {
    if (picked.length >= options.maxRows) break;
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    picked.push(job);
  }

  const date = today();
  const lines: string[] = [];
  lines.push(`# ${date} — ${picked.length} match${picked.length === 1 ? "" : "es"}`);
  lines.push("");
  lines.push(
    `_${jobs.length} scored above ${options.minScore} · ${picked.length} shown · labelled postings never reappear_`,
  );

  if (!picked.length) {
    lines.push("");
    lines.push("No matches above threshold today. Widen `MIN_SCORE` or add companies.");
    return lines.join("\n");
  }

  for (const track of ordered) {
    const group = picked.filter((j) => trackFor(j, tracks) === track.key);
    if (!group.length) continue;
    lines.push("");
    lines.push(`## ${track.label} (${group.length})`);
    for (const job of group) {
      lines.push("");
      lines.push(renderRow(job));
    }
  }

  const leftovers = picked.filter((j) => trackFor(j, tracks) === undefined);
  if (leftovers.length) {
    lines.push("");
    lines.push(`## Other (${leftovers.length})`);
    for (const job of leftovers) {
      lines.push("");
      lines.push(renderRow(job));
    }
  }

  return lines.join("\n");
}

function trackFor(job: ScoredJob, tracks: Track[]): string | undefined {
  return tracks.find((t) => t.key === job.track)?.key;
}

function renderRow(job: ScoredJob): string {
  const where = job.remote ? "Remote" : job.locations.join(", ") || "location n/a";
  const comp = formatComp(job.comp);
  const meta = [where, comp, job.lang !== "en" ? `lang:${job.lang}` : ""].filter(Boolean).join(" · ");

  const header = `### ${job.score} · ${job.company} · ${job.title} — ${where}`;
  const reason = job.reasons.length ? job.reasons.join(" · ") : "no reasons returned";
  const flags = job.flags.length ? `\n\`${job.flags.join("` `")}\`` : "";
  const body = excerpt(job.description, 240);

  return [
    header,
    meta && `_${meta}_`,
    reason,
    body ? `> ${body}` : "",
    flags.trim(),
    job.url ? `[Apply](${job.url})` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function writeDigest(markdown: string): string {
  const dir = outDir();
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `digest-${today()}.md`);
  writeFileSync(path, markdown + "\n", "utf8");
  log(`digest written: ${path}`);
  return path;
}
