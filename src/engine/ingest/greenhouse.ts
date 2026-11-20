import type { Job } from "../types.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";

export const greenhouse: Source = {
  name: "greenhouse",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const jobs: Job[] = [];
    const errors: SourceResult["errors"] = [];
    const targets = ctx.companies.filter((c) => c.source === "greenhouse");

    for (const co of targets) {
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(co.slug!)}/jobs?content=true`;
      try {
        const data = await getJson(url);
        const list = asArray(pick<unknown[]>(data, ["jobs"]));
        if (!list.length) {
          errors.push({ source: "greenhouse", message: `${co.name}: returned 0 jobs` });
          continue;
        }

        for (const j of list) {
          const title = pick<string>(j, ["title", "name"]) ?? "";
          if (!title) continue;

          const locObj = pick<unknown>(j, ["location"]);
          const locName =
            typeof locObj === "string" ? locObj : pick<string>(locObj, ["name"]) ?? "";
          const offices = asArray<unknown>(pick(j, ["offices", "departments"]))
            .map((o) => pick<string>(o, ["name"]) ?? "")
            .filter(Boolean);

          jobs.push(
            buildJob(
              {
                source: "greenhouse",
                company: co.name,
                title,
                url: pick<string>(j, ["absolute_url", "url"]) ?? "",
                locations: [locName, ...offices].filter(Boolean),
                remote: /remote/i.test(locName),
                description:
                  pick<string>(j, ["content", "description", "content_plain"]) ?? "",
                postedAt: pick<string>(j, ["updated_at", "created_at"]) ?? undefined,
              },
              ctx.market,
            ),
          );
        }
      } catch (err) {
        errors.push({
          source: "greenhouse",
          message: `${co.name}: ${(err as Error).message}`,
        });
      }
    }

    return { jobs, errors };
  },
};
