const $ = (id) => document.getElementById(id);
const state = { running: false, markets: [], interests: [] };

/* ---------- helpers ---------- */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(id, text, kind) {
  const node = $(id);
  node.textContent = text ?? "";
  node.className = "note" + (kind ? " " + kind : "");
}

function spinner() {
  const node = document.createElement("span");
  node.className = "spinner";
  return node;
}

/** A note that keeps its spinner while the text updates underneath. */
function noteBusy(id, text) {
  const node = $(id);
  node.className = "note";
  let label = node.querySelector(".note-text");
  if (!label) {
    node.textContent = "";
    label = el("span", "note-text");
    node.append(spinner(), label);
  }
  label.textContent = " " + text;
}

/** Locks the whole form while work is in flight, so nothing can be double-sent. */
function lockControls(locked) {
  for (const id of ["cv", "market", "interestInput"]) {
    $(id).disabled = locked;
  }
  $("search").disabled = locked || !state.hasProfile;
  $("drop").classList.toggle("busy", locked);
}

/* ---------- state ---------- */

async function loadState() {
  try {
    const s = await (await fetch("/api/state")).json();
    state.boards = s.boards ?? 0;
    renderPills(s);
    renderProfile(s);
    renderCompanies(s);
    renderField(s);
    renderMarkets(s);
    renderInterests(s.interests ?? []);
    return s;
  } catch {
    $("subtitle").textContent = "server unreachable";
    return null;
  }
}

function renderPills(s) {
  const pills = $("pills");
  pills.textContent = "";

  // Nothing to say when everything works. A pill only appears when the user
  // has to do something.
  if (!s.llm.configured) {
    const warn = el("span", "pill bad");
    warn.appendChild(el("b", "", "Scoring is off"));
    warn.appendChild(document.createTextNode(" — add an API key to .env"));
    pills.appendChild(warn);
  }

}

function renderProfile(s) {
  const search = $("search");
  state.hasProfile = Boolean(s.profile);
  if (!s.profile) {
    $("subtitle").textContent = "add your CV to begin";
    $("dropTitle").textContent = "Drop your CV here, or click to choose";
    $("drop").classList.remove("done");
    note("cvStatus", "");
    search.disabled = true;
    return;
  }
  const p = s.profile;
  const file = p.cvFile ?? "";
  $("subtitle").textContent = file ? `CV: ${file}` : "CV loaded";
  $("dropTitle").textContent = file || "CV loaded";
  $("drop").classList.add("done");
  note(
    "cvStatus",
    `${p.years} years experience · ${p.managementYears} in management · ${p.stack} technologies`,
  );
  search.disabled = Boolean(s.running);
}

function renderCompanies(s) {
  const boards = s.boards ?? 0;
  const url = $("companyUrl");
  const add = $("addCompany");
  const bulk = $("findCompanies");

  // Bulk discovery needs a search provider; the single-URL path never does.
  bulk.hidden = !(s.discovery?.configured ?? false);

  if (boards > 0) {
    note("companiesNote", `${boards} companies`);
    return;
  }
  // The one state a user cannot diagnose alone: nothing to search.
  note(
    "companiesNote",
    "No companies yet. Add a careers page URL, or the search will only read the global remote feed.",
    "warn",
  );
}

function renderField(s) {
  const select = $("field");
  const options = s.fields ?? [];
  if (select.dataset.filled !== options.map((f) => f.id).join(",")) {
    select.textContent = "";
    for (const option of options) select.appendChild(new Option(option.label, option.id));
    select.dataset.filled = options.map((f) => f.id).join(",");
  }
  if (s.profile?.field) select.value = s.profile.field;
  // One choice today: it is a statement of scope, not a decision to make.
  select.disabled = options.length <= 1;
}

function renderMarkets(s) {
  const select = $("market");
  const wanted = (s.market?.country ?? "").toLowerCase();
  if (select.dataset.filled !== (s.markets ?? []).join(",")) {
    select.textContent = "";
    for (const code of s.markets ?? []) {
      const label = code === "il" ? "Israel" : code === "us" ? "United States" : code.toUpperCase();
      select.appendChild(new Option(label, code));
    }
    select.dataset.filled = (s.markets ?? []).join(",");
  }
  if (wanted) select.value = wanted;
  note("marketStatus", s.market ? `${s.market.currency} · salaries per ${s.market.period}` : "");
}

