/**
 * Discovery without a search key.
 *
 * A search provider finds careers pages by query, which is precise. This is the
 * weaker fallback: take a public list of companies, derive the slugs their ATS
 * might use, and probe the three public APIs. No key, no scraping of job
 * boards, and every hit is verified against the company it claims to be.
 *
 * Measured yield is roughly one live board per fifteen names. That is the cost
 * of not having a search key; the number is reported, not hidden.
 */

const CATEGORIES = [
  "Category:Technology_companies_of_Israel",
  "Category:Software_companies_of_Israel",
  "Category:Companies_of_Israel",
];

export interface BoardHit {
  name: string;
  source: "greenhouse" | "lever" | "ashby";
  ident: string;
  openRoles: number;
}

export interface ListDiscovery {
  names: number;
  probed: number;
  hits: BoardHit[];
  /** The names actually probed, so the caller can remember them. */
  checked: string[];
  errors: { name: string; message: string }[];
}

type Fetcher = typeof fetch;

const norm = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

const LEGAL = /\b(ltd|inc|corp|corporation|limited|llc|plc|group|technologies|technology|software|systems|solutions|international)\b/gi;

/** The company will have registered its board under one of these. */
export function slugCandidates(name: string): string[] {
  const stripped = name.replace(LEGAL, " ");
  const words = stripped.split(/\s+/).filter(Boolean);
  const candidates = [
    norm(name),
    norm(stripped),
    norm(words.slice(0, 2).join(" ")),
    norm(words[0] ?? ""),
  ];
  return [...new Set(candidates)].filter((slug) => slug.length >= 3 && slug.length <= 32);
}

/**
 * A board is only accepted when the name it reports contains the company we
 * asked for. Slugs collide, and adding the wrong employer is worse than adding
 * none.
 */
export function sameCompany(expected: string, actual: string): boolean {
  const a = norm(expected);
  const b = norm(actual);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const tokens = expected.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  return tokens.some((token) => b.includes(token));
}

/** Wikipedia answers 429 without a descriptive agent; the ATS APIs do not care. */
const AGENT = "JobPilot/0.1 (+https://github.com/michaelavoyan/JobPilot)";

async function get(fetchFn: Fetcher, url: string): Promise<Response | null> {
  try {
    return await fetchFn(url, {
      headers: { "user-agent": AGENT },
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return null;
  }
}

async function pageTitle(fetchFn: Fetcher, url: string): Promise<string> {
  const res = await get(fetchFn, url);
  if (!res?.ok) return "";
  const html = await res.text();
  return html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";
}

/** Company names from a Wikipedia category, through the public API. */
async function categoryNames(category: string, fetchFn: Fetcher): Promise<string[]> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&list=categorymembers" +
    `&cmtitle=${encodeURIComponent(category)}&cmlimit=500&format=json`;
  const res = await get(fetchFn, url);
  if (!res) throw new Error(`${category}: could not reach the list`);
  // A silent zero here looked exactly like "this list is empty".
  if (!res.ok) throw new Error(`${category}: HTTP ${res.status}`);
  const data = (await res.json()) as { query?: { categorymembers?: { title?: string }[] } };
  return (data.query?.categorymembers ?? [])
    .map((m) => m.title ?? "")
    .filter((t) => t && !/^Category:/.test(t));
}

async function probe(name: string, fetchFn: Fetcher): Promise<BoardHit | null> {
  for (const slug of slugCandidates(name)) {
    const gh = await get(fetchFn, `https://boards-api.greenhouse.io/v1/boards/${slug}`);
    if (gh?.ok) {
      const board = (await gh.json()) as { name?: string };
      if (sameCompany(name, board.name ?? "")) {
        const jobs = await get(
          fetchFn,
          `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
        );
        const list = jobs?.ok ? ((await jobs.json()) as { jobs?: unknown[] }).jobs ?? [] : [];
        // A board with no openings is not supply; adding it only creates noise.
        if (list.length === 0) continue;
        return { name: board.name ?? name, source: "greenhouse", ident: slug, openRoles: list.length };
      }
    }

    const ashby = await get(fetchFn, `https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    if (ashby?.ok) {
      const data = (await ashby.json()) as { jobs?: unknown[] };
      const count = data.jobs?.length ?? 0;
      if (count) {
        const title = await pageTitle(fetchFn, `https://jobs.ashbyhq.com/${slug}`);
        if (title ? sameCompany(name, title) : norm(name) === slug) {
          return { name, source: "ashby", ident: slug, openRoles: count };
        }
      }
    }

    const lever = await get(fetchFn, `https://api.lever.co/v0/postings/${slug}?mode=json`);
    if (lever?.ok) {
      const data = await lever.json();
      const count = Array.isArray(data) ? data.length : 0;
      if (count) {
        const title = await pageTitle(fetchFn, `https://jobs.lever.co/${slug}`);
        if (title ? sameCompany(name, title) : norm(name) === slug) {
          return { name, source: "lever", ident: slug, openRoles: count };
        }
      }
    }
  }
  return null;
}

export interface ListOptions {
  /** Company names already in the directory; they are not probed again. */
  known?: Set<string>;
  /** Names probed on an earlier run and found to have no board. */
  skip?: Set<string>;
  limit?: number;
  concurrency?: number;
  fetchFn?: Fetcher;
  categories?: string[];
}

export async function discoverFromList(options: ListOptions = {}): Promise<ListDiscovery> {
  const fetchFn = options.fetchFn ?? fetch;
  const concurrency = Math.max(1, Math.min(10, options.concurrency ?? 6));
  const categories = options.categories ?? CATEGORIES;

  const errors: { name: string; message: string }[] = [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const category of categories) {
    let found: string[] = [];
    try {
      found = await categoryNames(category, fetchFn);
    } catch (err) {
      errors.push({ name: category, message: (err as Error).message });
      continue;
    }
    for (const name of found) {
      const key = norm(name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }

  const limit = Math.max(1, options.limit ?? 120);
  const targets = names
    .filter((name) => !options.known?.has(norm(name)) && !options.skip?.has(norm(name)))
    .slice(0, limit);
  const hits: BoardHit[] = [];

  for (let i = 0; i < targets.length; i += concurrency) {
    const chunk = targets.slice(i, i + concurrency);
    const results = await Promise.all(
      chunk.map(async (name) => {
        try {
          return await probe(name, fetchFn);
        } catch (err) {
          errors.push({ name, message: (err as Error).message });
          return null;
        }
      }),
    );
    for (const hit of results) if (hit) hits.push(hit);
  }

  return { names: names.length, probed: targets.length, hits, checked: targets, errors };
}
