import type { Comp, Job } from "../types.ts";
import type { Company, Market } from "../config.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";
import { env } from "../util.ts";

const BASE = "https://api.adzuna.com/v1/api/jobs";

/**
 * Adzuna is the only aggregator here that answers "what is open across this
 * country" without a company list. It covers 16 markets and does not cover
 * Israel, so this source stays disabled unless the market names a country and
 * credentials are present.
 */
export function mapResults(data: unknown, market: Market): Job[] {
  const items = asArray<Record<string, unknown>>(pick(data, ["results"]));
  const jobs: Job[] = [];

  for (const item of items) {
    const title = pick<string>(item, ["title"]) ?? "";
    if (!title) continue;

    const company = pick<unknown>(item, ["company"]);
    const companyName = pick<string>(company, ["display_name"]) ?? "Unknown";
    const location = pick<unknown>(item, ["location"]);
    const locationName = pick<string>(location, ["display_name"]) ?? "";

    const min = pick<number>(item, ["salary_min"]);
    const max = pick<number>(item, ["salary_max"]);
    const amount = typeof min === "number" ? min : typeof max === "number" ? max : undefined;
    const comp: Comp | undefined =
      amount && amount > 1000
        ? { amount: Math.round(amount), currency: market.currency, period: "year" }
        : undefined;

    jobs.push(
      buildJob(
        {
          source: "adzuna",
          company: companyName,
          title,
          url: pick<string>(item, ["redirect_url"]) ?? "",
          locations: locationName ? [locationName] : [],
          remote: /\bremote\b/i.test(locationName),
          description: pick<string>(item, ["description"]) ?? "",
          postedAt: pick<string>(item, ["created"]) ?? undefined,
          comp,
        },
        market,
      ),
    );
  }
  return jobs;
}

export const adzuna: Source = {
  name: "adzuna",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const errors: SourceResult["errors"] = [];
    const jobs: Job[] = [];

    const appId = env("ADZUNA_APP_ID");
    const appKey = env("ADZUNA_APP_KEY");
    const country = (ctx.market as Market & { adzuna_country?: string }).adzuna_country;

    if (!appId || !appKey) {
      return {
        jobs,
        errors: [{ source: "adzuna", message: "ADZUNA_APP_ID / ADZUNA_APP_KEY not set" }],
      };
    }
    if (!country) {
      return { jobs, errors: [{ source: "adzuna", message: "market has no adzuna_country" }] };
    }

    const pages = Math.max(1, Math.min(10, Number(env("ADZUNA_PAGES") ?? 3)));
    for (let page = 1; page <= pages; page++) {
      const url =
        `${BASE}/${encodeURIComponent(country)}/search/${page}` +
        `?app_id=${encodeURIComponent(appId)}` +
        `&app_key=${encodeURIComponent(appKey)}` +
        "&results_per_page=50&content-type=application/json";
      try {
        const data = await getJson(url);
        const mapped = mapResults(data, ctx.market);
        jobs.push(...mapped);
        if (mapped.length < 50) break;
      } catch (err) {
        errors.push({ source: "adzuna", message: `page ${page}: ${(err as Error).message}` });
        break;
      }
    }

    return { jobs, errors };
  },
};

export function adzunaCompany(): Company {
  return { name: "Adzuna", source: "adzuna" };
}
