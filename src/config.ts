import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { Comp } from "./types.ts";
import { configDir, warn } from "./util.ts";

export { FIELDS, DEFAULT_FIELD, fieldById } from "./fields.ts";
export type { Field } from "./fields.ts";

export interface Track {
  key: string;
  label: string;
  enabled: boolean;
  weight: number;
  order: number;
  brief: string;
  title_include: string[];
  title_exclude: string[];
}

export interface ProfileLocations {
  allowed: string[];
  regions: string[];
  commute_max_minutes?: number;
  remote_ok: boolean;
  hybrid_ok: boolean;
  onsite_only_ok: boolean;
}

export interface Profile {
  name: string;
  email?: string;
  phone?: string;
  country: string;
  /** Filename of the CV this profile came from, shown in the UI. */
  cv_file?: string;
  /** The kind of work being searched for. Only one field is supported today. */
  field?: string;
  experience: {
    total_years: number;
    management_years: number;
    max_team_size?: number;
    employment_status?: string;
  };
  headline?: string;
  current_title?: string;
  previous_titles?: string[];
  domains: string[];
  /** Fields the candidate wants to move into, beyond what the CV proves. */
  interests: string[];
  stack: string[];
  ai_practice: string[];
  people_management: string[];
  languages?: Record<string, string>;
  education?: { degree?: string; institution?: string };
  military?: { unit?: string; rank?: string };
  citizenship?: string[];
  comp_floor: Comp | null;
  locations: ProfileLocations;
  authorization_must_pass: boolean;
}

export interface Market {
  country: string;
  currency: string;
  comp_period: string;
  sources: Record<string, { enabled: boolean; note?: string }>;
  clearance_patterns: string[];
  exclude_title_patterns: string[];
  city_aliases: Record<string, string>;
  /** Currency code -> the strings that represent it in postings. */
  currency_markers: Record<string, string[]>;
  /** Country code for the Adzuna feed, when this market has one. */
  adzuna_country?: string;
  /** How this country is written in postings. */
  country_names: string[];
  /** Regions that mean "remote, but not for candidates in this market".
   *  A remote posting whose location names one of these is dropped. */
  remote_deny_regions: string[];
}

export interface Company {
  name: string;
  source: string;
  slug?: string;
  uid?: string;
  token?: string;
}

function readYaml<T>(name: string): T {
  const dir = configDir();
  const path = resolve(dir, name);
  if (!existsSync(path)) {
    throw new Error(
      `missing ${name} in ${dir}.\n` +
        "Nothing user-specific is stored in the repository. Create your config first:\n" +
        "  npm run init\n" +
        "then edit the files it creates, or point at an existing directory with --config <dir>.",
    );
  }
  const value = parse(readFileSync(path, "utf8")) as T;
  if (value === null || value === undefined) {
    throw new Error(`${path} is empty`);
  }
  return value;
}

/**
 * config/profile.yaml is generated from your CV (`npm run profile`) or copied
 * from templates/. It is input, never a hardcoded default.
 */
export function loadProfile(): Profile {
  const p = readYaml<Profile>("profile.yaml");

  if (!p.name || p.name === "Your Name") {
    throw new Error(
      `${configDir()}/profile.yaml has no name. Run: npm run profile -- <cv.pdf> ` +
        "or edit the file by hand.",
    );
  }
  if (!p.experience) throw new Error(`${configDir()}/profile.yaml: experience block is required`);

  p.locations = {
    allowed: [],
    regions: [],
    remote_ok: true,
    hybrid_ok: true,
    onsite_only_ok: false,
    ...(p.locations ?? {}),
  };
  p.comp_floor = p.comp_floor ?? null;
  p.authorization_must_pass = p.authorization_must_pass ?? true;
  p.domains = p.domains ?? [];
  p.interests = p.interests ?? [];
  p.field = p.field ?? "it";
  p.stack = p.stack ?? [];
  p.ai_practice = p.ai_practice ?? [];
  p.people_management = p.people_management ?? [];

  if (!p.experience.total_years) {
    throw new Error(
      `${configDir()}/profile.yaml: experience.total_years must be greater than 0`,
    );
  }
  if (!p.stack.length) warn("profile: stack is empty — scoring quality will suffer");
  if (!p.domains.length) warn("profile: domains is empty — scoring quality will suffer");
  if (!p.locations.allowed.length && !p.locations.regions.length) {
    warn("profile: no commute radius set — on-site roles will not be filtered by location");
  }
  return p;
}

export function loadTracks(): Track[] {
  const raw = readYaml<{ tracks: Record<string, Omit<Track, "key">> }>("tracks.yaml");
  if (!raw.tracks) throw new Error("config/tracks.yaml: tracks block is required");
  return Object.entries(raw.tracks).map(([key, t]) => ({
    key,
    label: t.label ?? key,
    enabled: t.enabled ?? true,
    weight: t.weight ?? 1,
    order: t.order ?? 99,
    brief: t.brief ?? "",
    title_include: t.title_include ?? [],
    title_exclude: t.title_exclude ?? [],
  }));
}

export function loadMarket(): Market {
  const m = readYaml<Market>("market.yaml");
  if (!m.country) throw new Error("config/market.yaml: country is required");
  if (!m.currency) throw new Error("config/market.yaml: currency is required");
  if (!m.comp_period) throw new Error("config/market.yaml: comp_period is required");
  m.sources = m.sources ?? {};
  m.clearance_patterns = m.clearance_patterns ?? [];
  m.exclude_title_patterns = m.exclude_title_patterns ?? [];
  m.city_aliases = m.city_aliases ?? {};
  m.currency_markers = m.currency_markers ?? {};
  m.remote_deny_regions = m.remote_deny_regions ?? [];
  m.country_names = m.country_names ?? [];
  return m;
}

/** Optional: the tenant directory in the database is the primary source, and
 *  this file only holds manual pins. */
export function loadCompanies(): Company[] {
  const path = resolve(configDir(), "companies.yaml");
  if (!existsSync(path)) return [];
  const raw = readYaml<{ companies: Company[] | null }>("companies.yaml");
  const list = raw.companies ?? [];
  const valid: Company[] = [];
  for (const c of list) {
    if (!c || !c.name || !c.source) continue;
    if (c.source === "comeet" && (!c.uid || !c.token)) continue;
    if (c.source !== "comeet" && !c.slug) continue;
    valid.push(c);
  }
  return valid;
}

/** Changes whenever the profile or track briefs change, forcing a re-score. */
export function profileHash(profile: Profile, tracks: Track[]): string {
  const payload = JSON.stringify({
    experience: profile.experience,
    stack: profile.stack,
    domains: profile.domains,
    ai_practice: profile.ai_practice,
    people_management: profile.people_management,
    comp_floor: profile.comp_floor,
    locations: profile.locations,
    tracks: tracks.map((t) => ({ key: t.key, brief: t.brief, weight: t.weight })),
  });
  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}
