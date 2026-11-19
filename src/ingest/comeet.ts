import type { Job } from "../types.ts";
import type { Company, Market } from "../config.ts";
import type { Source, SourceResult, IngestCtx } from "./types.ts";
import { asArray, getJson, pick } from "./types.ts";
import { buildJob } from "../enrich/index.ts";

const BASE = "https://www.comeet.co/careers-api/2.0/company";

interface ComeetDetail {
  name?: string;
  value?: string;
}

/**
 * The Careers API returns a JSON array at the top level, not an object with a
 * `positions` key. It also has no `description` field: the text lives in a
 * `details` array of named sections. Both shaped the first version of this
 * adapter into silently returning zero jobs.
 */
export function mapPositions(data: unknown, company: Company, market: Market): Job[] {
  const positions = Array.isArray(data)
    ? data
    : asArray(pick<unknown[]>(data, ["positions", "data", "jobs"]));

  const jobs: Job[] = [];
  for (const p of positions) {
    const title = pick<string>(p, ["name", "title", "position_name"]) ?? "";
    if (!title) continue;

    const loc = pick<unknown>(p, ["location", "locations"]);
    const locName =
      typeof loc === "string" ? loc : (pick<string>(loc, ["name", "city"]) ?? "");

    const workplace = String(pick<string>(p, ["workplace_type"]) ?? "").toLowerCase();
    const isRemote = workplace.includes("remote") || Boolean(pick<boolean>(loc, ["is_remote"]));

    const description = asArray<ComeetDetail>(pick(p, ["details", "description_details"]))
      .map((d) => {
        if (!d?.value) return "";
        // "Description" is the body; anything else is a section heading worth keeping.
        return d.name && !/^description$/i.test(d.name) ? `## ${d.name}\n${d.value}` : d.value;
      })
      .filter(Boolean)
      .join("\n");

    const uid = pick<string>(p, ["uid", "id", "position_uid"]) ?? "";
    const url =
      pick<string>(p, ["url_active_page", "url_comeet_hosted_page", "url"]) ??
      (company.uid ? `https://www.comeet.com/jobs/${company.uid}/${uid}` : "");

    jobs.push(
      buildJob(
        {
          source: "comeet",
          company: company.name,
          title,
          url,
          locations: locName ? [locName] : [],
          remote: isRemote,
          description,
          postedAt:
            pick<string>(p, ["time_updated", "updated_at", "created_at"]) ?? undefined,
        },
        market,
      ),
    );
  }
  return jobs;
}

export const comeet: Source = {
  name: "comeet",

  async fetch(ctx: IngestCtx): Promise<SourceResult> {
    const jobs: Job[] = [];
    const errors: SourceResult["errors"] = [];

    for (const co of ctx.companies.filter((c) => c.source === "comeet")) {
      const url = `${BASE}/${encodeURIComponent(co.uid!)}/positions?token=${encodeURIComponent(co.token!)}&details=true`;
      try {
        const data = await getJson(url);
        const mapped = mapPositions(data, co, ctx.market);
        if (!mapped.length) {
          errors.push({ source: "comeet", message: `${co.name}: returned 0 positions` });
          continue;
        }
        jobs.push(...mapped);
      } catch (err) {
        errors.push({ source: "comeet", message: `${co.name}: ${(err as Error).message}` });
      }
    }

    return { jobs, errors };
  },
};
