import type { Profile, Track } from "../config.ts";
import type { Job } from "../types.ts";
import { formatComp } from "../enrich/comp.ts";
import { excerpt } from "../enrich/normalize.ts";
import { fieldById } from "../fields.ts";
import { renderLearning } from "../learn.ts";
import type { LearningProfile } from "../learn.ts";

export const RUBRIC = `
Score each posting 0-100 against the candidate profile, per track.

90-100  Meets nearly every requirement; the profile is an obvious fit.
75-89   Strong fit; one gap you could argue past.
60-74   Plausible; meaningful gaps in scope, domain, or stack.
40-59   The title matches but the substance does not.
0-39    Wrong level, wrong domain, or unactionable.

Rules, in priority order:
1. Judge LEVEL first. A perfect stack at the wrong seniority is a 40, not an 85.
2. A management title with no direct reports scores at most 50 on any management track.
3. A role with fewer than 3 reports scores at most 60 on management tracks; note it.
4. Hebrew postings are judged on the same rubric. Never lower a score for language.
5. If the description is truncated, empty, or under 200 characters, cap the score at 55
   and set flag "insufficient_text".
6. The candidate is based in COUNTRY_PLACEHOLDER. Treat work-authorisation requirements
   as a scoring signal: a role that demands authorisation the candidate may not hold
   scores low even when the skills fit.
7. Do not reward keyword overlap alone. Domain and scope matter more than tool names.
`.trim();

const CONTRACT = `
Return ONLY JSON, no prose and no markdown fences:

{
  "results": [
    {
      "i": <job index from the input>,
      "scores": {
        "<track_key>": {
          "score": <integer 0-100>,
          "reasons": ["<max 3 short phrases, <= 90 chars each>"],
          "flags": ["<optional short machine-readable flags>"]
        }
      }
    }
  ]
}

Include an entry for every job index and every track key requested for it.
`.trim();

export function buildProfileBlock(p: Profile): string {
  const lines: string[] = [];
  const field = fieldById(p.field);
  if (field) lines.push(`Target field: ${field.label} — ${field.context}`);
  lines.push(`Name: ${p.name}`);
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  lines.push(
    `Experience: ${p.experience.total_years} years total, ${p.experience.management_years} in management` +
      (p.experience.max_team_size ? `, largest team ${p.experience.max_team_size}` : ""),
  );
  if (p.current_title) lines.push(`Current title: ${p.current_title}`);
  if (p.previous_titles?.length) lines.push(`Previous titles: ${p.previous_titles.join(", ")}`);
  if (p.domains.length) lines.push(`Domains: ${p.domains.join(", ")}`);
  if (p.interests?.length) lines.push(`Also open to: ${p.interests.join(", ")}`);
  if (p.stack.length) lines.push(`Stack: ${p.stack.join(", ")}`);
  if (p.ai_practice.length) lines.push(`AI practice: ${p.ai_practice.join(", ")}`);
  if (p.people_management.length) lines.push(`Management experience: ${p.people_management.join(", ")}`);
  if (p.languages) {
    lines.push(
      `Languages: ${Object.entries(p.languages)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  }
  if (p.education?.degree) lines.push(`Education: ${p.education.degree}`);
  if (p.locations.allowed.length) {
    lines.push(`Commute radius: ${p.locations.allowed.join(", ")}`);
  }
  lines.push(`Remote acceptable: ${p.locations.remote_ok ? "yes" : "no"}`);
  return lines.join("\n");
}

export function buildSystem(country: string): string {
  const rules = RUBRIC.replace("COUNTRY_PLACEHOLDER", country || "an unspecified country");
  return [
    "You are a strict technical recruiter scoring job postings for one specific candidate.",
    "You are calibrated: you do not inflate scores to be encouraging, and you do not",
    "penalise a posting for being written in a language other than the candidate's first.",
    "",
    rules,
    "",
    CONTRACT,
  ].join("\n");
}

export function buildUser(
  profile: Profile,
  tracks: Track[],
  items: { job: Job; tracks: string[] }[],
  learning?: LearningProfile,
): string {
  const parts: string[] = [];

  parts.push("# CANDIDATE PROFILE\n" + buildProfileBlock(profile));

  const batchTracks = [...new Set(items.flatMap((i) => i.tracks))];
  const learned = renderLearning(learning, batchTracks);
  if (learned) parts.push("# WHAT THIS CANDIDATE HAS DECIDED\n" + learned);

  parts.push(
    "# TRACKS\n" +
      tracks
        .map((t) => `## ${t.key} — ${t.label}\n${t.brief.trim()}`)
        .join("\n\n"),
  );

  parts.push(
    "# JOBS\n" +
      items
        .map((item, i) => {
          const j = item.job;
          const meta: string[] = [];
          if (j.locations.length) meta.push(j.locations.join(", "));
          if (j.remote) meta.push("remote");
          meta.push(`lang=${j.lang}`);
          const comp = formatComp(j.comp);
          if (comp) meta.push(comp);
          return [
            `[${i}] ${j.company} — ${j.title}`,
            `    ${meta.join(" | ")}`,
            `    tracks: ${item.tracks.join(", ")}`,
            `    ${excerpt(j.description, 1200)}`,
          ].join("\n");
        })
        .join("\n\n"),
  );

  parts.push(
    "# TASK\nScore every job above for each track key listed under that job. Return JSON only.",
  );

  return parts.join("\n\n");
}
