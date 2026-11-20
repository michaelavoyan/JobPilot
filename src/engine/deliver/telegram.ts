import type { ScoredJob } from "../types.ts";
import { env, warn } from "../util.ts";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Optional. The digest is the product; this is a convenience push.
 * A failure here must never fail the run.
 */
export async function pushTelegram(jobs: ScoredJob[], top = 5): Promise<boolean> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const chatId = env("TELEGRAM_CHAT_ID");
  if (!token || !chatId) return false;
  if (!jobs.length) return false;

  const lines: string[] = [`<b>JobPilot — ${jobs.length} matches</b>`, ""];
  for (const job of jobs.slice(0, top)) {
    const where = job.remote ? "Remote" : job.locations.join(", ") || "—";
    lines.push(`<b>${job.score}</b> · ${escapeHtml(job.company)} · ${escapeHtml(job.title)}`);
    lines.push(`<i>${escapeHtml(where)}</i>`);
    if (job.url) lines.push(`<a href="${escapeHtml(job.url)}">apply</a>`);
    lines.push("");
  }

  try {
    const base = env("TELEGRAM_API_BASE") ?? "https://api.telegram.org";
    const res = await fetch(`${base}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn(`telegram push failed: HTTP ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    warn(`telegram push failed: ${(err as Error).message}`);
    return false;
  }
}
