import { createHash } from "node:crypto";
import type { Lang } from "../types.ts";

const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&ndash;": "–",
  "&mdash;": "—",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&hellip;": "…",
};

/** HTML (or plain text) -> readable plain text. Stable output is required
 *  because the result is hashed to decide whether a job needs re-scoring. */
export function clean(input: string): string {
  if (!input) return "";
  let s = repairMojibake(input);
  s = stripMarkup(s);
  s = decodeEntities(s);
  // Some feeds ship HTML that is itself HTML-escaped, so decoding re-introduces
  // tags. Stripping a second time is cheaper than a second pass over the source.
  s = stripMarkup(s);
  s = s.replace(/[ \t\u00a0]+/g, " ");
  s = s.replace(/\n\s*\n\s*\n+/g, "\n\n");
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  return s.trim();
}

function stripMarkup(input: string): string {
  let s = input;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n");
  s = s.replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|section|article)\s*>/gi, "\n");
  s = s.replace(/<\s*(li|tr)\b[^>]*>/gi, "\n• ");
  return s.replace(/<[^>]+>/g, " ");
}

function decodeEntities(input: string): string {
  let s = input;
  for (const [entity, value] of Object.entries(ENTITIES)) s = s.split(entity).join(value);
  s = s.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
  return s;
}

/**
 * Some feeds ship UTF-8 bytes that were already decoded as Latin-1, so "’"
 * arrives as three characters: â, U+0080, U+0099. The C1 control range is the
 * tell — it never appears in legitimate text — so repair only when it is
 * present and only keep the result if it comes back clean. A blind
 * latin1 round-trip would destroy correctly encoded accents like "für".
 */
/** Windows-1252 glyphs for bytes 0x80-0x9F, which decode to punctuation rather
 *  than C1 controls. Arabic and Hebrew feeds hit this path constantly. */
const CP1252_REVERSE: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
  "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
  "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

const CP1252_SPECIAL = new RegExp("[" + Object.keys(CP1252_REVERSE).join("") + "]");

/**
 * Some feeds ship UTF-8 bytes that were already decoded as Latin-1 or
 * Windows-1252, so "’" arrives as â + U+0080 + U+0099, and Arabic arrives as
 * sequences like "Ù…Ø³Ù‚Ø·".
 *
 * The repair only runs when the text carries the tell-tales — C1 controls, or a
 * high-Latin character next to a Windows-1252 punctuation glyph — and it is
 * only kept when the result decodes cleanly. A blind round-trip would destroy
 * correctly encoded text such as "Café … yes".
 */
export function repairMojibake(input: string): string {
  const hasC1 = /[\u0080-\u009F]/.test(input);
  const hasHighLatin = /[\u00C0-\u00FF]/.test(input);
  const hasCp1252 = CP1252_SPECIAL.test(input);
  // "Ã¼" is a two-byte sequence with no punctuation glyph, so it needs its own
  // signal; otherwise plain Latin-1 double-encoding is never repaired.
  const looksLatin1Pair = /[\u00C2\u00C3][\u0080-\u00BF]/.test(input);
  if (!hasC1 && !looksLatin1Pair && !(hasHighLatin && hasCp1252)) return input;

  const bytes: number[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0xff) {
      // Includes C1 controls, which are raw bytes, not punctuation.
      bytes.push(code);
    } else if (CP1252_REVERSE[ch] !== undefined) {
      bytes.push(CP1252_REVERSE[ch]);
    } else {
      return input;
    }
  }

  try {
    const repaired = Buffer.from(Uint8Array.from(bytes)).toString("utf8");
    return repaired.includes("\uFFFD") ? input : repaired;
  } catch {
    return input;
  }
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 24);
}

/** Stable fingerprint of a posting. Sorted locations so ordering never
 *  produces a duplicate row. */
export function jobId(company: string, title: string, locations: string[]): string {
  const key = [company, title, [...locations].sort().join("|")]
    .join("::")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

export function excerpt(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Hebrew / Latin ratio. Hebrew JDs are frequently padded with English job
 *  titles, so the threshold is deliberately lower than 50%. */
export function detectLang(text: string): Lang {
  const he = (text.match(/[\u0590-\u05FF]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = he + en;
  if (total < 40) return "und";
  const ratio = he / total;
  if (ratio >= 0.5) return "he";
  if (ratio >= 0.08) return "mixed";
  return "en";
}
