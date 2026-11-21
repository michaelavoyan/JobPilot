import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";

const html = readFileSync(resolve(import.meta.dirname, "..", "src", "ui", "index.html"), "utf8");
const script = readFileSync(resolve(import.meta.dirname, "..", "src", "ui", "app.js"), "utf8");

const baseState = {
  configDir: "/repo/config",
  llm: { configured: true, model: "deepseek-v4.1-flash" },
  profile: {
    name: "Jane Doe",
    headline: "",
    years: 19,
    managementYears: 9,
    cvFile: "jane-doe-cv.pdf",
    field: "it",
    stack: 12,
    domains: 4,
    compFloor: null,
    locations: 5,
    tracks: [{ key: "b_senior_em", label: "Senior EM" }],
  },
  profileError: null,
  market: { country: "IL", currency: "ILS", period: "month" },
  companies: 24,
  stats: { jobs: 1619, active: 1619, scored: 65, decisions: 2, rejects: 4810 },
  rejects: [],
  markets: ["il", "us"],
  fields: [{ id: "it", label: "Hi-Tech & Software" }],
  interests: ["platform engineering"],
  boards: 28,
  discovery: { configured: false },
  running: false,
};

const jobs = [
  {
    id: "abc123",
    company: "Via",
    title: "Mobile Team Lead",
    url: "https://example.com/1",
    locations: ["Tel Aviv"],
    remote: false,
    track: "b_senior_em",
    score: 84,
    reasons: ["direct domain match"],
    flags: ["team_size_unspecified"],
  },
];

function boot(overrides: Record<string, unknown> = {}, jobsOverride: unknown = jobs) {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const state = { ...baseState, ...overrides };
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    const body = url.includes("/api/state")
      ? state
      : url.includes("/api/jobs")
        ? { jobs: jobsOverride }
        : { ok: true, interests: [] };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  return dom;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// app.js starts a refresh interval on every window. If a test fails before it
// closes its DOM, that timer keeps the process alive forever, so cleanup must
// not depend on the test reaching its last line.
const opened: JSDOM[] = [];
function track(dom: JSDOM): JSDOM {
  opened.push(dom);
  return dom;
}

afterEach(() => {
  for (const dom of opened.splice(0)) dom.window.close();
});

test("status pills come from /api/state", async () => {
  const dom = boot();
  await settle();
  const pills = dom.window.document.getElementById("pills")!.textContent ?? "";
  assert.equal(pills, "", "nothing is shown when there is nothing to report");
  assert.ok(!/ready/.test(pills), "no status noise when everything works");
  dom.window.close();
});

test("a missing API key is reported instead of a status pill", async () => {
  const dom = boot({ llm: { configured: false, model: null } });
  await settle();
  const pills = dom.window.document.getElementById("pills")!.textContent ?? "";
  assert.match(pills, /Scoring is off/);
  assert.match(pills, /API key/);
  dom.window.close();
});

test("the CV panel shows the file name, not the person's name", async () => {
  const dom = boot();
  await settle();
  const subtitle = dom.window.document.getElementById("subtitle")!.textContent ?? "";
  const drop = dom.window.document.getElementById("dropTitle")!.textContent ?? "";
  assert.match(subtitle, /jane-doe-cv\.pdf/);
  assert.match(drop, /jane-doe-cv\.pdf/);
  assert.ok(!subtitle.includes("Jane Doe"), "the candidate name must not be displayed");
  assert.match(dom.window.document.getElementById("cvStatus")!.textContent ?? "", /19 years/);
  dom.window.close();
});

test("with no profile the search button is disabled and explains why", async () => {
  const dom = boot({ profile: null, profileError: "no profile yet" });
  await settle();
  const button = dom.window.document.getElementById("search") as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.match(dom.window.document.getElementById("subtitle")!.textContent ?? "", /add your cv/i);
  dom.window.close();
});

test("the form has no step numbers and separates what from where", async () => {
  const dom = boot();
  await settle();
  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll(".step .n").length, 0, "numbering is gone");

  const headings = [...doc.querySelectorAll(".wizard h2")].map((h) => h.textContent?.trim());
  assert.deepEqual(headings.slice(0, 3), ["Your CV", "What", "Where"]);
  dom.window.close();
});

test("the field and country selectors sit in different sections", async () => {
  const dom = boot();
  await settle();
  const doc = dom.window.document;
  const fieldSection = doc.getElementById("field")!.closest(".step")!;
  const marketSection = doc.getElementById("market")!.closest(".step")!;
  assert.notEqual(fieldSection, marketSection);
  dom.window.close();
});

