# JobPilot

**Find the jobs worth your time.**

---

JobPilot reads your CV, looks at every job open in your country, and hands you a short list.

Each one is scored, explained in a sentence, and ready to apply to.

No searching. No scrolling. No LinkedIn.

---

## What it does

**Reads your CV** — your level, your skills, your background.

**Sorts the market** — it discards the wrong level, the wrong place, and anything you cannot take.

**Scores what is left** — out of 100, with a reason you can read.

---

## Getting started

1. **Open JobPilot.**
2. **Add your AI key** — asked once, when you first start.
3. **Drop your CV** — PDF or Word.
4. **Choose your country.**
5. **Press Find jobs.**

That is the whole setup.

---

## After you decide

| | |
|---|---|
| **Apply** | Opens the job. Nothing is saved. |
| **✓ Applied** | Saves it and clears it from the list. |
| **✕ Skip** | Hides it for good. |

Changed your mind? Press **Undo**, or open **hidden** below the list and bring any job back.

---

## Private by default

Your CV, your jobs and your decisions stay on your own computer.

The only thing that leaves is the job text sent to the AI that scores it.

---

## What it will not do

It will not apply for you. It will not use LinkedIn. It will not send your data anywhere else.

---

## For contributors

The code is four packages — `ui`, `server`, `engine`, `storage` — with the rules
written down in [`AGENTS.md`](./AGENTS.md) and enforced by `npm test`.

| Read | For |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | the package rules, and where new code goes |
| [`docs/ENGINE.md`](./docs/ENGINE.md) | diagrams: a run, discovery, the profile path |
| [`docs/SERVER.md`](./docs/SERVER.md) | diagrams: routes and the live run stream |
| [`docs/STORAGE.md`](./docs/STORAGE.md) | diagrams: the schema and its two key queries |
| [`docs/DECISIONS.md`](./docs/DECISIONS.md) | why it is built this way, and what would reverse it |

`npm test` type-checks and runs the suite; `npm run typecheck` runs only the
compiler.
