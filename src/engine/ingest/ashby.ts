import type { Comp, Job } from "../types.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";

function ashbyComp(raw: unknown): Comp | undefined {
  const summary = pick<unknown>(raw, ["compensationTierSummary", "compensation"]);
  if (typeof summary === "string") {
    const m = summary.replace(/,/g, "").match(/(\d{2,3}(?:\.\d+)?)\s*[kK]/);
    if (!m) return undefined;
    return { amount: Math.round(Number(m[1]) * 1000), currency: "ILS", period: "month", raw: summary };
  }
  const tiers = asArray<unknown>(pick(summary, ["compensationTiers"]));
  for (const t of tiers) {
    const components = asArray<unknown>(pick(t, ["components"]));
    for (const c of components) {
      const min = pick<number>(c, ["minValue", "min"]);
      const cur = pick<string>(c, ["currencyCode", "currency"]);
      const interval = pick<string>(c, ["interval"]);
      if (typeof min === "number" && cur) {
        return {
          amount: min,
          currency: cur,
          period: interval === "YEAR" ? "year" : "month",
        };
      }
    }
  }
  return undefined;
}

export const ashby: Source = {
  name: "ashby",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const jobs: Job[] = [];
    const errors: SourceResult["errors"] = [];
    const targets = ctx.companies.filter((c) => c.source === "ashby");

    for (const co of targets) {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(co.slug!)}?includeCompensation=true`;
      try {
        const data = await getJson(url);
        const list = asArray(pick<unknown[]>(data, ["jobs"]));
        if (!list.length) {
          errors.push({ source: "ashby", message: `${co.name}: returned 0 jobs` });
          continue;
        }

        for (const j of list) {
          const title = pick<string>(j, ["title", "name"]) ?? "";
          if (!title) continue;
          const locName = pick<string>(j, ["location", "locationName"]) ?? "";
          const secondary = asArray<string>(pick(j, ["secondaryLocations"]))
            .map((s) => (typeof s === "string" ? s : pick<string>(s, ["location"]) ?? ""))
            .filter(Boolean);

          jobs.push(
            buildJob(
              {
                source: "ashby",
                company: co.name,
                title,
                url: pick<string>(j, ["jobUrl", "applyUrl", "url"]) ?? "",
                locations: [locName, ...secondary].filter(Boolean),
                remote: Boolean(pick<boolean>(j, ["isRemote"])) || /remote/i.test(locName),
                description: pick<string>(j, ["descriptionPlain", "descriptionHtml", "description"]) ?? "",
                postedAt: pick<string>(j, ["publishedAt", "updatedAt"]) ?? undefined,
                comp: ashbyComp(j),
              },
              ctx.market,
            ),
          );
        }
      } catch (err) {
        errors.push({ source: "ashby", message: `${co.name}: ${(err as Error).message}` });
      }
    }

    return { jobs, errors };
  },
};
