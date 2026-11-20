import type { Job } from "../types.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";

/** One global feed, not per-company. Noisy; the filters do the work. */
export const remoteok: Source = {
  name: "remoteok",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const jobs: Job[] = [];
    const errors: SourceResult["errors"] = [];
    try {
      const data = await getJson("https://remoteok.com/api");
      // Element 0 is a legal notice, not a job.
      const list = asArray<unknown>(data).slice(1);
      for (const j of list) {
        const title = pick<string>(j, ["position", "title"]) ?? "";
        const company = pick<string>(j, ["company", "company_name"]) ?? "";
        if (!title || !company) continue;
        jobs.push(
          buildJob(
            {
              source: "remoteok",
              company,
              title,
              url: pick<string>(j, ["url", "apply_url"]) ?? "",
              locations: [pick<string>(j, ["location"]) ?? "Remote"],
              remote: true,
              description: pick<string>(j, ["description", "description_html"]) ?? "",
              postedAt: pick<string>(j, ["date", "epoch"]) ?? undefined,
            },
            ctx.market,
          ),
        );
      }
    } catch (err) {
      errors.push({ source: "remoteok", message: (err as Error).message });
    }
    return { jobs, errors };
  },
};
