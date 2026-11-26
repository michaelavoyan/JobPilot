import { env, warn } from "./util.ts";
import { getJson } from "./ingest/types.ts";
import type { Company, Market } from "./config.ts";

export interface Candidate {
  ats: string;
  /** Greenhouse / Lever / Ashby tenant. */
  slug?: string;
  /** Comeet company UID. */
  uid?: string;
}

export interface FoundBoard extends Candidate {
  name: string;
  openRoles: number;
  token?: string;
}

export type Band = { min: number; max: number };

const ATS_HOSTS: { ats: string; host: string }[] = [
  { ats: "lever", host: "jobs.lever.co" },
  { ats: "greenhouse", host: "boards.greenhouse.io" },
  { ats: "ashby", host: "jobs.ashbyhq.com" },
  { ats: "comeet", host: "comeet.com" },
];

/**
 * Career URLs carry the tenant in the path, which is why discovery searches
 * for pages rather than for company names: the answer is in the URL.
 */
export function parseAtsUrl(raw: string): Candidate | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);

  if (host === "jobs.lever.co" && parts[0]) return { ats: "lever", slug: parts[0] };
  if ((host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") && parts[0])
    return { ats: "greenhouse", slug: parts[0] };
  if (host === "jobs.ashbyhq.com" && parts[0]) return { ats: "ashby", slug: parts[0] };
  if (host.endsWith("comeet.com")) {
    const uid = url.pathname.match(/([A-Z0-9]{1,4}\.[A-Z0-9]{3})\b/i)?.[1];
    if (!uid) return null;
    return { ats: "comeet", uid };
  }
  return null;
}

export function parseBands(value: string): Band[] {
  const bands = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const bad = () => new Error(`bad band "${part}". Use forms like 1-20, 21-100 or 500+`);

      // "500+" is an open-ended band and has no dash.
      if (part.endsWith("+")) {
        const min = Number(part.slice(0, -1).trim());
        if (!Number.isFinite(min)) throw bad();
        return { min, max: Number.POSITIVE_INFINITY };
      }

      const dash = part.indexOf("-");
      if (dash === -1) throw bad();
      const min = Number(part.slice(0, dash).trim());
      const maxRaw = part.slice(dash + 1).trim();
      const max = maxRaw === "" ? Number.POSITIVE_INFINITY : Number(maxRaw);
      if (!Number.isFinite(min) || Number.isNaN(max)) throw bad();
      return { min, max };
    });
  if (!bands.length) throw new Error("no bands given");
  return bands;
}

export function inBands(openRoles: number, bands: Band[]): boolean {
  return bands.some((b) => openRoles >= b.min && openRoles <= b.max);
}

export function displayName(slug: string): string {
  return slug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export function searchConfigured(): boolean {
  return Boolean(
    env("SERPER_API_KEY") ||
      env("BRAVE_API_KEY") ||
      (env("GOOGLE_API_KEY") && env("GOOGLE_CSE_ID")),
  );
}

/** Search is pluggable because every free search API is metered. */
export async function search(query: string): Promise<string[]> {
  const brave = env("BRAVE_API_KEY");
  if (brave) {
    const data = await getJson(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20`,
      { "x-subscription-token": brave },
    );
    return (data as { web?: { results?: { url?: string }[] } }).web?.results
      ?.map((r) => r.url ?? "")
      .filter(Boolean) ?? [];
  }

  // Serper: Google results, 2,500 free queries, no card. The practical
  // free option since Brave introduced card-only plans and Google closed the
  // Custom Search JSON API to new customers.
  const serper = env("SERPER_API_KEY");
  if (serper) {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": serper },
      body: JSON.stringify({ q: query, num: 20 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`serper HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { organic?: { link?: string }[] };
    return (data.organic ?? []).map((r) => r.link ?? "").filter(Boolean);
  }

  const key = env("GOOGLE_API_KEY");
  const cx = env("GOOGLE_CSE_ID");
  if (key && cx) {
    const data = await getJson(
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}`,
    );
    return ((data as { items?: { link?: string }[] }).items ?? [])
      .map((i) => i.link ?? "")
      .filter(Boolean);
  }

  throw new Error(
    "no search provider configured. Set SERPER_API_KEY (free, no card), " +
      "BRAVE_API_KEY, or GOOGLE_API_KEY and GOOGLE_CSE_ID.",
  );
}

export function buildQueries(market: Market, cities: string[]): string[] {
  const places = cities.length ? cities : [market.country];
  const queries: string[] = [];
  for (const place of places) {
    for (const { host } of ATS_HOSTS) {
      // No `site:` and no quoting: Serper's free tier rejects queries that
      // combine a domain with a quoted phrase. The host as a term is weaker
      // but allowed, and the parser keeps only ATS links anyway.
      queries.push(`${host} ${place}`);
    }
  }
  return queries;
}

function atsUrl(c: Candidate): string {
  switch (c.ats) {
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(c.slug!)}?mode=json`;
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.slug!)}/jobs`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(c.slug!)}`;
    default:
      return "";
  }
}

