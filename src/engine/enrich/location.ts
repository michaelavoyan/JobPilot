const REMOTE = /\b(remote|fully remote|work from home|wfh|distributed)\b|מרחוק|עבודה מהבית|היברידי|hybrid/i;
const HYBRID = /היברידי|hybrid/i;

export interface CanonLocation {
  cities: string[];
  remote: boolean;
  hybrid: boolean;
}

/**
 * Maps free-text locations onto canonical names. Postings mix languages and
 * spell the same city several ways ("תל אביב-יפו", "Tel Aviv District"), so this
 * is alias-driven rather than a fixed list.
 */
export function canonicalLocation(
  raw: string[],
  aliases: Record<string, string>,
): CanonLocation {
  const cities = new Set<string>();
  let remote = false;
  let hybrid = false;

  for (const item of raw) {
    if (!item) continue;
    const text = item.trim();
    if (!text) continue;

    if (REMOTE.test(text)) {
      remote = true;
      if (HYBRID.test(text)) hybrid = true;
    }

    let matched = false;
    for (const [alias, canonical] of Object.entries(aliases)) {
      if (text.toLowerCase().includes(alias.toLowerCase())) {
        if (canonical === "Remote") remote = true;
        else if (canonical === "Hybrid") hybrid = true;
        else cities.add(canonical);
        matched = true;
      }
    }
    if (!matched && !REMOTE.test(text)) cities.add(titleCaseCity(text));
  }

  return { cities: [...cities], remote, hybrid };
}

function titleCaseCity(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** True when a canonical location string falls inside the candidate's radius. */
export function inRadius(
  locations: string[],
  allowed: string[],
  regions: string[],
): { hit: boolean; matched?: string } {
  const haystack = locations.join(" | ").toLowerCase();
  for (const city of allowed) {
    if (haystack.includes(city.toLowerCase())) return { hit: true, matched: city };
  }
  for (const region of regions) {
    if (haystack.includes(region.toLowerCase())) return { hit: true, matched: region };
  }
  return { hit: false };
}
