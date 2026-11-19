import type { Comp, Period } from "../types.ts";

export type CurrencyMarkers = Record<string, string[]>;

const PERIOD_MONTH = /(לחודש|חודשי|monthly|per month|\/month|\bחודש\b)/i;
const PERIOD_YEAR = /(לשנה|שנתי|annual|\/year|per year|\byear\b)/i;
const PERIOD_HOUR = /(לשעה|שעתי|hourly|\/hour|per hour)/i;
const PERIOD_DAY = /(ליום|יומי|daily|\/day|per day)/i;

const AMOUNT = /(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|אלף)?/gi;
const URLISH = /(https?:|www\.|\.com|\.io|\.co)/i;

/** How far from the number a currency marker may sit. */
const WINDOW = 45;

const SYMBOLS: Record<string, string> = {
  ILS: "₪",
  USD: "$",
  EUR: "€",
  GBP: "£",
  CAD: "C$",
  AUD: "A$",
};

const compiled = new Map<string, RegExp>();

/** Word boundaries only where the marker is alphanumeric: "ils" must not match
 *  inside "details", but "₪" has no boundary to speak of. */
function markerPattern(marker: string): RegExp {
  const cached = compiled.get(marker);
  if (cached) return cached;
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[a-z0-9]/i.test(marker) ? "\\b" : "";
  const suffix = /[a-z0-9]$/i.test(marker) ? "\\b" : "";
  const re = new RegExp(prefix + escaped + suffix, "i");
  compiled.set(marker, re);
  return re;
}

export function detectCurrency(text: string, markers: CurrencyMarkers): string | undefined {
  for (const [code, list] of Object.entries(markers)) {
    for (const marker of list) {
      if (marker && markerPattern(marker).test(text)) return code;
    }
  }
  return undefined;
}

function parseAmount(raw: string): number | undefined {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function periodOf(window: string): Period | undefined {
  if (PERIOD_HOUR.test(window)) return "hour";
  if (PERIOD_DAY.test(window)) return "day";
  if (PERIOD_MONTH.test(window)) return "month";
  if (PERIOD_YEAR.test(window)) return "year";
  return undefined;
}

export interface CompOptions {
  markers: CurrencyMarkers;
  /** Period to assume when the posting does not state one. Comes from
   *  market.comp_period: Israeli salaries are monthly, US salaries annual. */
  defaultPeriod?: Period;
  /** Currency to assume when a marker is ambiguous. */
  currency?: string;
}

/**
 * Currency-agnostic on purpose: markers, default period and currency all come
 * from config/market.yaml, so a new country adds config, not code.
 *
 * Deliberately conservative. A greedy parser silently deletes good jobs, which
 * is the worst failure mode in this pipeline, so every number must sit next to
 * a currency marker, must not be part of a URL or an identifier, and must fall
 * inside a plausible salary band.
 */
export function extractComp(text: string, options: CompOptions): Comp | undefined {
  const { markers, defaultPeriod = "month", currency: fallbackCurrency } = options;
  if (!text || !Object.keys(markers).length) return undefined;

  for (const line of text.split("\n")) {
    const lineCurrency = detectCurrency(line, markers);
    if (!lineCurrency) continue;

    AMOUNT.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AMOUNT.exec(line)) !== null) {
      const start = Math.max(0, match.index - WINDOW);
      const end = Math.min(line.length, match.index + match[0].length + WINDOW);
      const window = line.slice(start, end);

      const currency = detectCurrency(window, markers) ?? lineCurrency;
      if (!currency) continue;
      if (URLISH.test(window)) continue;

      const before = line.slice(Math.max(0, match.index - 2), match.index);
      if (/#/.test(before)) continue;

      let amount = parseAmount(match[1]);
      if (amount === undefined) continue;
      if (match[2]) amount *= 1000;
      if (amount < 1000) continue;

      const period: Period = periodOf(window) ?? defaultPeriod;

      const monthly = period === "year" ? amount / 12 : amount;
      if (monthly < 3_000 || monthly > 150_000) continue;

      return {
        amount,
        currency: currency ?? fallbackCurrency,
        period,
        raw: line.trim().slice(0, 120),
      };
    }
  }
  return undefined;
}

const MONTHS_PER: Record<Period, number> = { month: 1, year: 1 / 12, day: 21, hour: 182 };

export function toMonthly(comp: Comp | null | undefined): number | undefined {
  if (!comp || comp.amount === undefined) return undefined;
  const period: Period = comp.period ?? "month";
  return Math.round(comp.amount * MONTHS_PER[period]);
}

export function formatComp(comp: Comp | undefined): string | undefined {
  if (!comp?.amount) return undefined;
  const amount = comp.amount.toLocaleString("en-US");
  const cur = comp.currency ? (SYMBOLS[comp.currency] ?? comp.currency + " ") : "";
  const per =
    comp.period === "year"
      ? "/yr"
      : comp.period === "hour"
        ? "/hr"
        : comp.period === "day"
          ? "/day"
          : "/mo";
  return `${cur}${amount}${per}`;
}