function countJobs(ats: string, data: unknown): number {
  if (ats === "lever") return Array.isArray(data) ? data.length : 0;
  const jobs = (data as { jobs?: unknown[] })?.jobs;
  return Array.isArray(jobs) ? jobs.length : 0;
}

async function comeetToken(slug: string, uid: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://www.comeet.com/jobs/${slug}/${uid}`, {
      headers: { "user-agent": "jobpilot/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    return html.match(/["']token["']\s*:\s*["']([A-Za-z0-9_-]{6,})["']/)?.[1];
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  market: Market;
  cities: string[];
  bands: Band[];
  maxQueries?: number;
  maxBoards?: number;
}

export interface DiscoverResult {
  boards: FoundBoard[];
  stats: {
    queries: number;
    urls: number;
    candidates: number;
    verified: number;
    inBands: number;
  };
  errors: string[];
}

/**
 * Search -> collect ATS URLs -> probe each -> keep the ones with open roles in
 * the requested bands. Nothing is written here; the caller decides what to add.
 */
export async function discoverCompanies(opts: DiscoverOptions): Promise<DiscoverResult> {
  const errors: string[] = [];
  const queries = buildQueries(opts.market, opts.cities).slice(0, opts.maxQueries ?? 40);

  const urls: string[] = [];
  for (const query of queries) {
    try {
      urls.push(...(await search(query)));
    } catch (err) {
      errors.push(`${query}: ${(err as Error).message}`);
      break; // a provider outage should stop the run, not burn the quota
    }
  }

  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const raw of urls) {
    const parsed = parseAtsUrl(raw);
    if (!parsed) continue;
    const key = `${parsed.ats}:${parsed.slug ?? parsed.uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(parsed);
  }

  const verified: FoundBoard[] = [];
  let index = 0;
  async function worker() {
    while (index < candidates.length) {
      const candidate = candidates[index++];
      try {
        if (candidate.ats === "comeet") {
          const slug = "company";
          const token = await comeetToken(slug, candidate.uid!);
          if (!token) continue;
          const data = await getJson(
            `https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(candidate.uid!)}/positions?token=${encodeURIComponent(token)}`,
          );
          const n = Array.isArray(data) ? data.length : 0;
          if (n > 0) verified.push({ ...candidate, name: displayName(candidate.uid!), openRoles: n, token });
          continue;
        }
        const data = await getJson(atsUrl(candidate));
        const n = countJobs(candidate.ats, data);
        if (n > 0) {
          verified.push({ ...candidate, name: displayName(candidate.slug!), openRoles: n });
        }
      } catch {
        /* a dead board is not an error worth reporting */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, candidates.length || 1) }, worker));

  const inBand = verified.filter((b) => inBands(b.openRoles, opts.bands));
  inBand.sort((a, b) => b.openRoles - a.openRoles);

  const boards = (opts.maxBoards ? inBand.slice(0, opts.maxBoards) : inBand).map((b) => ({
    ...b,
    name: b.name.replace(/\b\w/g, (c) => c.toUpperCase()),
  }));

  if (!verified.length && errors.length === 0 && candidates.length === 0) {
    warn("discovery found no ATS URLs — check the search provider and the queries");
  }

  return {
    boards,
    stats: {
      queries: queries.length,
      urls: urls.length,
      candidates: candidates.length,
      verified: verified.length,
      inBands: inBand.length,
    },
    errors,
  };
}

/** A remembered board, from the database, as a collectable company. */
export function boardToCompany(board: {
  ats: string;
  ident: string;
  token?: string;
  name: string;
}): Company {
  if (board.ats === "comeet") {
    return { name: board.name, source: "comeet", uid: board.ident, token: board.token };
  }
  return { name: board.name, source: board.ats, slug: board.ident };
}

export function toCompany(board: FoundBoard): Company {
  if (board.ats === "comeet") {
    return { name: board.name, source: "comeet", uid: board.uid!, token: board.token! };
  }
  return { name: board.name, source: board.ats, slug: board.slug! };
}
