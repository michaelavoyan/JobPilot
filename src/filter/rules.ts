import type { Job, Verdict } from "../types.ts";
import type { Market, Profile, Track } from "../config.ts";
import { toMonthly } from "../enrich/comp.ts";
import { inRadius } from "../enrich/location.ts";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function matchesAny(haystack: string, needles: string[]): string | undefined {
  for (const needle of needles) {
    if (!needle) continue;
    if (haystack.includes(norm(needle))) return needle;
  }
  return undefined;
}

/**
 * Pure function. No clock, no network, no database — which is why it can be
 * exhaustively tested and why it can never flake.
 *
 * Order is deliberate: cheapest and most decisive rules first.
 */
export function hardFilter(
  job: Job,
  track: Track,
  profile: Profile,
  market: Market,
): Verdict {
  const flags: string[] = [];
  const title = norm(job.title);
  const body = norm(job.description);

  // 1. Track-level title exclusions
  const excluded = matchesAny(title, track.title_exclude);
  if (excluded) return { ok: false, reason: `title_exclude:${excluded}`, flags };

  // 2. Title must belong to the track. Explicit interests widen the net: if
  //    the candidate typed "product manager", those postings must reach the
  //    scorer even though the track keywords would not match them.
  const included = matchesAny(title, [...track.title_include, ...(profile.interests ?? [])]);
  if (!included) return { ok: false, reason: "title_not_in_track", flags };

  // 3. Market-wide seniority traps (intern / junior / student)
  for (const pattern of market.exclude_title_patterns) {
    try {
      if (new RegExp(pattern, "i").test(job.title)) {
        return { ok: false, reason: "seniority_trap", flags };
      }
    } catch {
      // A malformed pattern in config must not break the run.
    }
  }

  // 4. Security clearance / citizenship requirements
  if (profile.authorization_must_pass) {
    for (const pattern of market.clearance_patterns) {
      const re = new RegExp(pattern, "i");
      if (re.test(job.title) || re.test(job.description)) {
        return { ok: false, reason: "clearance_required", flags };
      }
    }
  }

  // 5. Location. `remote_ok` permits remote roles; it must never let an
  //    out-of-radius on-site role through — that is how a radius filter
  //    quietly stops filtering.
  if (job.remote) {
    if (!profile.locations.remote_ok) {
      return { ok: false, reason: "location", flags };
    }
    // "Remote" is meaningless without a scope. A role marked remote but tied
    // to another region is not remote for this candidate.
    const scope = norm(job.locations.join(" "));
    const worldwide = /\b(worldwide|anywhere|global|fully remote)\b/.test(scope);
    if (!worldwide) {
      const denied = (market.remote_deny_regions ?? []).find((region) =>
        scope.includes(norm(region)),
      );
      if (denied) return { ok: false, reason: `remote_region:${denied}`, flags };
    }
    flags.push("remote");
  } else if (job.locations.length === 0) {
    // Unknown location is not evidence of a bad location. Pass it with a flag
    // so the digest can show it, rather than dropping it silently.
    flags.push("location_unclear");
  } else if (!profile.locations.allowed.length && !profile.locations.regions.length) {
    // No radius configured yet — a new user who has only uploaded a CV. Absence
    // of a radius is not permission to search the world: the posting must still
    // be in the market's country.
    const haystack = norm(job.locations.join(" "));
    const tokens = [
      ...(market.country_names ?? []),
      ...Object.values(market.city_aliases ?? {}),
    ].filter((token) => token && token !== "Remote" && token !== "Hybrid");

    if (!tokens.some((token) => haystack.includes(norm(token)))) {
      return { ok: false, reason: "location_country", flags };
    }
    flags.push("location_unfiltered");
  } else {
    const { hit, matched } = inRadius(
      job.locations,
      profile.locations.allowed,
      profile.locations.regions,
    );
    if (hit) {
      if (matched) flags.push(`near:${matched}`);
    } else {
      return { ok: false, reason: "location", flags };
    }
  }

  // 6. Salary floor. Only enforced when both sides are known: a guessed
  //    floor silently deletes jobs, which is the worst failure mode here.
  const floor = toMonthly(profile.comp_floor);
  const actual = toMonthly(job.comp);
  if (floor !== undefined && actual !== undefined && actual < floor * 0.85) {
    return { ok: false, reason: "comp_below_floor", flags };
  }

  // Signals the scorer should see, not rejections.
  if (!job.description || job.description.length < 200) flags.push("insufficient_text");
  if (body.includes("hands-on") || job.title.toLowerCase().includes("hands-on")) flags.push("hands_on");

  return { ok: true, flags };
}