function renderInterests(items) {
  state.interests = items;
  const field = $("tokenField");
  for (const chip of field.querySelectorAll(".tag")) chip.remove();
  for (const item of items) {
    const tag = el("span", "tag", item);
    const remove = el("button", "", "×");
    remove.title = "Remove";
    remove.addEventListener("click", () => saveInterests(items.filter((i) => i !== item)));
    tag.appendChild(remove);
    field.insertBefore(tag, $("interestInput"));
  }
}

/* ---------- CV upload ---------- */

async function uploadCv(file) {
  if (!file) return;
  lockControls(true);
  $("dropTitle").textContent = "Reading your CV…";
  noteBusy("cvStatus", file.name);
  try {
    const res = await fetch("/api/cv?name=" + encodeURIComponent(file.name), {
      method: "POST",
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      note("cvStatus", data.error ?? "could not read that file", "bad");
      return;
    }
    await loadState();
    note(
      "cvStatus",
      `CV read · ${data.profile?.years ?? "?"} years, ${data.profile?.managementYears ?? "?"} in management`,
    );
  } catch {
    note("cvStatus", "could not reach the server", "bad");
  } finally {
    lockControls(false);
    $("dropTitle").textContent = $("subtitle").textContent.startsWith("CV:")
      ? $("subtitle").textContent.slice(4)
      : "Drop your CV here, or click to choose";
  }
}

$("cv").addEventListener("change", (e) => uploadCv(e.target.files[0]));

const drop = $("drop");
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const type of ["dragleave", "drop"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.remove("over");
  });
}
drop.addEventListener("drop", (e) => uploadCv(e.dataTransfer.files[0]));

/* ---------- country ---------- */

$("field").addEventListener("change", async (e) => {
  const res = await fetch("/api/field", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ field: e.target.value }),
  });
  if (!res.ok) note("marketStatus", "could not save the field", "bad");
  loadState();
});

$("market").addEventListener("change", async (e) => {
  const code = e.target.value;
  note("marketStatus", "Switching…");
  const res = await fetch("/api/market", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ market: code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) note("marketStatus", data.error ?? "could not switch market", "bad");
  await loadState();
});

/* ---------- interests ---------- */

async function saveInterests(items) {
  const res = await fetch("/api/interests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ interests: items }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    note("cvStatus", data.error ?? "could not save interests", "bad");
    return;
  }
  renderInterests(data.interests ?? []);
}

/** A comma-separated phrase becomes several tags: "a, b, c" -> three entries. */
function addInterests(raw) {
  const parts = String(raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!parts.length) return;
  const next = [...state.interests];
  for (const part of parts) {
    if (next.length >= 8) break;
    if (next.some((item) => item.toLowerCase() === part.toLowerCase())) continue;
    next.push(part.slice(0, 60));
  }
  if (next.length !== state.interests.length) saveInterests(next);
}

const interestInput = $("interestInput");

// Committing on the comma is what makes this feel like an address field: the
// text becomes a chip the moment it is unambiguous, without a separate submit.
interestInput.addEventListener("input", () => {
  const value = interestInput.value;
  const comma = value.lastIndexOf(",");
  if (comma === -1) return;
  const complete = value.slice(0, comma);
  interestInput.value = value.slice(comma + 1).trim();
  if (complete.trim()) addInterests(complete);
});

interestInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addInterests(interestInput.value);
    interestInput.value = "";
  }
  if (e.key === "Backspace" && !interestInput.value && state.interests.length) {
    saveInterests(state.interests.slice(0, -1));
  }
});

interestInput.addEventListener("blur", () => {
  if (interestInput.value.trim()) {
    addInterests(interestInput.value);
    interestInput.value = "";
  }
});

/* ---------- search ---------- */

function setRunning(running) {
  state.running = running;
  lockControls(running);
  $("search").disabled = running || !state.hasProfile;
  $("search").textContent = "";
  if (running) $("search").append(spinner(), document.createTextNode("Searching…"));
  else $("search").textContent = "Find jobs";
}

