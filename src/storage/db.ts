import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dbPath, nowIso } from "../engine/util.ts";
import type { Job, Lang, ScoredJob, Score, SourceError } from "../engine/types.ts";

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  company          TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL,
  locations        TEXT NOT NULL,
  remote           INTEGER NOT NULL DEFAULT 0,
  description      TEXT NOT NULL,
  description_hash TEXT NOT NULL,
  posted_at        TEXT,
  comp             TEXT,
  lang             TEXT NOT NULL DEFAULT 'und',
  country          TEXT NOT NULL DEFAULT '',
  first_seen       TEXT NOT NULL,
  last_seen        TEXT NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1,
  evaluated        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scores (
  job_id       TEXT NOT NULL,
  track        TEXT NOT NULL,
  score        INTEGER NOT NULL,
  reasons      TEXT NOT NULL,
  flags        TEXT NOT NULL,
  model        TEXT NOT NULL,
  profile_hash TEXT NOT NULL,
  scored_at    TEXT NOT NULL,
  variant      TEXT NOT NULL DEFAULT 'baseline',
  learning_at  TEXT,
  PRIMARY KEY (job_id, track)
);

-- The same posting scored without learning, so the two can be compared.
CREATE TABLE IF NOT EXISTS shadow_scores (
  job_id TEXT NOT NULL,
  track  TEXT NOT NULL,
  score  INTEGER NOT NULL,
  model  TEXT NOT NULL,
  at     TEXT NOT NULL,
  PRIMARY KEY (job_id, track)
);

CREATE TABLE IF NOT EXISTS rejects (
  job_id TEXT NOT NULL,
  track  TEXT NOT NULL,
  reason TEXT NOT NULL,
  at     TEXT NOT NULL,
  PRIMARY KEY (job_id, track)
);

CREATE TABLE IF NOT EXISTS decisions (
  job_id TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  note   TEXT,
  at     TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS boards (
  ats         TEXT NOT NULL,
  ident       TEXT NOT NULL,
  token       TEXT,
  name        TEXT NOT NULL,
  open_roles  INTEGER,
  verified_at TEXT,
  misses      INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (ats, ident)
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  started    TEXT NOT NULL,
  finished   TEXT,
  collected  INTEGER NOT NULL DEFAULT 0,
  new_jobs   INTEGER NOT NULL DEFAULT 0,
  filtered   INTEGER NOT NULL DEFAULT 0,
  scored     INTEGER NOT NULL DEFAULT 0,
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL NOT NULL DEFAULT 0,
  errors     TEXT
);

CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen);
CREATE INDEX IF NOT EXISTS scores_track ON scores(track, score DESC);
`;

export type Db = DatabaseSync;

export function open(path: string = dbPath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Existing databases predate the evaluated column. */
function migrate(db: Db): void {
  const columns = db.prepare("PRAGMA table_info(jobs)").all() as Row[];
  if (!columns.some((c) => String(c.name) === "evaluated")) {
    db.exec("ALTER TABLE jobs ADD COLUMN evaluated INTEGER NOT NULL DEFAULT 0");
  }
  const decisionColumns = db.prepare("PRAGMA table_info(decisions)").all() as Row[];
  if (!decisionColumns.some((c) => String(c.name) === "updated_at")) {
    db.exec("ALTER TABLE decisions ADD COLUMN updated_at TEXT");
  }
  const scoreColumns = db.prepare("PRAGMA table_info(scores)").all() as Row[];
  if (!scoreColumns.some((c) => String(c.name) === "variant")) {
    db.exec("ALTER TABLE scores ADD COLUMN variant TEXT NOT NULL DEFAULT 'baseline'");
  }
  if (!scoreColumns.some((c) => String(c.name) === "learning_at")) {
    db.exec("ALTER TABLE scores ADD COLUMN learning_at TEXT");
  }
}

/** Change detection only: the storage layer does not depend on enrichment. */
function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 24);
}

export function upsertJobs(
  db: Db,
  jobs: Job[],
): { inserted: number; updated: number; rescored: number } {
  const existing = new Map<string, { description_hash: string }>();
  for (const row of db.prepare("SELECT id, description_hash FROM jobs").all() as Row[]) {
    existing.set(String(row.id), { description_hash: String(row.description_hash) });
  }

  const insert = db.prepare(`
    INSERT INTO jobs (id, source, company, title, url, locations, remote, description,
                      description_hash, posted_at, comp, lang, country, first_seen, last_seen, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      url = excluded.url,
      locations = excluded.locations,
      remote = excluded.remote,
      description = excluded.description,
      description_hash = excluded.description_hash,
      posted_at = excluded.posted_at,
      comp = excluded.comp,
      lang = excluded.lang,
      last_seen = excluded.last_seen,
      active = 1
  `);
  const dropScores = db.prepare("DELETE FROM scores WHERE job_id = ?");

  let inserted = 0;
  let updated = 0;
  let rescored = 0;
  const ts = nowIso();

  db.exec("BEGIN");
  try {
    for (const j of jobs) {
      const dh = contentHash(j.description);
      const prev = existing.get(j.id);
      const compJson = j.comp ? JSON.stringify(j.comp) : null;
      insert.run(
        j.id,
        j.source,
        j.company,
        j.title,
        j.url,
        JSON.stringify(j.locations),
        j.remote ? 1 : 0,
        j.description,
        dh,
        j.postedAt ?? null,
        compJson,
        j.lang,
        j.country,
        ts,
        ts,
      );
      if (!prev) {
        inserted++;
      } else {
        updated++;
        if (prev.description_hash !== dh) {
          dropScores.run(j.id);
          db.prepare("UPDATE jobs SET evaluated = 0 WHERE id = ?").run(j.id);
          rescored++;
        }
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { inserted, updated, rescored };
}

/** Mark postings no longer present at their source as inactive. */
export function deactivateMissing(db: Db, source: string, seenIds: string[]): number {
  const rows = db
    .prepare("SELECT id FROM jobs WHERE source = ? AND active = 1")
    .all(source) as Row[];
  const seen = new Set(seenIds);
  const stmt = db.prepare("UPDATE jobs SET active = 0 WHERE id = ?");
  let n = 0;
  for (const r of rows) {
    const id = String(r.id);
    if (!seen.has(id)) {
      stmt.run(id);
      n++;
    }
  }
  return n;
}

export function unscoredJobs(db: Db, limit: number): Job[] {
  const rows = db
    .prepare(
      `SELECT * FROM jobs
       WHERE active = 1 AND evaluated = 0
       ORDER BY first_seen DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(rowToJob);
}