test("the companies step reports the directory size", async () => {
  const dom = boot();
  await settle();
  assert.match(dom.window.document.getElementById("companiesNote")!.textContent ?? "", /28 companies/);
  dom.window.close();
});

test("an empty directory is explained instead of showing a bare zero", async () => {
  const dom = boot({ boards: 0 }, []);
  await settle();
  const note = dom.window.document.getElementById("companiesNote")!.textContent ?? "";
  assert.match(note, /No companies yet/);
  assert.match(
    dom.window.document.getElementById("resultsHint")!.textContent ?? "",
    /No companies yet/,
    "the results panel must name the cause too",
  );
  dom.window.close();
});

test("bulk discovery is only offered when a search provider exists", async () => {
  const off = boot({ discovery: { configured: false } });
  await settle();
  assert.equal((off.window.document.getElementById("findCompanies") as HTMLElement).hidden, true);
  off.window.close();

  const on = boot({ discovery: { configured: true } });
  await settle();
  assert.equal((on.window.document.getElementById("findCompanies") as HTMLElement).hidden, false);
  on.window.close();
});

test("the field selector shows the single supported field and is locked", async () => {
  const dom = boot();
  await settle();
  const select = dom.window.document.getElementById("field") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].textContent, "Hi-Tech & Software");
  assert.equal(select.value, "it");
  assert.equal(select.disabled, true, "one option is a statement, not a choice");
  dom.window.close();
});

test("the country dropdown offers the configured markets and selects the active one", async () => {
  const dom = boot();
  await settle();
  const select = dom.window.document.getElementById("market") as HTMLSelectElement;
  assert.deepEqual(
    [...select.options].map((o) => o.value),
    ["il", "us"],
  );
  assert.equal(select.value, "il");
  assert.equal([...select.options][0].textContent, "Israel");
  assert.equal([...select.options][1].textContent, "United States");
  dom.window.close();
});

test("interests render as chips inside the field", async () => {
  const dom = boot();
  await settle();
  const field = dom.window.document.getElementById("tokenField")!;
  const chips = field.querySelectorAll(".tag");
  assert.equal(chips.length, 1);
  assert.match(chips[0].textContent ?? "", /platform engineering/);
  assert.ok(chips[0].querySelector("button"), "each chip needs a remove control");
  assert.ok(field.querySelector("input"), "the input stays inside the field");
  dom.window.close();
});

test("typing a comma turns the text into a chip immediately", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const posted: { interests: string[] }[] = [];
  let stored: string[] = [];
  dom.window.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/interests")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { interests: string[] };
      posted.push(body);
      stored = body.interests;
      return { ok: true, json: async () => ({ interests: stored }) } as unknown as Response;
    }
    const body = url.includes("/api/state")
      ? { ...baseState, interests: stored }
      : url.includes("/api/jobs")
        ? { jobs: [] }
        : { ok: true };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const input = dom.window.document.getElementById("interestInput") as HTMLInputElement;
  input.value = "developer tooling,";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await settle();

  assert.equal(posted.length, 1, "the comma alone submits");
  assert.deepEqual(posted[0].interests, ["developer tooling"]);
  assert.equal(input.value, "", "the committed text leaves the input");

  const chips = dom.window.document.querySelectorAll("#tokenField .tag");
  assert.equal(chips.length, 1);
  assert.match(chips[0].textContent ?? "", /developer tooling/);
  dom.window.close();
});

test("backspace on an empty field removes the last chip", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  let stored = ["platform engineering"];
  dom.window.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/interests")) {
      stored = (JSON.parse(String(init?.body ?? "{}")) as { interests: string[] }).interests;
      return { ok: true, json: async () => ({ interests: stored }) } as unknown as Response;
    }
    const body = url.includes("/api/state")
      ? { ...baseState, interests: stored }
      : url.includes("/api/jobs")
        ? { jobs: [] }
        : { ok: true };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const input = dom.window.document.getElementById("interestInput") as HTMLInputElement;
  input.value = "";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  await settle();

  assert.deepEqual(stored, []);
  assert.equal(dom.window.document.querySelectorAll("#tokenField .tag").length, 0);
  dom.window.close();
});

test("changing the minimum score reloads the matches", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const urls: string[] = [];
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    urls.push(url);
    const body = url.includes("/api/state") ? baseState : { jobs, total: jobs.length, postings: 1726 };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const field = dom.window.document.getElementById("filterMin") as HTMLInputElement;
  field.value = "90";
  field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();

  assert.ok(
    urls.some((u) => u.includes("/api/jobs") && u.includes("min=90")),
    "the new threshold must reach the API",
  );
  const hint = dom.window.document.getElementById("resultsHint")!.textContent ?? "";
  assert.equal(hint, "1 match");
  dom.window.close();
});

