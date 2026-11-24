import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where user-supplied configuration lives. Overridable at runtime with
 * `--config <dir>` or `JOBCONFIG_DIR`, because the repository ships templates,
 * not anybody's actual profile, market or company list.
 */
let activeConfigDir = resolve(ROOT, "config");

export function setConfigDir(dir: string): void {
  activeConfigDir = resolve(process.cwd(), dir);
}

export function configDir(): string {
  return activeConfigDir;
}

/** The database and digests belong to a config, so two markets cannot mix. */
export function dbPath(): string {
  return resolve(activeConfigDir, "jobs.db");
}

export function outDir(): string {
  return resolve(activeConfigDir, "out");
}

/** Shipped, non-personal starting points. */
export function templatesDir(): string {
  return resolve(ROOT, "templates");
}

/** Minimal .env loader. No dependency, no surprises. */
export function loadEnv(path = resolve(ROOT, ".env")): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function numEnv(name: string, fallback: number): number {
  const v = env(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function log(msg: string): void {
  console.log(msg);
}

export function warn(msg: string): void {
  console.error("  ! " + msg);
}

export function fail(msg: string): never {
  console.error("\nerror: " + msg + "\n");
  process.exit(1);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Flags are produced as machine tokens (`org_size_unclear`) and read by people.
 * The underscore is the only part that is noise.
 */
export function readableFlag(flag: string): string {
  return flag.replace(/_/g, " ").trim();
}

/** Quotes and backslashes are the only characters that break the script. */
export function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * A background job's only reader is a log file, and nobody reads those. On a
 * failure the person who owns the machine gets a desktop notification.
 * Every failure mode here is silent: a notification must never fail a run.
 */
export function notify(title: string, message: string): void {
  if (env("NOTIFY") === "0") return;
  if (process.platform !== "darwin") return;
  try {
    execFileSync(
      "osascript",
      [
        "-e",
        `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`,
      ],
      { stdio: "ignore", timeout: 5_000 },
    );
  } catch {
    /* no desktop session, no permission, no problem */
  }
}
