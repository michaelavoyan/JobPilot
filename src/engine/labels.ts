/**
 * What a decision means for ranking.
 *
 * The stages in `STAGES` are a funnel, not a scale: a posting you interviewed
 * for is stronger evidence than one you merely applied to, and neither is a
 * skip. `rejected` is deliberately in neither group — it can mean the company
 * rejected the candidate or the candidate rejected an offer, and guessing wrong
 * would teach the scorer the opposite of the truth.
 */
export const POSITIVE_LABELS: readonly string[] = [
  "shortlisted",
  "applied",
  "screening",
  "interview",
  "offer",
];

/** The only unambiguous negative: the candidate looked and declined. */
export const NEGATIVE_LABELS: readonly string[] = ["skipped"];

export function isPositive(label: string): boolean {
  return POSITIVE_LABELS.includes(label);
}

export function isNegative(label: string): boolean {
  return NEGATIVE_LABELS.includes(label);
}