function streamRun(url, startLabel, onDone) {
  if (state.running) return;
  setRunning(true);
  noteBusy("searchStatus", startLabel);

  const es = new EventSource(url);
  let finished = false;

  es.addEventListener("log", (event) => {
    const { text } = JSON.parse(event.data);
    const last = text.trim().split("\n").filter(Boolean).pop();
    if (last) noteBusy("searchStatus", last.replace(/^\s*/, ""));
  });

  es.addEventListener("done", (event) => {
    finished = true;
    es.close();
    setRunning(false);
    onDone(JSON.parse(event.data));
    loadState();
    loadJobs();
  });

  es.onerror = () => {
    if (finished) return;
    es.close();
    setRunning(false);
    note("searchStatus", "Connection lost — try again.", "bad");
  };
}

function search() {
  streamRun("/api/run?action=run", "Collecting postings…", ({ code, summary }) => {
    note(
      "searchStatus",
      code === 0 ? describeRun(summary) : "Finished with errors — see runs/ for the log.",
      code === 0 ? "" : "bad",
    );
  });
}

function findCompanies() {
  streamRun(
    "/api/run?action=discover-web&bands=1-20,21-100,101-500",
    "Looking for companies…",
    ({ code }) => {
      note(
        "searchStatus",
        code === 0 ? "Companies updated." : "Discovery stopped — check the search key in .env.",
        code === 0 ? "" : "bad",
      );
    },
  );
}

async function addCompany() {
  const url = $("companyUrl").value.trim();
  if (!url) return;
  $("addCompany").disabled = true;
  note("companiesNote", "Checking that board…");
  const res = await fetch("/api/discover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await res.json().catch(() => ({}));
  $("addCompany").disabled = false;
  if (!res.ok) {
    note("companiesNote", data.error ?? "could not add that URL", "bad");
    return;
  }
  $("companyUrl").value = "";
  await loadState();
  loadJobs();
}

$("search").addEventListener("click", search);
$("addCompany").addEventListener("click", addCompany);
$("findCompanies").addEventListener("click", findCompanies);
$("companyUrl").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addCompany();
});

/** The funnel, in one line: what was fetched, filtered, scored, skipped. */
function describeRun(summary) {
  if (!summary) return "Done. Your matches are on the right.";
  const parts = [];
  if (summary.collected) parts.push(`${summary.collected} collected`);
  if (summary.evaluated) parts.push(`${summary.evaluated} checked`);
  if (summary.eligible != null) parts.push(`${summary.eligible} passed the filters`);
  if (summary.scored != null) parts.push(`${summary.scored} scored`);
  return parts.length ? parts.join(" · ") : "Done. Your matches are on the right.";
}

/* ---------- results ---------- */

/** 0 is a valid threshold, so `|| 65` was wrong: it silently ignored it. */
function currentMin() {
  const value = Number($("filterMin").value);
  if (!Number.isFinite(value)) return 65;
  return Math.min(100, Math.max(0, Math.round(value)));
}

async function loadJobs() {
  const min = currentMin();
  const { jobs, total } = await (await fetch(`/api/jobs?min=${min}&limit=500`)).json();
  const list = $("jobs");
  list.textContent = "";

  const matches = typeof total === "number" ? total : jobs.length;

  // Only postings that survived the filters and were scored exist here, so the
  // count is the search result — not the size of the database.
  const boards = state.boards ?? 0;
  if (matches) {
    $("resultsHint").textContent = `${matches.toLocaleString("en-US")} match${matches === 1 ? "" : "es"}`;
  } else if (boards === 0) {
    $("resultsHint").textContent =
      "No companies yet — add a careers page URL above, then search again.";
  } else {
    $("resultsHint").textContent = `No matches at ${min} or above`;
  }

  for (const job of jobs) list.appendChild(renderJob(job));
  loadLearning();
}

