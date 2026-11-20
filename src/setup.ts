import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "./util.ts";

/** Countries that ship a template. */
export function availableMarkets(): string[] {
  return readdirSync(templatesDir())
    .filter((file) => /^market\..+\.yaml$/.test(file))
    .map((file) => file.slice("market.".length, -".yaml".length))
    .sort();
}

export interface InitResult {
  created: string[];
  kept: string[];
  market: string;
}

/**
 * Seeds a config directory from the templates. Copies only what is missing, so
 * running it twice is safe, and it never creates a company file: the tenant
 * directory in the database owns that.
 */
export function initConfig(dir: string, market: string): InitResult {
  const markets = availableMarkets();
  if (!markets.includes(market)) {
    throw new Error(`unknown market "${market}". Available: ${markets.join(", ")}`);
  }

  const plan: [string, string][] = [
    ["profile.yaml", "profile.yaml"],
    ["tracks.yaml", "tracks.yaml"],
    [`market.${market}.yaml`, "market.yaml"],
  ];

  mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const kept: string[] = [];

  for (const [from, to] of plan) {
    const dest = join(dir, to);
    if (existsSync(dest)) {
      kept.push(to);
      continue;
    }
    copyFileSync(join(templatesDir(), from), dest);
    created.push(to);
  }

  return { created, kept, market };
}