test("a minimum of zero is honoured rather than replaced with the default", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const urls: string[] = [];
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    urls.push(url);
    return { ok: true, json: async () => (url.includes("/api/state") ? baseState : { jobs }) } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const field = dom.window.document.getElementById("filterMin") as HTMLInputElement;
  field.value = "0";
  field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();

  assert.ok(urls.some((u) => u.includes("min=0")), "zero must be sent as zero");
  dom.window.close();
});

test("finishing a search refreshes the match list", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const urls: string[] = [];

  class FakeEventSource {
    static last: FakeEventSource | null = null;
    listeners: Record<string, ((e: { data: string }) => void)[]> = {};
    url: string;
    constructor(url: string) {
      this.url = url;
      FakeEventSource.last = this;
    }
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (this.listeners[type] ??= []).push(fn);
    }
    close() {}
    emit(type: string, payload: unknown) {
      for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(payload) });
    }
  }

  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    urls.push(url);
    return { ok: true, json: async () => (url.includes("/api/state") ? baseState : { jobs }) } as unknown as Response;
  }) as typeof fetch;
  dom.window.EventSource = FakeEventSource as unknown as typeof EventSource;
  dom.window.eval(script);
  await settle();

  const before = urls.filter((u) => u.includes("/api/jobs")).length;
  (dom.window.document.getElementById("search") as HTMLButtonElement).click();
  await settle();

  const source = FakeEventSource.last!;
  assert.ok(source, "search must open a stream");
  assert.match(source.url, /action=run/);

  source.emit("done", { code: 0, summary: { collected: 10, evaluated: 10, eligible: 2, scored: 2 } });
  await settle();

  const after = urls.filter((u) => u.includes("/api/jobs")).length;
  assert.ok(after > before, "the match list must be re-fetched when a search finishes");
  dom.window.close();
});

test("match cards render with score, company and actions", async () => {
  const dom = boot();
  await settle();
  const cards = dom.window.document.querySelectorAll(".job");
  assert.equal(cards.length, 1);
  const text = cards[0].textContent ?? "";
  assert.match(text, /84/);
  assert.match(text, /Via/);
  assert.match(text, /Mobile Team Lead/);
  assert.match(text, /Applied/);
  assert.match(text, /Skip/);
  dom.window.close();
});

test("labelling a job offers an undo, and undo restores it", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const calls: { url: string; body?: string }[] = [];
  dom.window.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? String(init.body) : undefined });
    const body = url.includes("/api/state") ? baseState : { jobs, total: jobs.length };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const skip = dom.window.document.querySelector(".job button.skipped") as HTMLButtonElement;
  skip.click();
  await settle();

  const toast = dom.window.document.querySelector(".toast");
  assert.ok(toast, "a confirmation with an undo must appear");
  assert.match(toast!.textContent ?? "", /Skipped/);
  assert.match(toast!.textContent ?? "", /Via/);

  const undo = toast!.querySelector("button") as HTMLButtonElement;
  undo.click();
  await settle();

  assert.ok(
    calls.some((c) => c.url.includes("/api/undo") && c.body?.includes("abc123")),
    "undo must reach the server with the job id",
  );
  assert.equal(dom.window.document.querySelector(".toast"), null, "the toast goes away");
  dom.window.close();
});

test("hidden jobs are listed with a restore control", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const calls: string[] = [];
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/api/state")
      ? baseState
      : url.includes("/api/decisions")
        ? {
            decisions: [
              { jobId: "abc123", label: "skipped", company: "Via", title: "Mobile Team Lead", at: "x" },
            ],
          }
        : { jobs, total: jobs.length };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const box = dom.window.document.getElementById("hiddenBox") as HTMLDetailsElement;
  assert.equal(box.hidden, false, "the section shows when something is hidden");
  assert.match(dom.window.document.getElementById("hiddenSummary")!.textContent ?? "", /1 hidden/);

  const row = dom.window.document.querySelector(".hidden-row")!;
  assert.match(row.textContent ?? "", /skipped/);
  assert.match(row.textContent ?? "", /Via/);

  (row.querySelector("button") as HTMLButtonElement).click();
  await settle();
  assert.ok(calls.some((u) => u.includes("/api/undo")), "restore must call the API");
  dom.window.close();
});

