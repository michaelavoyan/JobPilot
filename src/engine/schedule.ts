import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { log, ROOT, warn } from "./util.ts";

export const LABEL = "ai.jobpilot.daily";

export interface PlistOptions {
  nodePath: string;
  cliPath: string;
  command: string;
  workDir: string;
  logPath: string;
  errorLogPath: string;
  hour: number;
  minute: number;
}

export function plistPath(home = homedir()): string {
  return resolve(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Pure, so the generated schedule can be asserted in tests. */
export function renderPlist(o: PlistOptions): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${o.nodePath}</string>
    <string>${o.cliPath}</string>
    <string>${o.command}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${o.workDir}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${o.hour}</integer>
    <key>Minute</key>
    <integer>${o.minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${o.logPath}</string>
  <key>StandardErrorPath</key>
  <string>${o.errorLogPath}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function defaults(): PlistOptions {
  const logs = resolve(homedir(), "Library", "Logs");
  return {
    nodePath: process.execPath,
    cliPath: resolve(ROOT, "src", "cli.ts"),
    command: "agent",
    workDir: ROOT,
    logPath: resolve(logs, "jobpilot.log"),
    errorLogPath: resolve(logs, "jobpilot.err.log"),
    hour: 7,
    minute: 30,
  };
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function install(options: Partial<PlistOptions> = {}): string {
  const opts = { ...defaults(), ...options };
  const target = plistPath();
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, renderPlist(opts), "utf8");

  // bootout first so a re-install replaces the agent instead of erroring.
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
  } catch {
    /* not loaded yet */
  }
  execFileSync("launchctl", ["bootstrap", domain(), target], { stdio: "inherit" });
  log(`installed ${LABEL} — runs daily at ${String(opts.hour).padStart(2, "0")}:${String(opts.minute).padStart(2, "0")}`);
  log(`log: ${opts.logPath}`);
  return target;
}

export function uninstall(): boolean {
  const target = plistPath();
  let removed = false;
  try {
    execFileSync("launchctl", ["bootout", `${domain()}/${LABEL}`], { stdio: "ignore" });
    removed = true;
  } catch {
    /* was not loaded */
  }
  if (existsSync(target)) {
    rmSync(target);
    removed = true;
  }
  return removed;
}

export function status(): boolean {
  try {
    execFileSync("launchctl", ["print", `${domain()}/${LABEL}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function kickstart(): void {
  if (!status()) throw new Error(`${LABEL} is not installed — run: npm run schedule -- install`);
  execFileSync("launchctl", ["kickstart", "-k", `${domain()}/${LABEL}`], { stdio: "inherit" });
  warn(`triggered ${LABEL} once; follow it with: tail -f ~/Library/Logs/jobpilot.log`);
}
