export type Period = "month" | "year" | "hour" | "day";
export type Lang = "he" | "en" | "mixed" | "und";

export interface Comp {
  amount?: number;
  currency?: string;
  period?: Period;
  raw?: string;
}

export interface Job {
  id: string;
  source: string;
  company: string;
  title: string;
  url: string;
  /** Canonical city names, empty when unknown. */
  locations: string[];
  remote: boolean;
  description: string;
  postedAt?: string;
  comp?: Comp;
  lang: Lang;
  country: string;
}

export interface Score {
  jobId: string;
  track: string;
  score: number;
  reasons: string[];
  flags: string[];
}

export interface Verdict {
  ok: boolean;
  reason?: string;
  flags: string[];
}

export interface ScoredJob extends Job {
  track: string;
  score: number;
  reasons: string[];
  flags: string[];
}

export interface SourceError {
  source: string;
  message: string;
}
