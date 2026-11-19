import type { Company, Market } from "../config.ts";
import type { Job, SourceError } from "../types.ts";
import type { IngestCtx, Source } from "./types.ts";
import { comeet } from "./comeet.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { ashby } from "./ashby.ts";
import { remoteok } from "./remoteok.ts";
import { adzuna } from "./adzuna.ts";
import { deactivateMissing, type Db } from "../store/db.ts";
import { warn } from "../util.ts";

export const SOURCES: Source[] = [comeet, greenhouse, lever, ashby, adzuna, remoteok];

export interface CollectResult {
  jobs: Job[];
  errors: SourceError[];
  perSource: Record<string, number>;
}

export async function collect(
  companies: Company[],
  market: Market,
  db?: Db,
): Promise<CollectResult> {
  const enabledSources = SOURCES.filter((s) => market.sources?.[s.name]?.enabled === true);

  const ctx: IngestCtx = {
    companies,
    market,
    warn: (m) => warn(m),
  };

  const errors: SourceError[] = [];
  const jobs: Job[] = [];
  const perSource: Record<string, number> = {};

  // Sources are independent: one dying must not take the run down.
  const results = await Promise.all(
    enabledSources.map(async (source) => {
      try {
        return { source, result: await source.fetch(ctx) };
      } catch (err) {
        return {
          source,
          result: { jobs: [], errors: [{ source: source.name, message: (err as Error).message }] },
        };
      }
    }),
  );

  for (const { source, result } of results) {
    jobs.push(...result.jobs);
    errors.push(...result.errors);
    perSource[source.name] = result.jobs.length;

    // Only company-scoped sources can infer removal from absence. A country
    // feed returns a slice, so an unseen posting is not a closed one.
    if (db && source.name !== "adzuna") {
      const ids = result.jobs.filter((j) => j.source === source.name).map((j) => j.id);
      if (ids.length) deactivateMissing(db, source.name, ids);
    }
  }

  return { jobs, errors, perSource };
}
