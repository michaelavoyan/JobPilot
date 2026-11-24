import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "./db.ts";

const NAME = /^jobs-\d{8}-\d{9}\.db$/;

/**
 * A consistent single-file copy of the database.
 *
 * `VACUUM INTO` is used rather than copying the file: the database runs in WAL
 * mode, so a plain copy can miss the last transactions. This one cannot.
 */
export function backupDatabase(db: Db, dir: string, keep = 7): string {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });

  // 20261124-215412387: sortable, and the retention pattern depends on it.
  const stamp = new Date().toISOString().replace(/[-:.Z]/g, "").replace("T", "-");
  const file = join(target, `jobs-${stamp}.db`);
  // Path is generated here; the quote escaping is belt and braces.
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

  const files = readdirSync(target)
    .filter((name) => NAME.test(name))
    .sort();
  while (files.length > keep) {
    const oldest = files.shift();
    if (oldest) rmSync(join(target, oldest), { force: true });
  }
  return file;
}

export function listBackups(dir: string): string[] {
  try {
    return readdirSync(resolve(dir))
      .filter((name) => NAME.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
