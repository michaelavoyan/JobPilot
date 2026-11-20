import type { Comp, Job, Period } from "../types.ts";
import type { Market } from "../config.ts";
import { clean, detectLang, jobId, repairMojibake } from "./normalize.ts";
import { extractComp } from "./comp.ts";
import { canonicalLocation } from "./location.ts";

export interface RawJob {
  source: string;
  company: string;
  title: string;
  url: string;
  locations: string[];
  remote?: boolean;
  description: string;
  postedAt?: string;
  comp?: Comp;
}

/**
 * The single place where a raw source posting becomes a canonical Job.
 * Every adapter funnels through here, which is why adding an ATS is short.
 */
export function buildJob(raw: RawJob, market: Market): Job {
  const description = clean(raw.description ?? "");
  const rawLocations = (raw.locations ?? []).map((s) => repairMojibake(s ?? ""));
  const { cities, remote } = canonicalLocation(rawLocations, market.city_aliases);
  const locations = cities.length ? cities : rawLocations.map((s) => s.trim()).filter(Boolean);

  return {
    id: jobId(raw.company, raw.title, locations),
    source: raw.source,
    company: raw.company.trim(),
    title: repairMojibake(raw.title).trim(),
    url: raw.url || "",
    locations,
    remote: Boolean(raw.remote) || remote,
    description,
    postedAt: raw.postedAt,
    comp:
      raw.comp ??
      extractComp(description, {
        markers: market.currency_markers,
        defaultPeriod: market.comp_period as Period,
        currency: market.currency,
      }),
    lang: detectLang(description + "\n" + raw.title),
    country: market.country,
  };
}
