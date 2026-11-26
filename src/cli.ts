import {
  findJobByPrefix,
  funnelCounts,
  getJob,
  isStage,
  learningRuns,
  attemptedNames,
  decisions,
  latestBoardYield,
  listBoards,
  policyHistory,
  pruneSilentBoards,
  reviveBoards,
  resetAgentState,
  listConstraints,
  runHistory,
  stats,
  open,
  proposeConstraints,
  recordAttempts,
  recordDecision,
  setConstraintStatus,
  STAGES,
  upsertBoards,
} from "./storage/db.ts";
import { loadMarket, loadProfile, loadTracks } from "./engine/config.ts";
import { backupDatabase, listBackups } from "./storage/backup.ts";
import { runAll, runCollect, runDigest, runScore } from "./engine/pipeline.ts";
import { runEval, printStats, funnelLines } from "./engine/report.ts";
import { detect } from "./engine/discover.ts";
import { discoverFromList } from "./engine/discover-list.ts";
import { executePlan } from "./engine/agent/execute.ts";
import { planDay } from "./engine/agent/plan.ts";
import { agentState } from "./engine/agent/state.ts";
import { availableMarkets, initConfig } from "./engine/setup.ts";
import { boardToCompany, discoverCompanies, parseBands, searchConfigured } from "./engine/discovery.ts";
import { collect, SOURCES } from "./engine/ingest/index.ts";
import { apiUrl, getJson } from "./engine/ingest/types.ts";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readCv, extractProfile } from "./engine/profile/extract.ts";
import { renderProfileYaml, writeProfile } from "./engine/profile/write.ts";
import { provider } from "./engine/score/llm.ts";
import { writeRunReport } from "./engine/audit.ts";
import { buildLearning } from "./engine/learn.ts";
import { classifyNote, describeConstraint } from "./engine/notes.ts";
import type { ConstraintKind } from "./engine/notes.ts";
import {
  install as installSchedule,
  kickstart,
  status as scheduleStatus,
  uninstall as uninstallSchedule,
} from "./engine/schedule.ts";
import {
  configDir,
  env,
  fail,
  loadEnv,
  log,
  notify,
  setConfigDir,
  templatesDir,
  today,
  numEnv,
  warn,
} from "./engine/util.ts";

const HELP = `JobPilot — personal job-search agent

  npm run init                     create your config from templates
                                   add --market il|us to pick the market
  npm run profile -- <cv>          build your profile from a CV (pdf, docx, md)
                                   add --dry to preview, --force to overwrite
  npm run discover -- <url>        add one company from its careers page
  npm run discover-web             find companies via search, filtered by size
                                   --bands "1-20,21-100" [--max 200]
  npm run sources                  health-check every enabled source
  npm run collect                  fetch, clean, dedupe, store
  npm run score                    filter and score pending postings
                                   add --rescore to re-evaluate everything
  npm run digest                   write the digest
  npm run run                      collect + score + digest
  npm run learn                    calibration, preferences, proposed constraints
  npm run learn -- --confirm <id>  accept a constraint; it reaches the scorer
  npm run learn -- --reject <id>   discard it
  npm run learn -- --reset         forget shadow scores and proposals; keep labels
  npm run learn -- --history       the rule versions that produced recent scores
  npm run feedback -- <id> <stage> shortlisted | applied | screening | interview
                                   | offer | rejected | skipped
  npm run funnel                   application funnel and conversion rates
  npm run eval [-- --holdout 30]   ranking quality, on a holdout when asked
  npm run stats                    database summary
  npm run schedule -- install      install the daily launchd agent
  npm run health                   scheduler, last run, backups, directory size
  npm run backup                   write a consistent snapshot of the database
  npm run ui                       start the web UI (or ./start.sh)

  Every command accepts --config <dir> (or JOBCONFIG_DIR).
  Labels are the eval set. Thirty is the minimum to trust a ranking.
`.trim();

