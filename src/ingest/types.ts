import type { Company, Market } from "../config.ts";
import type { Job, SourceError } from "../types.ts";

export interface IngestCtx {
  companies: Company[];
  market: Market;
  warn: (msg: string) => void;
}

export interface SourceResult {
  jobs: Job[];
  errors: SourceError[];
}

export interface Source {
  name: string;
  fetch(ctx: IngestCtx): Promise<SourceResult>;
}

export function enabled(ctx: IngestCtx, name: string): boolean {
  return ctx.market.sources?.[name]?.enabled === true;
}

/** Read the first defined key. Upstream renames degrade to undefined instead
 *  of throwing and taking a whole run down. */
export function pick<T = unknown>(obj: unknown, keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "JobPilot/0.1", ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Central place so `dump` and the adapters cannot drift apart. */
export function apiUrl(company: Company): string {
  switch (company.source) {
    case "comeet":
      return `https://www.comeet.co/careers-api/2.0/company/${encodeURIComponent(company.uid ?? "")}/positions?token=${encodeURIComponent(company.token ?? "")}&details=true`;
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug ?? "")}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${encodeURIComponent(company.slug ?? "")}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.slug ?? "")}?includeCompensation=true`;
    case "remoteok":
      return "https://remoteok.com/api";
    default:
      return "";
  }
}
