/**
 * Turns a free-text note on a decision into a constraint worth proposing.
 *
 * Deliberately lexical and conservative. A note is the most direct statement of
 * preference the system ever receives, and it is also the easiest thing to
 * misread — "not a manager role" and "manager role" share every word that
 * matters. So this only fires on phrases it can match exactly, and any note it
 * cannot read produces nothing at all. A proposal is never applied until the
 * user confirms it.
 */

export type ConstraintKind =
  | "location_penalty"
  | "seniority_penalty"
  | "hands_on_penalty"
  | "domain_penalty";

export interface NoteConstraint {
  kind: ConstraintKind;
  /** Only domain constraints carry one. */
  value?: string;
  note: string;
}

interface Rule {
  kind: ConstraintKind;
  patterns: RegExp[];
}

/** Domains a note can name. Kept short: a wrong word here invents a preference. */
const DOMAINS = [
  "adtech",
  "advertising",
  "fintech",
  "banking",
  "insurance",
  "crypto",
  "gambling",
  "betting",
  "gaming",
  "health",
  "medical",
  "defense",
  "military",
  "retail",
  "ecommerce",
  "edtech",
  "telecom",
  "media",
  "consulting",
  "outsourcing",
];

const RULES: Rule[] = [
  {
    kind: "location_penalty",
    patterns: [
      /\btoo far\b/,
      /\bfar from\b/,
      /\bcommute\b/,
      /\bno relocation\b/,
      /\bwon'?t relocate\b/,
      /רחוק/,
      /נסיע/,
      /פקקים/,
      /הגעה/,
    ],
  },
  {
    kind: "seniority_penalty",
    patterns: [
      /\btoo junior\b/,
      /\bjunior role\b/,
      /\bbelow my level\b/,
      /\bstep down\b/,
      /\bdemotion\b/,
      /ג'וניור/,
      /מתחת לרמה/,
      /ירידה בדרגה/,
    ],
  },
  {
    kind: "hands_on_penalty",
    patterns: [
      /\bhands[- ]on\b/,
      /\bno (more )?coding\b/,
      /\bnot technical\b/,
      /\bpure(ly)? management\b/,
      /ידיים על/,
      /לא לכתוב קוד/,
      /ניהולי בלבד/,
    ],
  },
];

/** "no adtech", "avoid gambling", "לא פינטק" — a domain named in a rejection. */
const DOMAIN_NEGATION = /\b(no more|not|avoid|hate|don'?t want|never)\s+([a-z]+)\b/i;
const DOMAIN_NEGATION_HE = /(לא|בלי)\s+([a-z\u0590-\u05FF]+)/;

export function classifyNote(note: string): NoteConstraint[] {
  const text = note.trim();
  if (!text) return [];

  const found: NoteConstraint[] = [];
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      found.push({ kind: rule.kind, note: text });
    }
  }

  for (const match of [text.match(DOMAIN_NEGATION), text.match(DOMAIN_NEGATION_HE)]) {
    if (!match) continue;
    const word = match[2].toLowerCase();
    if (DOMAINS.includes(word) && !found.some((f) => f.kind === "domain_penalty")) {
      found.push({ kind: "domain_penalty", value: word, note: text });
    }
  }

  return found;
}

/** Human wording for a proposal, used in the CLI and the page. */
export function describeConstraint(kind: ConstraintKind, value?: string): string {
  switch (kind) {
    case "location_penalty":
      return "Down-weight roles that are far away";
    case "seniority_penalty":
      return "Down-weight roles below the candidate's level";
    case "hands_on_penalty":
      return "Down-weight roles that are hands-on rather than managerial";
    case "domain_penalty":
      return value ? `Down-weight roles in ${value}` : "Down-weight roles in that domain";
  }
}