async function main(): Promise<void> {
  loadEnv();

  const raw = process.argv.slice(2);
  let cfg = env("JOBCONFIG_DIR");
  const flagIndex = raw.findIndex((a) => a === "--config" || a === "-c");
  if (flagIndex >= 0) {
    const value = raw[flagIndex + 1];
    if (!value) fail("--config needs a directory");
    cfg = value;
    raw.splice(flagIndex, 2);
  }
  if (cfg) setConfigDir(cfg);

  const [command, ...args] = raw;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      log(HELP);
      return;

    case "discover-web": {
      const bandsArg = args[args.indexOf("--bands") + 1];
      if (!args.includes("--bands") || !bandsArg) {
        fail('usage: npm run discover-web -- --bands "1-20,21-100" [--max 200]');
      }
      if (!searchConfigured()) {
        fail(
          "web discovery needs a search provider: set SERPER_API_KEY (free, no card), " +
            "BRAVE_API_KEY, or GOOGLE_API_KEY + GOOGLE_CSE_ID in .env",
        );
      }
      const bands = parseBands(bandsArg);
      const maxIndex = args.indexOf("--max");
      const maxBoards = maxIndex >= 0 ? Number(args[maxIndex + 1]) : undefined;

      const market = loadMarket();
      const cities = [
        ...new Set(
          Object.values(market.city_aliases).filter(
            (v) => v !== "Remote" && v !== "Hybrid" && v.length > 2,
          ),
        ),
      ];

      log(`searching ${cities.length} cities across 4 ATS platforms…`);
      const result = await discoverCompanies({ market, cities, bands, maxBoards });

      for (const board of result.boards) {
        log(`  ${String(board.openRoles).padStart(4)} roles  ${board.ats.padEnd(10)} ${board.name}`);
      }
      for (const error of result.errors.slice(0, 5)) warn(error);

      const db = open();
      const stored = upsertBoards(
        db,
        result.boards.map((board) => ({
          ats: board.ats,
          ident: board.slug ?? board.uid!,
          token: board.token,
          name: board.name,
          openRoles: board.openRoles,
        })),
      );

      log(
        `\n${result.stats.urls} URLs · ${result.stats.candidates} candidates · ` +
          `${result.stats.verified} verified · ${result.stats.inBands} in bands`,
      );
      log(`${stored} boards remembered (${listBoards(db).length} in the directory)`);
      log(`report: ${writeRunReport(db, "discover-web", { ...result.stats, stored })}`);
      return;
    }

    case "boards": {
      const db = open();
      if (args[0] === "prune") {
        if (!provider()) {
          fail("pruning needs a scored run: without a model key every board looks silent");
        }
        const sinceIndex = args.indexOf("--since");
        const hours = sinceIndex >= 0 ? Number(args[sinceIndex + 1]) : 24;
        if (!Number.isFinite(hours) || hours <= 0) fail("--since must be a positive number of hours");
        const since = new Date(Date.now() - hours * 3_600_000).toISOString();
        const result = pruneSilentBoards(db, since);
        log(
          `disabled ${result.disabled.length} silent board(s), kept ${result.kept} ` +
            `that produced a scored posting`,
        );
        for (const name of result.disabled.slice(0, 20)) log(`  ${name}`);
        log("revive any of them by running discovery again");
        return;
      }
      if (args[0] === "revive") {
        const all = args.includes("--all");
        const name = args.find((a) => a !== "revive" && !a.startsWith("--"));
        if (!all && !name) fail("usage: npm run boards -- revive --all | <name>");
        log(`revived ${reviveBoards(db, all ? undefined : name)} board(s)`);
        return;
      }
      const boards = listBoards(db, false);
      if (!boards.length) {
        log("the directory is empty. Run: npm run discover-web -- --bands \"1-20\"");
        return;
      }
      for (const b of boards) {
        log(
          `${String(b.openRoles ?? "?").padStart(4)} roles  ${b.ats.padEnd(10)} ` +
            `${b.name}${b.enabled ? "" : "  (retired)"}`,
        );
      }
      log(`\n${boards.filter((b) => b.enabled).length} active of ${boards.length}`);
      return;
    }

    case "schedule": {
      const sub = args[0] ?? "status";
      if (sub === "install") {
        installSchedule();
      } else if (sub === "uninstall") {
        log(uninstallSchedule() ? "schedule removed" : "nothing was installed");
      } else if (sub === "status") {
        log(scheduleStatus() ? "schedule is installed" : "schedule is not installed");
      } else if (sub === "run") {
        kickstart();
      } else {
        fail("usage: npm run schedule -- install|uninstall|status|run");
      }
      return;
    }

    case "init": {
      const dir = configDir();
      const markets = availableMarkets();

      const marketFlag = args.indexOf("--market");
      const requested =
        marketFlag >= 0 ? args[marketFlag + 1] : (env("JOBCONFIG_MARKET") ?? markets[0]);
      if (!requested) fail("no market templates found in templates/");

      let result;
      try {
        result = initConfig(dir, requested);
      } catch (err) {
        fail((err as Error).message);
      }

      for (const file of result.created) log(`created  ${file}`);
      for (const file of result.kept) log(`kept     ${file}`);
      log(`\nconfig dir: ${dir}`);
      log(`market:     ${result.market}   (available: ${markets.join(", ")})`);
      if (result.created.length) {
        log("next: upload a CV in the app, or edit profile.yaml by hand");
      }
      return;
    }

    case "sources": {
      const market = loadMarket();
      const db = open();
      const companies = listBoards(db).map((b) => boardToCompany(b));
      const enabled = SOURCES.filter((s) => market.sources?.[s.name]?.enabled === true);

      if (!enabled.length) {
        warn("no sources enabled in config/market.yaml");
        return;
      }

      const { perSource, errors, jobs } = await collect(companies, market);
      for (const source of enabled) {
        const targets = companies.filter((c) => c.source === source.name).length;
        const count = perSource[source.name] ?? 0;
        const state = count > 0 ? "ok" : targets === 0 ? "no boards in the directory" : "returned 0";
        log(`${source.name.padEnd(12)} ${String(count).padStart(5)} jobs   ${targets} company(ies)   ${state}`);
      }
      log(`\ntotal ${jobs.length} postings${errors.length ? `, ${errors.length} error(s)` : ""}`);
      for (const e of errors.slice(0, 12)) warn(`${e.source}: ${e.message}`);
      return;
    }

    case "collect": {
      const db = open();
      const summary = await runCollect(db);
      log(`report: ${writeRunReport(db, "collect", { ...summary })}`);
      return;
    }

    case "score": {
      const db = open();
      const summary = await runScore(db, { rescore: args.includes("--rescore") });
      log(`report: ${writeRunReport(db, "score", { ...summary })}`);
      return;
    }

    case "digest": {
      const db = open();
      const summary = await runDigest(db);
      log(`report: ${writeRunReport(db, "digest", { ...summary })}`);
      return;
    }

    case "agent-status": {
      const db = open();
      const policy = {
        monthlyCapUsd: numEnv("AGENT_MONTHLY_CAP_USD", 5),
        minMatchesPerWeek: numEnv("AGENT_MIN_MATCHES", 3),
        discoveryLimit: numEnv("AGENT_DISCOVERY_LIMIT", 40),
      };
      const state = agentState(db, {
        threshold: numEnv("MIN_SCORE", 65),
        providerConfigured: Boolean(provider()),
      });

      log(`scheduler      ${scheduleStatus() ? "installed" : "not installed"}`);
      log(`matches        ${state.matchesLast7} in the last 7 days`);
      log(
        `spend          $${state.spendLast30Usd.toFixed(2)} of ` +
          `$${policy.monthlyCapUsd.toFixed(2)} this month`,
      );

      const yields = latestBoardYield(db);
      log(
        `boards         ${state.boards}` +
          (yields.length
            ? ` · ${yields.filter((y) => y.matched > 0).length} produced a match last run`
            : ""),
      );
      if (yields.length) {
        const top = [...yields]
          .filter((y) => y.matched > 0)
          .sort((a, b) => b.matched - a.matched)
          .slice(0, 3)
          .map((y) => `${y.name} ${y.matched}`)
          .join(", ");
        log(`yield          ${top || "no board produced a match in the last run"}`);
      }

      const [last] = policyHistory(db, 1);
      if (last) {
        let plan = "unreadable";
        try {
          const parsed = JSON.parse(last.plan) as { actions?: { kind?: string }[] };
          plan = (parsed.actions ?? []).map((a) => a.kind).join(" → ") || "nothing";
        } catch {
          /* an unreadable plan is itself the answer */
        }
        log(`last plan      ${last.at} · rules ${last.version} · ${plan}`);
      } else {
        log("last plan      none yet");
      }

      const labels = decisions(db);
      const count = (stage: string) => labels.filter((l) => l.label === stage).length;
      log(
        `outcomes       ${["applied", "screening", "interview", "offer", "rejected", "skipped"]
          .map((stage) => `${count(stage)} ${stage}`)
          .join(" · ")}`,
      );
      return;
    }

    case "agent": {
      if (env("AGENT_PAUSED") === "1") {
        log("agent paused: AGENT_PAUSED=1 in .env");
        return;
      }

      const db = open();
      if (args.includes("--reset")) {
        const cleared = resetAgentState(db);
        log(
          `forgot ${cleared.policies} plan(s) and ${cleared.yields} yield row(s); ` +
            `labels, scores and jobs are untouched`,
        );
        return;
      }

      const policy = {
        monthlyCapUsd: numEnv("AGENT_MONTHLY_CAP_USD", 5),
        minMatchesPerWeek: numEnv("AGENT_MIN_MATCHES", 3),
        discoveryLimit: numEnv("AGENT_DISCOVERY_LIMIT", 40),
      };
      const state = agentState(db, {
        threshold: numEnv("MIN_SCORE", 65),
        providerConfigured: Boolean(provider()),
      });
      const plan = planDay(state, policy);

      log(
        `agent plan · ${state.matchesLast7} match(es) in 7 days · ` +
          `$${state.spendLast30Usd.toFixed(2)} this month · ${state.boards} board(s)`,
      );
      for (const action of plan.actions) log(`  ${action.kind.padEnd(8)} ${action.reason}`);
      for (const note of plan.notes) warn(note);
      if (args.includes("--dry")) return;

      const result = await executePlan(db, plan, policy);
      log(
        `agent done · +${result.boardsAdded} board(s) · ${result.collected} collected · ` +
          `${result.scored} scored · ${result.matches} match(es)`,
      );
      return;
    }

    case "run": {
      const db = open();
      // Any supported provider counts. Naming two of the four made every
      // OpenCode and DeepSeek install log a false warning, every day.
      if (!provider()) {
        warn("no LLM key set — collecting and storing only, nothing will be scored.");
      }
      try {
        const summary = await runAll(db);
        log(`report: ${writeRunReport(db, "run", { ...summary })}`);
      } catch (err) {
        // A failed run is still a session worth recording.
        const message = (err as Error).message;
        log(`report: ${writeRunReport(db, "run", { error: message })}`);
        // A background job's only reader is a log file nobody opens.
        notify("JobPilot run failed", message.slice(0, 180));
        throw err;
      }
      return;
    }

    case "profile": {
      const target = args.find((a) => !a.startsWith("--"));
      if (!target) fail("usage: npm run profile -- <cv.pdf|.txt|.md> [--force] [--dry]");
      if (!provider()) fail("no LLM key. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env first.");

      const cvText = await readCv(resolve(process.cwd(), target));
      log(`read ${cvText.length} characters from ${basename(target)}`);

      const extracted = await extractProfile(cvText);
      const yaml = renderProfileYaml(extracted, basename(target), today());

      if (args.includes("--dry")) {
        log("\n" + yaml);
        return;
      }

      const path = writeProfile(yaml, { force: args.includes("--force") });

      log(`\n${extracted.name} — ${extracted.current_title ?? "no current title"}`);
      log(
        `  ${extracted.experience.total_years} years, ` +
          `${extracted.experience.management_years} in management` +
          (extracted.experience.max_team_size
            ? `, largest team ${extracted.experience.max_team_size}`
            : ""),
      );
      log(
        `  ${extracted.domains.length} domains · ${extracted.stack.length} technologies · ` +
          `${extracted.previous_titles.length} previous titles`,
      );
      log(`\nwritten: ${path}`);
      warn("now set locations.allowed and comp_floor by hand — they are preferences, not CV facts");
      return;
    }

    case "discover-list": {
      const limitFlag = args.indexOf("--limit");
      const limit = limitFlag >= 0 ? Number(args[limitFlag + 1]) : 120;
      if (!Number.isFinite(limit) || limit < 1) fail("--limit must be a positive number");

      const db = open();
      const boards = listBoards(db, false);
      const known = new Set(
        boards.map((b) => b.name.toLowerCase().replace(/[^a-z0-9]/g, "")),
      );
      const knownIds = new Set(boards.map((b) => `${b.ats}:${b.ident}`));
      // Names probed before and found empty are not asked again.
      const normName = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
      const skip = new Set([...known, ...[...attemptedNames(db)].map(normName)]);

      log(`checking up to ${limit} companies from public lists…`);
      const result = await discoverFromList({ limit, known, skip });
      recordAttempts(db, result.checked);
      const fresh = result.hits.filter((h) => !knownIds.has(`${h.source}:${h.ident}`));

      if (fresh.length) {
        upsertBoards(
          db,
          fresh.map((h) => ({ ats: h.source, ident: h.ident, name: h.name })),
        );
      }
      log(
        `${result.probed} of ${result.names} compan(ies) checked · ` +
          `${fresh.length} new board(s), ${result.hits.length - fresh.length} already known`,
      );
      for (const hit of fresh) {
        log(`  ${hit.source.padEnd(10)} ${hit.name.padEnd(24)} ${hit.openRoles} role(s)`);
      }
      if (!fresh.length) {
        log("nothing new. The keyless path finds roughly one board per fifteen companies;");
        log("a search key finds them by query instead.");
      }
      return;
    }

    case "discover": {
      const url = args.find((a) => !a.startsWith("--"));
      if (!url) fail("usage: npm run discover -- <careers-page-url> [--name \"Acme\"]");
      const nameIndex = args.indexOf("--name");
      const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      const { company, note } = await detect(url, name);
      const db = open();
      upsertBoards(db, [
        {
          ats: company.source,
          ident: company.slug ?? company.uid!,
          token: company.token,
          name: company.name,
        },
      ]);
      log(`added to the directory: ${company.name} (${company.source})`);
      if (note) warn(note);
      log("verify with: npm run sources");
      return;
    }

    case "dump": {
      const url = args.find((a) => !a.startsWith("--"));
      if (!url) fail("usage: npm run dump -- <careers-page-url>");
      const { company } = await detect(url);
      const target = apiUrl(company);
      log(`GET ${target}\n`);
      const data = await getJson(target);
      const preview = JSON.stringify(data, null, 2);
      log(preview.slice(0, 6000));
      if (preview.length > 6000) log(`\n… ${preview.length - 6000} more characters`);
      return;
    }

    case "feedback": {
      const [idOrPrefix, label, ...note] = args;
      if (!idOrPrefix || !label) {
        fail("usage: npm run feedback -- <job-id> applied|shortlisted|skipped [note]");
      }
      if (!isStage(label)) {
        fail(`unknown stage "${label}". Use one of: ${STAGES.join(", ")}.`);
      }
      const db = open();
      const job = getJob(db, idOrPrefix) ?? findJobByPrefix(db, idOrPrefix);
      if (!job) fail(`no posting found for id/prefix "${idOrPrefix}"`);
      const text = note.join(" ").trim();
      recordDecision(db, job.id, label, text || undefined);
      log(`${label}: ${job.company} — ${job.title}  (${job.id})`);

      if (text) {
        const proposals = classifyNote(text);
        if (!proposals.length) {
          log(`note kept, but nothing in it maps to a constraint yet`);
        } else {
          const added = proposeConstraints(
            db,
            proposals.map((p) => ({ kind: p.kind, value: p.value, note: text, jobId: job.id })),
          );
          if (added) {
            log(`${added} constraint(s) proposed — review them: npm run learn`);
            log("nothing changes until you confirm");
          } else {
            log("that constraint was already known");
          }
        }
      }
      return;
    }

    case "learn": {
      const db = open();

      if (args.includes("--reset")) {
        const shadow = db.prepare("DELETE FROM shadow_scores").run();
        const runs = db.prepare("DELETE FROM learning_runs").run();
        // Proposals are derived from notes; confirmed ones are the user's own
        // statements and survive. Labels always survive.
        const proposedRows = db
          .prepare("DELETE FROM learning_constraints WHERE status = 'proposed'")
          .run();
        log(
          `forgot ${shadow.changes} shadow score(s), ${runs.changes} learning run(s) and ` +
            `${proposedRows.changes} unconfirmed constraint(s); your labels and confirmed ` +
            `constraints are untouched`,
        );
        return;
      }

      if (args.includes("--history")) {
        const runs = learningRuns(db, 5);
        if (!runs.length) {
          log("no learning run has influenced a score yet");
          return;
        }
        for (const r of runs) {
          log(`${r.at}  rules ${r.version}  ${r.labels} labels`);
        }
        return;
      }

      if (args.includes("--confirm") || args.includes("--reject")) {
        const status = args.includes("--confirm") ? "confirmed" : "rejected";
        const id = args.find((a) => !a.startsWith("--"));
        const flag = status === "confirmed" ? "confirm" : "reject";
        if (!id) fail(`usage: npm run learn -- --${flag} <constraint-id>`);
        if (!setConstraintStatus(db, id, status)) fail(`no constraint "${id}"`);
        log(`${status}: ${id}`);
        return;
      }

      let profile;
      try {
        profile = loadProfile();
      } catch {
        profile = undefined;
      }
      const learning = buildLearning(db, profile);
      const proposed = listConstraints(db, "proposed");
      if (!learning.applied && !learning.skipped && !proposed.length) {
        log("no labels yet. Label a few postings: npm run feedback -- <id> applied");
        return;
      }

      log(`applied ${learning.applied} · skipped ${learning.skipped}`);
      for (const t of learning.trackCalibration) {
        log(
          `  ${t.track.padEnd(12)} applied median ${String(t.appliedMedian ?? "—").padStart(3)} ` +
            `(n=${t.applied})   skipped median ${String(t.skippedMedian ?? "—").padStart(3)} (n=${t.skipped})`,
        );
      }

      if (learning.suggestedMinScore !== undefined) {
        log(`\nsuggested MIN_SCORE: ${learning.suggestedMinScore}`);
        log("set it in .env to match where your own decisions actually sit");
      } else if (!learning.enoughLabels) {
        log(
          `\nnot enough labels to influence the scorer yet: need 5 applied and 10 skipped, ` +
            `have ${learning.applied} and ${learning.skipped}`,
        );
        log("the scorer still runs on your profile alone");
      } else {
        log("\nnot enough separation yet to suggest a threshold");
        log("the labels are already fed to the scorer as calibration evidence");
      }

      if (learning.preferences.length) {
        log("\nwhat your applications have in common:");
        for (const p of learning.preferences) {
          log(
            `  ${p.term} — ${p.applied} of ${p.applied + p.skipped} postings mentioning it were applied to ` +
              `(${Math.round(p.baselineRate * 100)}% overall)`,
          );
        }
      }

      if (proposed.length) {
        log("\nconstraints proposed from your notes — none applied yet:");
        for (const c of proposed) {
          log(`  ${c.id}  ${describeConstraint(c.kind as ConstraintKind, c.value)}  \"${c.note}\"`);
        }
        log("confirm with: npm run learn -- --confirm <id>");
        log("ignore with:  npm run learn -- --reject <id>");
      }
      return;
    }

    case "eval": {
      const db = open();
      const flag = args.indexOf("--holdout");
      let holdoutDays: number | undefined;
      if (flag >= 0) {
        const next = args[flag + 1];
        const n = next && !next.startsWith("--") ? Number(next) : 30;
        holdoutDays = Number.isFinite(n) && n > 0 ? Math.round(n) : 30;
      }
      runEval(db, loadTracks(), { holdoutDays });
      return;
    }

    case "funnel": {
      const db = open();
      const counts = funnelCounts(db);
      if (!counts.length) {
        log("no applications logged yet. label one with: npm run feedback -- <id> applied");
        return;
      }
      for (const line of funnelLines(counts)) log(line);
      return;
    }

    case "backup": {
      const db = open();
      const path = backupDatabase(db, join(configDir(), "backups"));
      log(`backup written: ${path}`);
      log(`kept: ${listBackups(join(configDir(), "backups")).length} (seven by default)`);
      return;
    }

    case "health": {
      const db = open();
      log(`scheduler      ${scheduleStatus() ? "installed" : "not installed"}`);
      const [last] = runHistory(db, 1);
      if (!last) {
        log("last run       none recorded");
      } else {
        const state = last.finished ? "finished" : "did not finish";
        log(`last run       ${last.started} · ${state} · ${last.scored} scored`);
        if (last.errors.length) {
          log(`run errors     ${last.errors.length}`);
          for (const e of last.errors.slice(0, 3)) log(`  ${e.source}: ${e.message}`);
        }
      }
      const yields = latestBoardYield(db);
      if (yields.length) {
        const producing = yields.filter((y) => y.matched > 0).length;
        log(`yield          ${producing} of ${yields.length} board(s) matched in the last run`);
      }

      const backups = listBackups(join(configDir(), "backups"));
      log(`backups        ${backups.length}${backups[0] ? ` (newest ${backups[0]})` : ""}`);
      const s = stats(db);
      log(`directory      ${listBoards(db).length} boards · ${s.jobs} postings · ${s.decisions} labelled`);
      return;
    }

    case "stats": {
      const db = open();
      printStats(db, loadTracks());
      return;
    }

    default:
      fail(`unknown command "${command}". Run with no arguments for help.`);
  }
}

main().catch((err) => {
  fail((err as Error).message ?? String(err));
});
