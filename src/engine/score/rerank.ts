import type { Job, Score } from "../types.ts";
import { loadMarket } from "../config.ts";
import type { Profile, Track } from "../config.ts";
import { chat, estimateCost } from "./llm.ts";
import { buildSystem, buildUser } from "./prompt.ts";
import { extractJson } from "./json.ts";


export { extractJson };

export interface ScoreRequest {
  job: Job;
  /** Track keys this job survived the filter for. */
  tracks: string[];
}

export interface ScoreOutcome {
  scores: Score[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Subscription allowance consumed, when the gateway reports it. */
  allowanceUsd: number;
  model: string;
  failed: { job: Job; reason: string }[];
}

interface RawScore {
  score?: unknown;
  reasons?: unknown;
  flags?: unknown;
}

function clampScore(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === "string")
    .map((v) => (v as string).replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, max);
}

export interface ParsedBatch {
  scores: Score[];
  missing: number[];
}

export function parseBatch(payload: unknown, batch: ScoreRequest[]): ParsedBatch {
  const scores: Score[] = [];
  const missing: number[] = [];
  if (!payload || typeof payload !== "object") return { scores, missing: batch.map((_, i) => i) };

  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return { scores, missing: batch.map((_, i) => i) };

  const byIndex = new Map<number, RawScore[]>();
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const i = Number((entry as { i?: unknown }).i);
    if (!Number.isInteger(i)) continue;
    const map = (entry as { scores?: unknown }).scores;
    if (map && typeof map === "object") {
      byIndex.set(i, [map as RawScore]);
    }
  }

  batch.forEach((req, i) => {
    const container = byIndex.get(i)?.[0] as Record<string, RawScore> | undefined;
    if (!container) {
      missing.push(i);
      return;
    }
    let produced = 0;
    for (const trackKey of req.tracks) {
      const raw = container[trackKey];
      const score = clampScore(raw?.score);
      if (score === null) continue;
      scores.push({
        jobId: req.job.id,
        track: trackKey,
        score,
        reasons: toStringArray(raw?.reasons, 3),
        flags: toStringArray(raw?.flags, 4),
      });
      produced++;
    }
    if (produced < req.tracks.length) missing.push(i);
  });

  return { scores, missing };
}

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function scoreJobs(
  requests: ScoreRequest[],
  tracks: Track[],
  profile: Profile,
  options: { batchSize: number; concurrency: number },
): Promise<ScoreOutcome> {
  const outcome: ScoreOutcome = {
    scores: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    allowanceUsd: 0,
    model: "",
    failed: [],
  };
  if (!requests.length) return outcome;

  const briefs = tracks.filter((t) => requests.some((r) => r.tracks.includes(t.key)));
  const system = buildSystem(loadMarket().country);
  let anyReportedCost = false;

  /**
   * A batch that hits the output limit has not failed, it is simply too big.
   * Splitting it in half recovers the work instead of throwing it away.
   */
  const processBatch = async (batch: ScoreRequest[]): Promise<void> => {
    if (!batch.length) return;

    const user = buildUser(profile, briefs, batch);
    let parsed: ParsedBatch | null = null;
    let issue = "unknown";
    let truncated = false;
    let feedback = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await chat(system, attempt === 0 ? user : user + feedback);
        outcome.tokensIn += res.tokensIn;
        outcome.tokensOut += res.tokensOut;
        outcome.model = res.model;
        if (res.costUsd !== undefined) {
          outcome.costUsd += res.costUsd;
          anyReportedCost = true;
        }
        if (res.allowanceUsd !== undefined) outcome.allowanceUsd += res.allowanceUsd;

        if (res.finishReason === "length") {
          truncated = true;
          issue = "truncated";
          break;
        }

        const payload = extractJson(res.text);
        if (!payload) {
          issue = "invalid_json";
          feedback = "\n\nYour previous reply was not valid JSON. Return only the JSON object.";
          continue;
        }

        const candidate = parseBatch(payload, batch);
        parsed = candidate;
        if (candidate.missing.length === 0) break;
        issue = `missing_indices:${candidate.missing.join(",")}`;
        feedback = `\n\nYour previous reply omitted job indices: ${candidate.missing.join(", ")}. Include every index.`;
      } catch (err) {
        issue = (err as Error).message.slice(0, 80);
        feedback = `\n\nPrevious attempt failed with: ${(err as Error).message}`;
      }
    }

    if (truncated && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      await processBatch(batch.slice(0, mid));
      await processBatch(batch.slice(mid));
      return;
    }

    if (!parsed) {
      // Never write 0: a fake zero would poison ranking and the eval set.
      for (const req of batch) {
        outcome.failed.push({ job: req.job, reason: `scoring_failed:${issue}` });
      }
      return;
    }

    outcome.scores.push(...parsed.scores);
    for (const i of parsed.missing) {
      outcome.failed.push({ job: batch[i].job, reason: `scoring_incomplete:${issue}` });
    }
  };

  const chunks: ScoreRequest[][] = [];
  for (let i = 0; i < requests.length; i += options.batchSize) {
    chunks.push(requests.slice(i, i + options.batchSize));
  }

  await runPool(chunks, options.concurrency, (chunk) => processBatch(chunk));

  if (!anyReportedCost) {
    outcome.costUsd = estimateCost(outcome.tokensIn, outcome.tokensOut);
  }
  return outcome;
}
