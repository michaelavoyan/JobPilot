import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { chat } from "../score/llm.ts";
import { extractJson } from "../score/json.ts";

export interface ExtractedProfile {
  name: string;
  email?: string;
  phone?: string;
  country?: string;
  headline?: string;
  current_title?: string;
  previous_titles: string[];
  experience: {
    total_years: number;
    management_years: number;
    max_team_size?: number;
    employment_status?: string;
  };
  domains: string[];
  stack: string[];
  ai_practice: string[];
  people_management: string[];
  languages: Record<string, string>;
  education?: { degree?: string; institution?: string };
  military?: { unit?: string; rank?: string };
  citizenship: string[];
}

const MAX_CV_CHARS = 30_000;

/**
 * Word documents are a zip archive; the text lives in word/document.xml as
 * <w:t> runs inside <w:p> paragraphs. Extracted directly rather than through a
 * converter, which keeps the dependency small and the output predictable.
 */
export function docxText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<w:cr\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** PDF, DOCX or Markdown. Scanned PDFs have no text layer and are
 *  rejected explicitly rather than silently producing an empty profile. */
export async function readCv(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();

  if (ext === ".pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)));
    const { text } = await extractText(pdf, { mergePages: true });
    const trimmed = String(text ?? "").trim();
    if (trimmed.length < 200) {
      throw new Error(
        `${path}: only ${trimmed.length} characters of text found. ` +
          "This looks like a scanned PDF with no text layer; export a text-based PDF instead.",
      );
    }
    return trimmed;
  }

  if (ext === ".md" || ext === ".markdown") {
    const text = readFileSync(path, "utf8").trim();
    if (!text) throw new Error(`${path} is empty`);
    return text;
  }

  if (ext === ".docx") {
    const { unzipSync, strFromU8 } = await import("fflate");
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(readFileSync(path)));
    } catch {
      throw new Error(`${path} is not a readable Word document`);
    }
    const document = entries["word/document.xml"];
    if (!document) {
      throw new Error(
        `${path} has no word/document.xml. If this is a legacy .doc file, save it as .docx or PDF.`,
      );
    }
    const text = docxText(strFromU8(document));
    if (text.length < 200) {
      throw new Error(
        `${path}: only ${text.length} characters of text found. ` +
          "The document may contain images only.",
      );
    }
    return text;
  }

  throw new Error(`unsupported CV format "${ext}". Use .pdf, .docx or .md.`);
}

const SYSTEM = `
You extract a structured candidate profile from a CV. You are a parser, not a
recruiter: report only what the document supports.

Rules:
1. Never invent employers, dates, skills, degrees or metrics.
2. total_years = earliest professional role to today, in whole years.
   Do not count internships or education.
3. management_years = years spent in roles with direct reports. A "tech lead"
   with no reports is not management.
4. max_team_size = the largest number of people explicitly stated as reporting
   to the candidate. Omit if the CV does not say.
5. domains = 3-8 short lowercase phrases describing the industries and product
   areas (e.g. "mobile", "media & streaming", "digital identity").
6. stack = canonical technology names only, one per entry, no prose.
7. previous_titles = job titles held before the current one, newest first,
   excluding the current title.
8. languages = map of language code to level, using the CV's own wording.
9. people_management = 3-6 short phrases of at most 8 words each describing
   management scope, e.g. "20-engineer org", "hiring and performance reviews".
   Not sentences, not copied bullet points.
10. ai_practice = short labels for AI tooling and methods, at most 6 words each.
11. If a field is absent, omit it or return an empty array. Do not guess.
12. Never output salary expectations, commute preferences or anything that is
    a preference rather than a fact about the candidate.

Return ONLY a JSON object of this shape:
{
  "name": string,
  "email": string,
  "phone": string,
  "country": string,             // ISO 3166-1 alpha-2 if inferable
  "headline": string,            // one line, <= 120 chars
  "current_title": string,
  "previous_titles": string[],
  "experience": {
    "total_years": number,
    "management_years": number,
    "max_team_size": number
  },
  "domains": string[],
  "stack": string[],
  "ai_practice": string[],
  "people_management": string[],
  "languages": { "<code>": "<level>" },
  "education": { "degree": string, "institution": string },
  "military": { "unit": string, "rank": string },
  "citizenship": string[]
}
`.trim();

export async function extractProfile(cvText: string): Promise<ExtractedProfile> {
  const body = cvText.slice(0, MAX_CV_CHARS);
  const truncated = cvText.length > MAX_CV_CHARS;
  const user = [
    "Extract the profile from this CV.",
    truncated ? "(The CV was truncated; extract only what is present.)" : "",
    "",
    "--- CV START ---",
    body,
    "--- CV END ---",
  ]
    .filter(Boolean)
    .join("\n");

  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await chat(SYSTEM, user + feedback);
    const payload = extractJson(res.text);
    if (payload) {
      const normalized = normalizeProfile(payload);
      if (normalized) return normalized;
      feedback = "\n\nThe previous reply was missing name or experience.total_years. Both are required.";
      continue;
    }
    feedback = "\n\nThe previous reply was not valid JSON. Return only the JSON object.";
  }

  throw new Error("could not extract a profile from this CV — the model did not return usable JSON");
}

/** Coerce whatever the model returned into the profile shape. Unknown keys are
 *  dropped so a chatty response cannot pollute the generated config. */
export function normalizeProfile(raw: unknown): ExtractedProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const name = text(r.name);
  const exp = (r.experience ?? {}) as Record<string, unknown>;
  const totalYears = clampYears(exp.total_years);
  if (!name || totalYears === null || totalYears <= 0) return null;

  const education = r.education as Record<string, unknown> | undefined;
  const military = r.military as Record<string, unknown> | undefined;

  const out: ExtractedProfile = {
    name,
    email: text(r.email),
    phone: text(r.phone),
    country: text(r.country)?.toUpperCase().slice(0, 2),
    headline: text(r.headline)?.slice(0, 160),
    current_title: text(r.current_title),
    previous_titles: strings(r.previous_titles, 12, 90),
    experience: {
      total_years: totalYears,
      management_years: clampYears(exp.management_years) ?? 0,
      max_team_size: clampInt(exp.max_team_size, 0, 500),
      employment_status: "open_to_work",
    },
    domains: strings(r.domains, 10, 60),
    stack: strings(r.stack, 40, 40),
    ai_practice: strings(r.ai_practice, 12, 90),
    people_management: strings(r.people_management, 6, 60),
    languages: languageMap(r.languages),
    education:
      education && (text(education.degree) || text(education.institution))
        ? { degree: text(education.degree), institution: text(education.institution) }
        : undefined,
    military:
      military && (text(military.unit) || text(military.rank))
        ? { unit: text(military.unit), rank: text(military.rank) }
        : undefined,
    citizenship: strings(r.citizenship, 4, 2).map((c) => c.toUpperCase()),
  };

  return out;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed || undefined;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trim();
}

function strings(value: unknown, max: number, maxLen: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const s = text(item);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clip(s, maxLen));
    if (out.length >= max) break;
  }
  return out;
}

function clampYears(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(60, Math.round(n)));
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function languageMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, level] of Object.entries(value as Record<string, unknown>)) {
    const code = key.trim().toLowerCase().slice(0, 8);
    const val = text(level);
    if (code && val) out[code] = val.slice(0, 24);
  }
  return out;
}