function renderJob(job) {
  const card = el("article", "job");
  const top = el("div", "job-top");
  top.appendChild(el("div", "score" + (job.score < 80 ? " mid" : ""), String(job.score)));

  const head = el("div");
  head.appendChild(el("div", "job-title", job.title));
  const where = job.remote ? "Remote" : (job.locations || []).join(", ") || "location n/a";
  head.appendChild(el("div", "job-meta", `${job.company} · ${where}`));
  top.appendChild(head);
  card.appendChild(top);

  if (job.reasons?.length) card.appendChild(el("div", "reasons", job.reasons.join(" · ")));
  if (job.flags?.length) {
    const flags = el("div", "flags");
    // Flags arrive as machine tokens; the page shows words.
    for (const f of job.flags) flags.appendChild(el("span", "flag", f.replace(/_/g, " ")));
    card.appendChild(flags);
  }

  const actions = el("div", "job-actions");
  if (job.url) {
    const link = el("a", "ghost apply", "Apply ↗");
    link.href = job.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    actions.appendChild(link);
  }
  const applied = el("button", "ghost applied", "✓ Applied");
  applied.addEventListener("click", () => feedback(job, "applied", card));
  actions.appendChild(applied);
  const skipped = el("button", "ghost skipped", "✕ Skip");
  skipped.addEventListener("click", () => feedback(job, "skipped", card));
  actions.appendChild(skipped);
  card.appendChild(actions);
  return card;
}

async function feedback(job, label, card) {
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: job.id, label }),
  });
  if (!res.ok) return;

  card.style.opacity = "0.35";
  setTimeout(() => card.remove(), 220);

  // The header counts matches from the server, so the list has to be re-read
  // after a decision or the number goes stale.
  loadJobs();
  loadState();
  loadHidden();
  offerUndo(job, label);
}

/** A decision hides the posting for good, so it must be reversible. */
function offerUndo(job, label) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const bar = el("div", "toast");
  bar.appendChild(
    el("span", "", `${label === "applied" ? "Applied" : "Skipped"} · ${job.company} — ${job.title}`),
  );

  const undo = el("button", "", "Undo");
  undo.addEventListener("click", async () => {
    bar.remove();
    await fetch("/api/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.id }),
    });
    loadState();
    loadJobs();
    loadHidden();
  });
  bar.appendChild(undo);

  // A skip is the moment the reason is known. It is optional, and a note only
  // ever proposes a rule — it changes nothing until it is confirmed.
  let noteInput;
  if (label === "skipped") {
    noteInput = el("input", "toast-note");
    noteInput.type = "text";
    noteInput.placeholder = "Why? e.g. too far — optional";
    noteInput.setAttribute("aria-label", "Why you skipped this job");
    bar.appendChild(noteInput);

    const save = async () => {
      const note = noteInput.value.trim();
      bar.remove();
      if (!note) return;
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id, label, note }),
      });
      loadLearning();
    };

    const keep = el("button", "", "Save note");
    keep.addEventListener("click", save);
    bar.appendChild(keep);
    noteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
  }

  document.body.appendChild(bar);
  if (noteInput) noteInput.focus();

  setTimeout(() => bar.remove(), noteInput ? 25_000 : 7_000);
}

/* ---------- learning ---------- */

function percent(value) {
  return Math.round(value * 100) + "%";
}

function medianText(tracks, key) {
  const known = tracks.filter((t) => typeof t[key] === "number");
  if (!known.length) return null;
  const total = known.reduce((sum, t) => sum + t[key] * (t.applied + t.skipped), 0);
  const weight = known.reduce((sum, t) => sum + t.applied + t.skipped, 0);
  return Math.round(total / weight);
}