test("the hidden section is absent when nothing is hidden", async () => {
  const dom = boot();
  await settle();
  const box = dom.window.document.getElementById("hiddenBox") as HTMLDetailsElement;
  assert.equal(box.hidden, true);
  dom.window.close();
});

test("skipping a job updates the match count", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  let served = 1;
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/feedback")) {
      served = 0;
      return { ok: true, json: async () => ({ ok: true }) } as unknown as Response;
    }
    const body = url.includes("/api/state")
      ? baseState
      : url.includes("/api/decisions")
        ? { decisions: [] }
        : { jobs: served ? jobs : [], total: served };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();
  assert.equal(dom.window.document.getElementById("resultsHint")!.textContent, "1 match");

  (dom.window.document.querySelector(".job button.skipped") as HTMLButtonElement).click();
  await settle();
  await settle();

  assert.equal(
    dom.window.document.getElementById("resultsHint")!.textContent,
    "No matches at 65 or above",
    "the header must reflect the decision",
  );
  dom.window.close();
});

test("the apply link opens safely in a new tab", async () => {
  const dom = boot();
  await settle();
  const link = dom.window.document.querySelector(".job a.apply") as HTMLAnchorElement;
  assert.equal(link.href, "https://example.com/1");
  assert.equal(link.target, "_blank");
  assert.match(link.rel, /noopener/);
  dom.window.close();
});

test("job text is inserted as text, never parsed as markup", async () => {
  const hostile = [{ ...jobs[0], company: "<img src=x onerror=alert(1)>" }];
  const dom = boot({}, hostile);
  await settle();
  const card = dom.window.document.querySelector(".job");
  assert.ok(card, "a card should render");
  assert.equal(card!.querySelectorAll("img").length, 0, "untrusted text must not create elements");
  assert.match(card!.textContent ?? "", /<img src=x/);
  dom.window.close();
});

test("uploading a CV shows a spinner until it finishes", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  let release: (() => void) | null = null;
  dom.window.fetch = (async (input: string) => {
    const url = String(input);
    if (url.includes("/api/cv")) {
      await new Promise<void>((r) => (release = r));
      return { ok: true, json: async () => ({ profile: { years: 19, managementYears: 9 } }) } as unknown as Response;
    }
    const body = url.includes("/api/state") ? baseState : { jobs: [] };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const input = dom.window.document.getElementById("cv") as HTMLInputElement;
  const file = new dom.window.File(["cv"], "cv.pdf", { type: "application/pdf" });
  Object.defineProperty(input, "files", { value: [file] });
  input.dispatchEvent(new dom.window.Event("change"));
  await settle();

  const status = dom.window.document.getElementById("cvStatus")!;
  assert.ok(status.querySelector(".spinner"), "a spinner must show while uploading");
  assert.match(status.textContent ?? "", /cv\.pdf/);

  release?.();
  await settle();
  await settle();
  assert.equal(status.querySelector(".spinner"), null, "the spinner clears when done");
  dom.window.close();
});

test("the CV input accepts PDF, DOCX and Markdown, but not plain text", () => {
  const dom = track(new JSDOM(html));
  const input = dom.window.document.getElementById("cv") as HTMLInputElement;
  assert.equal(input.type, "file");
  assert.match(input.accept, /\.pdf/);
  assert.match(input.accept, /\.docx/);
  assert.match(input.accept, /\.md/);
  assert.ok(!input.accept.includes(".txt"), "txt is not accepted");
  dom.window.close();
});

test("a comma-separated phrase becomes several interest tags", async () => {
  const dom = track(new JSDOM(html, { url: "http://127.0.0.1:7788/", runScripts: "outside-only" }));
  const posted: unknown[] = [];
  dom.window.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/interests")) {
      posted.push(JSON.parse(String(init?.body ?? "{}")));
      return { ok: true, json: async () => ({ interests: [] }) } as unknown as Response;
    }
    const body = url.includes("/api/state")
      ? { ...baseState, interests: [] }
      : url.includes("/api/decisions")
        ? { decisions: [] }
        : url.includes("/api/jobs")
          ? { jobs: [] }
          : { ok: true };
    return { ok: true, json: async () => body } as unknown as Response;
  }) as typeof fetch;
  dom.window.eval(script);
  await settle();

  const input = dom.window.document.getElementById("interestInput") as HTMLInputElement;
  input.value = "platform engineering, developer tooling ,  devrel ";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();

  assert.equal(posted.length, 1, "one request for the whole list");
  assert.deepEqual((posted[0] as { interests: string[] }).interests, [
    "platform engineering",
    "developer tooling",
    "devrel",
  ]);
  dom.window.close();
});
