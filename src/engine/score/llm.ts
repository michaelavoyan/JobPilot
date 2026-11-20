import { randomUUID } from "node:crypto";
import { env, sleep, warn } from "../util.ts";

export type Provider = "anthropic" | "opencode" | "deepseek" | "openai";

export interface ChatResult {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** "stop", "length", "max_tokens" — "length" means the reply was cut off. */
  finishReason?: string;
  /** Real charge when the provider reports one. */
  costUsd?: number;
  /** Subscription allowance consumed, when the provider reports it. */
  allowanceUsd?: number;
}

/** OpenCode Go requires a stable session header to route efficiently. */
const OPENCODE_SESSION = randomUUID();

/**
 * Provider selection is by which key is present. OpenCode Go sits just below
 * Anthropic because it is a gateway that can serve many models.
 */
export function provider(): Provider | null {
  if (env("ANTHROPIC_API_KEY")) return "anthropic";
  if (env("OPENCODE_API_KEY")) return "opencode";
  if (env("DEEPSEEK_API_KEY")) return "deepseek";
  if (env("OPENAI_API_KEY")) return "openai";
  return null;
}

export function requireModel(): string {
  const model = env("LLM_MODEL");
  if (!model) {
    throw new Error(
      "LLM_MODEL is not set. Add it to .env (see .env.example). " +
        "No default is assumed because a wrong model id fails at request time, not at startup.",
    );
  }
  return model;
}

/**
 * Reasoning models spend output tokens on hidden thinking before writing the
 * answer. Too small a budget yields an empty reply, which looks like a broken
 * model rather than a truncated one.
 */
export function maxOutputTokens(): number {
  const n = Number(env("LLM_MAX_TOKENS") ?? 4096);
  return Number.isFinite(n) && n > 0 ? Math.min(32_000, Math.round(n)) : 4096;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const message = String((err as Error).message ?? "");
      const retryable = /\b(429|500|502|503|504|overloaded|timeout)\b/i.test(message);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

export async function chat(system: string, user: string, maxTokens = maxOutputTokens()): Promise<ChatResult> {
  const p = provider();
  if (!p) {
    throw new Error(
      "No LLM key. Set OPENCODE_API_KEY, ANTHROPIC_API_KEY, DEEPSEEK_API_KEY or OPENAI_API_KEY in .env",
    );
  }
  const model = requireModel();

  const call = (budget: number): Promise<ChatResult> =>
    p === "anthropic"
      ? anthropic(system, user, model, budget)
      : p === "opencode"
        ? openAiCompatible({
            label: "opencode",
            baseUrl: env("OPENCODE_BASE_URL") ?? "https://opencode.ai/inference/go/v1",
            apiKey: env("OPENCODE_API_KEY")!,
            model,
            system,
            user,
            maxTokens: budget,
            extraHeaders: {
              "user-agent": "jobpilot/0.1",
              "x-opencode-session": OPENCODE_SESSION,
            },
            reportsCost: true,
          })
        : p === "deepseek"
          ? openAiCompatible({
              label: "deepseek",
              baseUrl: env("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com",
              apiKey: env("DEEPSEEK_API_KEY")!,
              model,
              system,
              user,
              maxTokens: budget,
            })
          : openAiCompatible({
              label: "openai",
              baseUrl: env("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
              apiKey: env("OPENAI_API_KEY")!,
              model,
              system,
              user,
              maxTokens: budget,
            });

  // Reasoning models can spend the whole budget thinking and answer with
  // nothing. Escalating the budget is cheaper and more reliable than failing,
  // and far better than silently treating an empty reply as "no match".
  let budget = maxTokens;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await call(budget);
    if (result.text.trim()) return result;
    if (result.tokensOut === 0) return result;
    if (budget >= 32_000) {
      throw new Error(
        `${result.model} returned no content even with a ${budget}-token budget. ` +
          "Try a different LLM_MODEL.",
      );
    }
    budget = Math.min(32_000, budget * 2);
    warn(`${result.model} answered with reasoning only; retrying with ${budget} output tokens`);
  }
  throw new Error(`${model} returned no content after three attempts`);
}

async function anthropic(
  system: string,
  user: string,
  model: string,
  maxTokens: number,
): Promise<ChatResult> {
  const res = await withRetry(() =>
    fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env("ANTHROPIC_API_KEY")!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(120_000),
    }),
  );
  if (!res.ok) throw new Error(`anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return {
    text,
    model,
    tokensIn: data.usage?.input_tokens ?? 0,
    tokensOut: data.usage?.output_tokens ?? 0,
    finishReason: data.stop_reason,
  };
}

/** Shared by DeepSeek, OpenAI and OpenCode Go: same request and response shape. */
async function openAiCompatible(opts: {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  extraHeaders?: Record<string, string>;
  reportsCost?: boolean;
}): Promise<ChatResult> {
  const url = opts.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const res = await withRetry(() =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`,
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    }),
  );
  if (!res.ok) {
    throw new Error(`${opts.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
      opencode?: { allowance?: number };
    };
  };
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    model: opts.model,
    tokensIn: data.usage?.prompt_tokens ?? 0,
    tokensOut: data.usage?.completion_tokens ?? 0,
    finishReason: data.choices?.[0]?.finish_reason,
    costUsd: opts.reportsCost ? data.usage?.cost : undefined,
    allowanceUsd: data.usage?.opencode?.allowance,
  };
}

/**
 * Coarse, clearly-labelled estimate. Override with LLM_PRICE_IN / LLM_PRICE_OUT
 * (USD per million tokens). Check your provider's current pricing; these are
 * only good enough to spot a runaway bill.
 */
export function estimateCost(tokensIn: number, tokensOut: number): number {
  const p = provider();
  const defaults =
    p === "openai"
      ? { in: 0.5, out: 1.5 }
      : p === "deepseek"
        ? { in: 0.3, out: 1.2 }
        : { in: 3, out: 15 };
  const inPrice = Number(env("LLM_PRICE_IN") ?? defaults.in);
  const outPrice = Number(env("LLM_PRICE_OUT") ?? defaults.out);
  const cost = (tokensIn / 1e6) * inPrice + (tokensOut / 1e6) * outPrice;
  if (cost > 5) warn(`unusually high estimated cost for one batch: $${cost.toFixed(2)}`);
  return cost;
}
