import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { spawn } from "node:child_process";
import {
  clearDecision,
  countScored,
  findJobByPrefix,
  getJob,
  isStage,
  open,
  recordDecision,
  STAGES,
  listDecisions,
  rejectSummary,
  stats,
  topScored,
  type Db,
} from "../storage/db.ts";
import { FIELDS, loadMarket, loadProfile, loadTracks } from "../engine/config.ts";
import { provider } from "../engine/score/llm.ts";
import { configDir, env, fail, loadEnv, log, ROOT, setConfigDir, templatesDir, today } from "../engine/util.ts";
import { runsDir } from "../engine/audit.ts";
import { extractProfile, readCv } from "../engine/profile/extract.ts";
import { profilePath, renderProfileYaml, writeProfile } from "../engine/profile/write.ts";

const ACTIONS = new Set([
  "sources",
  "collect",
  "score",
  "digest",
  "run",
  "stats",
  "eval",
  "init",
  "profile",
]);

export interface RunSpec {
  args: string[];
  env: Record<string, string>;
}

function intParam(
  q: URLSearchParams,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Turns UI parameters into a CLI invocation. Wholly allow-listed: the browser
 * can choose an action and numeric bounds, never an arbitrary command.
 */
export function buildRunSpec(q: URLSearchParams, cfgDir?: string): RunSpec {
  const action = q.get("action") ?? "";
  if (!ACTIONS.has(action)) throw new Error(`unknown action "${action}"`);

  const args: string[] = [action];
  const env: Record<string, string> = {};

  if (action === "score" || action === "run") {
    if (q.get("rescore") === "1") args.push("--rescore");
    const batch = intParam(q, "batchSize", 1, 20);
    if (batch) env.BATCH_SIZE = String(batch);
    const concurrency = intParam(q, "concurrency", 1, 8);
    if (concurrency) env.LLM_CONCURRENCY = String(concurrency);
  }

  if (action === "digest" || action === "run") {
    const minScore = intParam(q, "minScore", 0, 100);
    if (minScore !== undefined) env.MIN_SCORE = String(minScore);
    const rows = intParam(q, "maxRows", 1, 100);
    if (rows) env.MAX_DIGEST_ROWS = String(rows);
  }

  if (action === "init") {
    const market = q.get("market") ?? "il";
    if (!/^[a-z]{2}$/.test(market)) throw new Error("market must be a two-letter code");
    args.push("--market", market);
  }

  if (action === "profile") {
    const cv = (q.get("cv") ?? "").trim();
    if (!cv) throw new Error("a CV path is required");
    args.push(cv);
    if (q.get("force") === "1") args.push("--force");
    if (q.get("dry") === "1") args.push("--dry");
  }

  if (cfgDir) args.push("--config", cfgDir);
  return { args, env };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return false;

  const file = join(ROOT, "src", "ui", name);
  if (!resolve(file).startsWith(resolve(ROOT, "src", "ui") + sep)) return false;
  if (!existsSync(file)) return false;

  const body = await readFile(file);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(body);
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Results change on every run; a cached copy is always the wrong answer.
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, 1_000_000);
  if (!raw.length) return {};
  return JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
}

export interface ServerOptions {
  port?: number;
  cfgDir?: string;
}