/**
 * A job counts as evaluated once it has been through the filters, whether it
 * was scored or rejected. Without this, a job that failed the model call is
 * either retried forever or hidden forever — both are wrong.
 */
export function markEvaluated(db: Db, ids: string[]): void {
  if (!ids.length) return;
  const stmt = db.prepare("UPDATE jobs SET evaluated = 1 WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const id of ids) stmt.run(id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function allJobs(db: Db, limit = 1000): Job[] {
  const rows = db.prepare("SELECT * FROM jobs ORDER BY first_seen DESC LIMIT ?").all(limit) as Row[];
  return rows.map(rowToJob);
}

export interface Board {
  ats: string;
  ident: string;
  token?: string;
  name: string;
  openRoles?: number;
  verifiedAt?: string;
  misses: number;
  enabled: boolean;
}

/**
 * The tenant directory. ATS platforms have no index of their customers, so
 * discovery finds them and this table remembers them; collect reads it instead
 * of requiring a hand-maintained list.
 */
export function upsertBoards(
  db: Db,
  boards: { ats: string; ident: string; token?: string; name: string; openRoles?: number }[],
): number {
  if (!boards.length) return 0;
  const stmt = db.prepare(`
    INSERT INTO boards (ats, ident, token, name, open_roles, verified_at, misses, enabled)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    ON CONFLICT(ats, ident) DO UPDATE SET
      token = COALESCE(excluded.token, boards.token),
      name = excluded.name,
      open_roles = excluded.open_roles,
      verified_at = excluded.verified_at,
      misses = 0,
      enabled = 1
  `);
  const at = nowIso();
  let n = 0;
  db.exec("BEGIN");
  try {
    for (const b of boards) {
      stmt.run(b.ats, b.ident, b.token ?? null, b.name, b.openRoles ?? null, at);
      n++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return n;
}

export function listBoards(db: Db, onlyEnabled = true): Board[] {
  const rows = db
    .prepare(
      `SELECT * FROM boards ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY open_roles DESC`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    ats: String(r.ats),
    ident: String(r.ident),
    token: r.token ? String(r.token) : undefined,
    name: String(r.name),
    openRoles: r.open_roles === null ? undefined : Number(r.open_roles),
    verifiedAt: r.verified_at ? String(r.verified_at) : undefined,
    misses: Number(r.misses),
    enabled: Number(r.enabled) === 1,
  }));
}

/** A board that stops answering is retired rather than retried forever. */
export function recordBoardMiss(db: Db, ats: string, ident: string, limit = 14): boolean {
  db.prepare(
    "UPDATE boards SET misses = misses + 1, enabled = CASE WHEN misses + 1 >= ? THEN 0 ELSE enabled END WHERE ats = ? AND ident = ?",
  ).run(limit, ats, ident);
  const row = db.prepare("SELECT enabled FROM boards WHERE ats = ? AND ident = ?").get(ats, ident) as
    | Row
    | undefined;
  return row ? Number(row.enabled) === 0 : false;
}

export function rowToJob(r: Row): Job {
  return {
    id: String(r.id),
    source: String(r.source),
    company: String(r.company),
    title: String(r.title),
    url: String(r.url),
    locations: parseJsonArray(String(r.locations)),
    remote: Number(r.remote) === 1,
    description: String(r.description ?? ""),
    postedAt: r.posted_at ? String(r.posted_at) : undefined,
    comp: r.comp ? (JSON.parse(String(r.comp)) as Job["comp"]) : undefined,
    lang: String(r.lang ?? "und") as Lang,
    country: String(r.country ?? ""),
  };
}

function parseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function recordRejects(
  db: Db,
  rejects: { jobId: string; track: string; reason: string }[],
): void {
  if (!rejects.length) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO rejects (job_id, track, reason, at) VALUES (?, ?, ?, ?)",
  );
  const at = nowIso();
  db.exec("BEGIN");
  try {
    for (const r of rejects) stmt.run(r.jobId, r.track, r.reason, at);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function saveScores(
  db: Db,
  scores: Score[],
  model: string,
  pHash: string,
  provenance: { variant: "baseline" | "learned"; learningAt?: string } = { variant: "baseline" },
): void {  if (!scores.length) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO scores
      (job_id, track, score, reasons, flags, model, profile_hash, scored_at, variant, learning_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const at = nowIso();
  db.exec("BEGIN");
  try {
    for (const s of scores) {
      stmt.run(
        s.jobId,
        s.track,
        s.score,
        JSON.stringify(s.reasons),
        JSON.stringify(s.flags),
        model,
        pHash,
        at,
        provenance.variant,
        provenance.learningAt ?? null,
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * A posting that no longer passes a track's filters must not keep a score for
 * that track. Without this, tightening a filter leaves its old verdicts on the
 * digest until the posting expires.
 */
export function dropScores(db: Db, pairs: { jobId: string; track: string }[]): void {
  if (!pairs.length) return;
  const stmt = db.prepare("DELETE FROM scores WHERE job_id = ? AND track = ?");
  db.exec("BEGIN");
  try {
    for (const p of pairs) stmt.run(p.jobId, p.track);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** How many scored postings meet a threshold, ignoring the display limit. */
export function countScored(db: Db, minScore: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM scores s
       JOIN jobs j ON j.id = s.job_id
       LEFT JOIN decisions d ON d.job_id = s.job_id
       WHERE s.score >= ? AND d.job_id IS NULL AND j.active = 1`,
    )
    .get(minScore) as Row;
  return Number(row.n);
}

export function saveShadowScores(
  db: Db,
  scores: Score[],
  model: string,
): void {
  if (!scores.length) return;
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO shadow_scores (job_id, track, score, model, at) VALUES (?, ?, ?, ?, ?)",
  );
  const at = nowIso();
  db.exec("BEGIN");
  try {
    for (const s of scores) stmt.run(s.jobId, s.track, s.score, model, at);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every posting scored both ways, for the learning comparison. */
export function shadowPairs(
  db: Db,
): { jobId: string; track: string; learned: number; baseline: number }[] {
  return (
    db
      .prepare(
        `SELECT s.job_id AS jobId, s.track AS track, s.score AS learned, b.score AS baseline
         FROM scores s
         JOIN shadow_scores b ON b.job_id = s.job_id AND b.track = s.track`,
      )
      .all() as Row[]
  ).map((r) => ({
    jobId: String(r.jobId),
    track: String(r.track),
    learned: Number(r.learned),
    baseline: Number(r.baseline),
  }));
}

export function topScored(db: Db, minScore: number, limit: number): ScoredJob[] {  const rows = db
    .prepare(
      `SELECT s.track, s.score, s.reasons, s.flags, j.*
       FROM scores s
       JOIN jobs j ON j.id = s.job_id
       LEFT JOIN decisions d ON d.job_id = s.job_id
       WHERE s.score >= ? AND d.job_id IS NULL AND j.active = 1
       ORDER BY s.score DESC
       LIMIT ?`,
    )
    .all(minScore, limit) as Row[];
  return rows.map((r) => ({
    ...rowToJob(r),
    track: String(r.track),
    score: Number(r.score),
    reasons: parseJsonArray(String(r.reasons)),
    flags: parseJsonArray(String(r.flags)),
  }));
}

export function getJob(db: Db, id: string): Job | undefined {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToJob(row) : undefined;
}

export function findJobByPrefix(db: Db, prefix: string): Job | undefined {
  const row = db
    .prepare("SELECT * FROM jobs WHERE id LIKE ? LIMIT 2")
    .all(prefix + "%") as Row[];
  return row.length === 1 ? rowToJob(row[0]) : undefined;
}

export const STAGES = [
  "shortlisted",
  "applied",
  "screening",
  "interview",
  "offer",
  "rejected",
  "skipped",
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

export function recordDecision(db: Db, jobId: string, label: string, note?: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO decisions (job_id, label, note, at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET label = excluded.label,
       note = COALESCE(excluded.note, decisions.note),
       updated_at = excluded.updated_at`,
  ).run(jobId, label, note ?? null, now, now);
}

/** Counts per stage, in pipeline order, for the funnel report. */
export function funnelCounts(db: Db): { stage: string; n: number }[] {
  const rows = db
    .prepare("SELECT label AS stage, COUNT(*) AS n FROM decisions GROUP BY label")
    .all() as Row[];
  const byStage = new Map(rows.map((r) => [String(r.stage), Number(r.n)]));
  return STAGES.map((stage) => ({ stage, n: byStage.get(stage) ?? 0 })).filter((r) => r.n > 0);
}

/** Forgets a decision so the posting can appear again. */
export function clearDecision(db: Db, jobId: string): boolean {
  const result = db.prepare("DELETE FROM decisions WHERE job_id = ?").run(jobId);
  return Number(result.changes) > 0;
}

/** Everything the user has labelled, newest first, for the manage list. */
export function listDecisions(
  db: Db,
): { jobId: string; label: string; company: string; title: string; at: string }[] {
  return (
    db
      .prepare(
        `SELECT d.job_id AS jobId, d.label AS label, d.at AS at,
                j.company AS company, j.title AS title
         FROM decisions d LEFT JOIN jobs j ON j.id = d.job_id
         ORDER BY d.at DESC`,
      )
      .all() as Row[]
  ).map((r) => ({
    jobId: String(r.jobId),
    label: String(r.label),
    company: r.company ? String(r.company) : "",
    title: r.title ? String(r.title) : "",
    at: String(r.at),
  }));
}

export function decisions(db: Db): { jobId: string; label: string; note?: string }[] {
  return (db.prepare("SELECT job_id, label, note FROM decisions").all() as Row[]).map((r) => ({
    jobId: String(r.job_id),
    label: String(r.label),
    note: r.note ? String(r.note) : undefined,
  }));
}

export function startRun(db: Db): string {
  const id = nowIso().replace(/[:.]/g, "-");
  db.prepare("INSERT INTO runs (id, started) VALUES (?, ?)").run(id, nowIso());
  return id;
}

export function finishRun(
  db: Db,
  id: string,
  stats: {
    collected?: number;
    newJobs?: number;
    filtered?: number;
    scored?: number;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    errors?: SourceError[];
  },
): void {
  db.prepare(
    `UPDATE runs SET finished = ?, collected = ?, new_jobs = ?, filtered = ?, scored = ?,
     tokens_in = ?, tokens_out = ?, cost_usd = ?, errors = ? WHERE id = ?`,
  ).run(
    nowIso(),
    stats.collected ?? 0,
    stats.newJobs ?? 0,
    stats.filtered ?? 0,
    stats.scored ?? 0,
    stats.tokensIn ?? 0,
    stats.tokensOut ?? 0,
    stats.costUsd ?? 0,
    stats.errors?.length ? JSON.stringify(stats.errors) : null,
    id,
  );
}

export function stats(db: Db): {
  jobs: number;
  active: number;
  scored: number;
  decisions: number;
  rejects: number;
} {
  const one = (sql: string) => Number((db.prepare(sql).get() as Row).n);
  return {
    jobs: one("SELECT COUNT(*) AS n FROM jobs"),
    active: one("SELECT COUNT(*) AS n FROM jobs WHERE active = 1"),
    scored: one("SELECT COUNT(*) AS n FROM scores"),
    decisions: one("SELECT COUNT(*) AS n FROM decisions"),
    rejects: one("SELECT COUNT(*) AS n FROM rejects"),
  };
}

export function rejectSummary(db: Db, limit = 20): { reason: string; n: number }[] {
  return (
    db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM rejects GROUP BY reason ORDER BY n DESC LIMIT ?`,
      )
      .all(limit) as Row[]
  ).map((r) => ({ reason: String(r.reason), n: Number(r.n) }));
}

export function scoreDistribution(db: Db): { track: string; bucket: number; n: number }[] {
  return (
    db
      .prepare(
        `SELECT track, (score / 10) * 10 AS bucket, COUNT(*) AS n
         FROM scores GROUP BY track, bucket ORDER BY track, bucket`,
      )
      .all() as Row[]
  ).map((r) => ({ track: String(r.track), bucket: Number(r.bucket), n: Number(r.n) }));
}