async function loadLearning() {
  let data;
  try {
    const res = await fetch("/api/learning");
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }

  const section = $("learning");
  const constraints = data.constraints || [];
  const proposed = constraints.filter((c) => c.status === "proposed");
  const confirmed = constraints.filter((c) => c.status === "confirmed");
  const labelled = (data.applied || 0) + (data.skipped || 0);
  if (!labelled && !proposed.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  $("learningSummary").textContent =
    `${data.applied} applied · ${data.skipped} skipped`;

  const appliedMedian = medianText(data.tracks || [], "appliedMedian");
  const skippedMedian = medianText(data.tracks || [], "skippedMedian");

  const evidence = [];
  // Two decisions produce two medians; they are not a bar. The thresholds are
  // the same ones the CLI uses before it prints anything.
  if (data.enoughLabels && appliedMedian !== null && skippedMedian !== null) {
    evidence.push(
      `Your applications score around ${appliedMedian}; the ones you skip around ${skippedMedian}.`,
    );
    if (data.suggestedMinScore !== null) {
      evidence.push(`Your own decisions put the bar at about ${data.suggestedMinScore}.`);
    }
  } else {
    evidence.push("Not enough decisions yet to tell where your bar sits.");
  }

  const prefs = data.preferences || [];
  if (prefs.length) {
    evidence.push("Roles you accept mention " + prefs.map((p) => p.term).join(", ") + " more often.");
  }

  $("learningEvidence").textContent = evidence.join(" ");
  if (data.enoughLabels && data.suggestedMinScore !== null && appliedMedian !== null) {
    const use = el("button", "ghost threshold-button", "Use it");
    use.addEventListener("click", () => {
      $("filterMin").value = String(data.suggestedMinScore);
      loadJobs();
    });
    $("learningEvidence").appendChild(use);
  }

  if (data.shadow) {
    const s2 = data.shadow;
    const parts = [];
    if (s2.precision) {
      parts.push(
        `Of your top ${s2.precision.k} labelled postings, ${percent(s2.precision.learned)} were ones you applied to` +
          ` (${percent(s2.precision.baseline)} without learning).`,
      );
    }
    if (s2.aucLearned !== null) {
      parts.push(
        `Applied jobs outrank skipped ones ${percent(s2.aucLearned)} of the time` +
          (s2.interval ? ` (95% range ${percent(s2.interval.low)}–${percent(s2.interval.high)})` : "") +
          (s2.aucBaseline !== null ? `, without learning ${percent(s2.aucBaseline)}` : ""),
      );
      if (s2.interval && s2.interval.low <= 0.5) {
        parts.push("too early to call that an improvement.");
      }
    } else {
      parts.push("Scored both ways, but not enough labelled pairs to compare yet.");
    }
    $("learningComparison").textContent = parts.join(" — ");
  } else {
    $("learningComparison").textContent = "";
  }

  const box = $("constraints");
  box.textContent = "";

  const save = async (id, status) => {
    await fetch("/api/learning/constraint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, status }),
    });
    loadLearning();
  };

  for (const c of proposed) {
    const row = el("div", "constraint");
    const text = el("div", "constraint-text");
    text.appendChild(el("div", "", c.text));
    text.appendChild(el("div", "constraint-note", `your note: \u201c${c.note}\u201d`));
    row.appendChild(text);

    for (const [status, label] of [["confirmed", "Keep"], ["rejected", "Ignore"]]) {
      const button = el("button", "ghost", label);
      button.addEventListener("click", () => save(c.id, status));
      row.appendChild(button);
    }
    box.appendChild(row);
  }

  // Confirmed constraints change how jobs are scored, so they stay visible and
  // removable — a wrong inference must never be permanent.
  for (const c of confirmed) {
    const row = el("div", "constraint");
    const text = el("div", "constraint-text");
    text.appendChild(el("div", "", c.text));
    text.appendChild(el("div", "constraint-note", `your note: \u201c${c.note}\u201d`));
    row.appendChild(text);

    const remove = el("button", "ghost", "Remove");
    remove.addEventListener("click", () => save(c.id, "rejected"));
    row.appendChild(remove);
    box.appendChild(row);
  }
}

$("refresh").addEventListener("click", loadJobs);
$("filterMin").addEventListener("change", loadJobs);

/** Every posting the user has labelled, with a way back. */
async function loadHidden() {
  try {
    const { decisions } = await (await fetch("/api/decisions")).json();
    const box = $("hiddenBox");
    const list = $("hiddenList");

    $("hiddenSummary").textContent = `${decisions.length} hidden`;
    box.hidden = decisions.length === 0;
    list.textContent = "";

    for (const entry of decisions) {
      const row = el("div", "hidden-row");
      row.appendChild(el("span", "hidden-stage", entry.label));
      row.appendChild(
        el("span", "hidden-title", `${entry.company || "—"} — ${entry.title || entry.jobId}`),
      );

      const restore = el("button", "ghost", "Restore");
      restore.addEventListener("click", async () => {
        await fetch("/api/undo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId: entry.jobId }),
        });
        loadHidden();
        loadJobs();
        loadState();
      });
      row.appendChild(restore);
      list.appendChild(row);
    }
  } catch {
    /* the list is a convenience; a failure must not break the page */
  }
}

/* ---------- boot ---------- */

loadState().then(() => {
  loadJobs();
  loadHidden();
});
setInterval(loadState, 20_000);
