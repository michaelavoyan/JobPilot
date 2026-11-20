/**
 * A field is what the candidate is searching for. It is more than a label: it
 * decides which titles are out of scope and what the scorer should optimise for.
 *
 * Adding a field means adding one entry here — the pipeline, the filter, the
 * prompt and the UI all read from this list.
 */
export interface Field {
  id: string;
  label: string;
  /** Titles that mean "not this field", whatever the track says. */
  excludeTitles: string[];
  /** One line handed to the scorer. */
  context: string;
}

export const FIELDS: Field[] = [
  {
    id: "it",
    label: "Hi-Tech & Software",
    excludeTitles: [
      "sales",
      "account executive",
      "business development",
      "recruiter",
      "talent acquisition",
      "marketing",
      "brand",
      "finance",
      "accountant",
      "bookkeeper",
      "controller",
      "legal",
      "procurement",
      "customer success",
      "technical support",
      "office manager",
      "graphic designer",
      "copywriter",
    ],
    context:
      "software and technology roles — engineering, platform, data, mobile, " +
      "devops, security, qa — including the managers who lead those teams",
  },
];

export const DEFAULT_FIELD = FIELDS[0].id;

export function fieldById(id: string | undefined): Field | undefined {
  return FIELDS.find((field) => field.id === (id ?? DEFAULT_FIELD));
}
