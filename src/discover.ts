import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { resolve } from "node:path";
import type { Company } from "./config.ts";
import { configDir } from "./util.ts";

export function companiesPath(): string {
  return resolve(configDir(), "companies.yaml");
}

interface Detection {
  company: Company;
  note?: string;
}

/**
 * Turns a careers page URL into a companies.yaml entry.
 * Only the four ATSs with public JSON endpoints are supported by design —
 * portals like AllJobs have no API and are not scraped here.
 */
export async function detect(url: string, name?: string): Promise<Detection> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url}`);
  }
  const host = u.hostname.replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean);

  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    return { company: { name: name ?? seg[0], source: "greenhouse", slug: seg[0] } };
  }
  if (host === "jobs.lever.co") {
    return { company: { name: name ?? seg[0], source: "lever", slug: seg[0] } };
  }
  if (host === "jobs.ashbyhq.com") {
    return { company: { name: name ?? seg[0], source: "ashby", slug: seg[0] } };
  }
  if (host.endsWith("comeet.com")) {
    // UIDs look like 72.006 or 5A.00A, so letters and digits both appear.
    const uid = (u.pathname.match(/\/([A-Z0-9]{1,4}\.[A-Z0-9]{3})\b/i) ?? [])[1];
    if (!uid) throw new Error("could not find a Comeet company UID in that URL");

    const token = await findComeetToken(url);
    if (!token) {
      throw new Error(
        `found Comeet UID ${uid} but no public token on the page. ` +
          "Open the careers page, view source, and search for 'token=' — paste it into companies.yaml.",
      );
    }
    return {
      company: { name: name ?? `comeet-${uid}`, source: "comeet", uid, token },
      note: "token scraped from the careers page; verify it still works",
    };
  }

  throw new Error(
    `unsupported host: ${host}. Supported: boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, *.comeet.com`,
  );
}

async function findComeetToken(pageUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(pageUrl, {
      headers: { "user-agent": "JobPilot/0.1" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return undefined;
    const html = await res.text();
    const direct = html.match(/positions\?token=([A-Za-z0-9_-]{6,})/);
    if (direct) return direct[1];
    const quoted = html.match(/["']token["']\s*:\s*["']([A-Za-z0-9_-]{6,})["']/);
    return quoted?.[1];
  } catch {
    return undefined;
  }
}

function entryLine(company: Company): string {
  return company.source === "comeet"
    ? `  - { name: "${company.name}", source: comeet, uid: "${company.uid}", token: "${company.token}" }`
    : `  - { name: "${company.name}", source: ${company.source}, slug: "${company.slug}" }`;
}

/** Adds several companies at once, skipping any already present. */
export function appendCompanies(list: Company[]): { added: number; skipped: number } {
  const text = readFileSync(companiesPath(), "utf8");
  const present = new Set(
    (parse(text) as { companies?: Company[] } | null)?.companies?.map(
      (c) => `${c.source}:${c.slug ?? c.uid}`,
    ) ?? [],
  );

  const lines: string[] = [];
  let skipped = 0;
  for (const company of list) {
    const key = `${company.source}:${company.slug ?? company.uid}`;
    if (present.has(key)) {
      skipped++;
      continue;
    }
    present.add(key);
    lines.push(entryLine(company));
  }
  if (!lines.length) return { added: 0, skipped };

  const block = lines.join("\n");
  let next: string;
  if (/^companies:\s*\[\s*\]\s*$/m.test(text)) {
    next = text.replace(/^companies:\s*\[\s*\]\s*$/m, `companies:\n${block}`);
  } else if (/^companies:\s*$/m.test(text)) {
    next = text.replace(/^companies:\s*$/m, `companies:\n${block}`);
  } else {
    next = text.trimEnd() + "\n" + block + "\n";
  }
  writeFileSync(companiesPath(), next, "utf8");
  return { added: lines.length, skipped };
}

export function appendCompany(company: Company): void {
  const text = readFileSync(companiesPath(), "utf8");
  const entry =
    company.source === "comeet"
      ? `  - { name: "${company.name}", source: comeet, uid: "${company.uid}", token: "${company.token}" }`
      : `  - { name: "${company.name}", source: ${company.source}, slug: "${company.slug}" }`;

  let next: string;
  if (/^companies:\s*\[\s*\]\s*$/m.test(text)) {
    next = text.replace(/^companies:\s*\[\s*\]\s*$/m, `companies:\n${entry}`);
  } else if (/^companies:\s*$/m.test(text)) {
    next = text.replace(/^companies:\s*$/m, `companies:\n${entry}`);
  } else {
    next = text.trimEnd() + "\n" + entry + "\n";
  }
  writeFileSync(companiesPath(), next, "utf8");
}
