import type { Job } from "../types.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";

export const lever: Source = {
  name: "lever",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const jobs: Job[] = [];
    const errors: SourceResult["errors"] = [];
    const targets = ctx.companies.filter((c) => c.source === "lever");

    for (const co of targets) {
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(co.slug!)}?mode=json`;
      try {
        const data = await getJson(url);
        const list = asArray(pick<unknown[]>({ postings: data }, ["postings"]));
        if (!list.length) {
          errors.push({ source: "lever", message: `${co.name}: returned 0 postings` });
          continue;
        }

        for (const p of list) {
          const title = pick<string>(p, ["text", "title"]) ?? "";
          if (!title) continue;

          const categories = pick<unknown>(p, ["categories"]);
          const locName = pick<string>(categories, ["location", "allLocations"]) ?? "";

          jobs.push(
            buildJob(
              {
                source: "lever",
                company: co.name,
                title,
                url: pick<string>(p, ["hostedUrl", "applyUrl"]) ?? "",
                locations: locName ? [locName] : [],
                remote: /remote/i.test(locName),
                description:
                  [
                    pick<string>(p, ["descriptionPlain", "description"]),
                    pick<string>(p, ["additionalPlain", "additional"]),
                  ]
                    .filter(Boolean)
                    .join("\n\n") ?? "",
                postedAt: p && typeof p === "object" && "createdAt" in p
                  ? new Date(Number((p as Record<string, unknown>).createdAt)).toISOString()
                  : undefined,
              },
              ctx.market,
            ),
          );
        }
      } catch (err) {
        errors.push({ source: "lever", message: `${co.name}: ${(err as Error).message}` });
      }
    }

    return { jobs, errors };
  },
};