export function startServer(options: ServerOptions = {}) {
  const port = options.port ?? 7788;
  const cfgDir = options.cfgDir;
  const db: Db = open();

  let running: ReturnType<typeof spawn> | null = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    try {
      if (await serveStatic(pathname, res)) return;

      if (pathname === "/api/state" && req.method === "GET") {
        let profile: Record<string, unknown> | null = null;
        let profileError: string | null = null;
        try {
          const p = loadProfile();
          const tracks = loadTracks().filter((t) => t.enabled);
          profile = {
            cvFile: p.cv_file ?? null,
            field: p.field ?? "it",
            headline: p.headline ?? "",
            years: p.experience.total_years,
            managementYears: p.experience.management_years,
            stack: p.stack.length,
            domains: p.domains.length,
            compFloor: p.comp_floor ?? null,
            locations: p.locations.allowed.length + p.locations.regions.length,
            tracks: tracks.map((t) => ({ key: t.key, label: t.label })),
          };
        } catch (err) {
          profileError = (err as Error).message;
        }

        let market: Record<string, unknown> | null = null;
        try {
          const m = loadMarket();
          market = { country: m.country, currency: m.currency, period: m.comp_period };
        } catch {
          market = null;
        }

        json(res, 200, {
          configDir: configDir(),
          llm: { configured: Boolean(provider()), model: env("LLM_MODEL") ?? null },
          profile,
          profileError,
          market,
          interests: (() => {
            try {
              return loadProfile().interests ?? [];
            } catch {
              return [];
            }
          })(),
          stats: stats(db),
          rejects: rejectSummary(db, 5),
          fields: FIELDS,
          markets: readdirSync(templatesDir())
            .filter((f) => /^market\..+\.yaml$/.test(f))
            .map((f) => f.slice(7, -5)),
          running: Boolean(running),
        });
        return;
      }

      if (pathname === "/api/cv" && req.method === "POST") {
        if (running) {
          json(res, 409, { error: "a run is in progress" });
          return;
        }
        const name = url.searchParams.get("name") ?? "cv.pdf";
        const ext = extname(name).toLowerCase() || ".pdf";
        const raw = await readRawBody(req, 12 * 1024 * 1024);
        if (!raw.length) {
          json(res, 400, { error: "the file is empty" });
          return;
        }

        const temp = join(tmpdir(), `jobpilot-cv-${Date.now()}${ext}`);
        writeFileSync(temp, raw);
        try {
          const text = await readCv(temp);
          const extracted = await extractProfile(text);

          const target = profilePath();
          const existed = existsSync(target);

          const generated = parse(
            renderProfileYaml(extracted, basename(name), today()),
          ) as Record<string, unknown>;

          // A CV cannot express preferences. Uploading must not silently wipe the
          // commute radius, salary floor or interests the user already set.
          if (existed) {
            const previous = parse(readFileSync(target, "utf8")) as Record<string, unknown>;
            for (const key of ["locations", "comp_floor", "interests", "authorization_must_pass"]) {
              if (previous[key] !== undefined) generated[key] = previous[key];
            }
          }

          const header =
            `# Generated by JobPilot from ${basename(name)} on ${today()}.\n` +
            "# Preferences (locations, comp_floor, interests) are preserved across uploads.\n";
          writeProfile(header + stringify(generated, { lineWidth: 0 }), { force: true });

          json(res, 200, {
            profile: {
              name: extracted.name,
              headline: extracted.headline ?? "",
              years: extracted.experience.total_years,
              managementYears: extracted.experience.management_years,
              domains: extracted.domains,
              stack: extracted.stack.slice(0, 12),
            },
            characters: text.length,
          });
        } finally {
          rmSync(temp, { force: true });
        }
        return;
      }

      if (pathname === "/api/market" && req.method === "POST") {
        if (running) {
          json(res, 409, { error: "a run is in progress" });
          return;
        }
        const body = await readJsonBody(req);
        const code = String(body.market ?? "");
        if (!/^[a-z]{2}$/.test(code)) {
          json(res, 400, { error: "market must be a two-letter code" });
          return;
        }
        const source = join(templatesDir(), `market.${code}.yaml`);
        if (!existsSync(source)) {
          const available = readdirSync(templatesDir())
            .filter((f) => /^market\..+\.yaml$/.test(f))
            .map((f) => f.slice(7, -5));
          json(res, 400, { error: `unknown market "${code}". Available: ${available.join(", ")}` });
          return;
        }
        const target = join(configDir(), "market.yaml");
        copyFileSync(source, target);
        const m = loadMarket();
        json(res, 200, { market: { country: m.country, currency: m.currency, period: m.comp_period } });
        return;
      }

      if (pathname === "/api/field" && req.method === "POST") {
        const body = await readJsonBody(req);
        const field = String(body.field ?? "");
        if (!FIELDS.some((f) => f.id === field)) {
          json(res, 400, { error: `unsupported field "${field}"` });
          return;
        }
        const target = profilePath();
        if (!existsSync(target)) {
          json(res, 400, { error: "add your CV first" });
          return;
        }
        const current = parse(readFileSync(target, "utf8")) as Record<string, unknown>;
        current.field = field;
        writeFileSync(target, stringify(current, { lineWidth: 0 }), "utf8");
        json(res, 200, { field });
        return;
      }

      if (pathname === "/api/interests" && req.method === "POST") {
        if (running) {
          json(res, 409, { error: "a run is in progress" });
          return;
        }
        const body = await readJsonBody(req);
        const raw = Array.isArray(body.interests) ? body.interests : String(body.interests ?? "").split(",");
        const interests = raw
          .map((v) => String(v).trim())
          .filter(Boolean)
          .map((v) => v.slice(0, 60))
          .slice(0, 10);

        const target = profilePath();
        if (!existsSync(target)) {
          json(res, 400, { error: "add your CV first" });
          return;
        }
        const current = parse(readFileSync(target, "utf8")) as Record<string, unknown>;
        current.interests = interests;
        writeFileSync(target, stringify(current, { lineWidth: 0 }), "utf8");
        json(res, 200, { interests });
        return;
      }

      if (pathname === "/api/jobs" && req.method === "GET") {
        const min = Number(url.searchParams.get("min") ?? 65);
        const limit = Number(url.searchParams.get("limit") ?? 30);
        const rows = topScored(
          db,
          Number.isFinite(min) ? Math.min(100, Math.max(0, min)) : 65,
          Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 30,
        );
        json(res, 200, {
          jobs: rows,
          total: countScored(db, Number.isFinite(min) ? Math.min(100, Math.max(0, min)) : 65),
          postings: stats(db).active,
        });
        return;
      }

      if (pathname === "/api/health" && req.method === "GET") {
        json(res, 200, { ok: true, running: Boolean(running) });
        return;
      }

      if (pathname === "/api/feedback" && req.method === "POST") {
        const body = await readJsonBody(req);
        const id = String(body.jobId ?? "");
        const label = String(body.label ?? "");
        if (!isStage(label)) {
          json(res, 400, { error: `label must be one of: ${STAGES.join(", ")}` });
          return;
        }
        const job = getJob(db, id) ?? findJobByPrefix(db, id);
        if (!job) {
          json(res, 404, { error: `no posting for id "${id}"` });
          return;
        }
        recordDecision(db, job.id, label, body.note ? String(body.note) : undefined);
        json(res, 200, { ok: true, job: { id: job.id, title: job.title, company: job.company } });
        return;
      }

      if (pathname === "/api/decisions" && req.method === "GET") {
        json(res, 200, { decisions: listDecisions(db) });
        return;
      }

      if (pathname === "/api/undo" && req.method === "POST") {
        const body = await readJsonBody(req);
        const id = String(body.jobId ?? "");
        if (!id) {
          json(res, 400, { error: "jobId is required" });
          return;
        }
        clearDecision(db, id);
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/run" && req.method === "GET") {
        if (running) {
          json(res, 409, { error: "a run is already in progress" });
          return;
        }
        let spec: RunSpec;
        try {
          spec = buildRunSpec(url.searchParams, cfgDir);
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
          return;
        }

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });

        const send = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // One stamp for the whole session, so the transcript and the JSON
        // report are obviously two halves of the same run.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const child = spawn(process.execPath, [join(ROOT, "src", "cli.ts"), ...spec.args], {
          cwd: ROOT,
          env: { ...process.env, ...spec.env, JOBPILOT_SESSION: stamp },
        });
        running = child;

        // The transcript is what the user actually saw, kept beside the
        // structured report the CLI writes.
        const transcript = join(runsDir(), `${stamp}-ui-${spec.args[0] ?? "run"}.log`);
        let captured = "";
        mkdirSync(runsDir(), { recursive: true });

        const pump = (stream: NodeJS.ReadableStream | null) => {
          stream?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            captured += text;
            send("log", { text });
          });
        };
        pump(child.stdout);
        pump(child.stderr);

        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);

        const finish = (code: number | null) => {
          clearInterval(keepAlive);
          running = null;
          try {
            writeFileSync(transcript, captured, "utf8");
          } catch {
            /* a transcript failure must not break the run */
          }

          // Hand the funnel back to the page so the result is not a blank stare.
          let summary: Record<string, unknown> | null = null;
          try {
            const report = join(runsDir(), `${stamp}-${spec.args[0]}.json`);
            if (existsSync(report)) {
              const parsed = JSON.parse(readFileSync(report, "utf8")) as {
                detail?: Record<string, unknown>;
                results?: { matches?: { score: number }[] };
              };
              const detail = parsed.detail ?? {};
              summary = {
                collected: detail.collected ?? null,
                inserted: detail.inserted ?? null,
                evaluated: detail.evaluated ?? null,
                eligible: detail.eligible ?? null,
                scored: detail.scored ?? null,
                matches: parsed.results?.matches?.length ?? null,
              };
            }
          } catch {
            /* summary is optional */
          }

          send("done", { code, transcript: `runs/${transcript.split(/[/\\]/).pop()}`, summary });
          res.end();
        };

        child.on("exit", (code) => finish(code));
        child.on("error", (err) => {
          send("log", { text: `failed to start: ${err.message}\n` });
          finish(1);
        });

        res.on("close", () => {
          clearInterval(keepAlive);
          if (running === child) {
            child.kill("SIGTERM");
            running = null;
          }
        });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log(`JobPilot UI  →  http://127.0.0.1:${port}`);
    log(`config dir   →  ${configDir()}`);
    if (!provider()) {
      log("note: no LLM key set — scoring and profile extraction will be unavailable");
    }
  });

  return server;
}

/** Only listen when executed directly, so tests can import this module. */
const invokedDirectly = process.argv[1]?.endsWith("server.ts");
if (invokedDirectly) {
  loadEnv();
  const argv = process.argv.slice(2);
  const cfgIndex = argv.findIndex((a) => a === "--config" || a === "-c");
  let cfgDir: string | undefined;
  if (cfgIndex >= 0) {
    cfgDir = argv[cfgIndex + 1];
    if (!cfgDir) fail("--config needs a directory");
    setConfigDir(cfgDir);
  }
  const portIndex = argv.findIndex((a) => a === "--port" || a === "-p");
  const port = portIndex >= 0 ? Number(argv[portIndex + 1]) : Number(env("PORT", "7788"));
  if (!Number.isFinite(port) || port < 1 || port > 65535) fail("--port must be a valid port");

  startServer({ port, cfgDir });
}
