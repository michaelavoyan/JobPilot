import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function importsOf(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/from\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("."))
    .map((spec) => relative(SRC, resolve(join(path, ".."), spec)).split("\\").join("/"));
}

const sources = files(SRC).filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"));
const pkg = (path: string): string => {
  const rel = relative(SRC, path);
  if (rel === "cli.ts") return "cli";
  return rel.split("/")[0];
};

test("the source is split into the four packages plus the entry point", () => {
  const top = readdirSync(SRC).filter((entry) => statSync(join(SRC, entry)).isDirectory());
  assert.deepEqual(top.sort(), ["engine", "server", "storage", "ui"]);
  assert.ok(statSync(join(SRC, "cli.ts")).isFile(), "cli.ts sits at the root of src/");
});

test("ui holds only browser files", () => {
  const ui = files(join(SRC, "ui"));
  for (const file of ui) {
    assert.match(file, /\.(html|css|js)$/, `${relative(ROOT, file)} is not a browser file`);
  }
  assert.deepEqual(
    ui.map((f) => relative(join(SRC, "ui"), f)).sort(),
    ["app.js", "index.html", "style.css"],
  );
});

test("storage never imports behaviour", () => {
  const allowed = new Set(["engine/types.ts", "engine/util.ts", "storage/db.ts"]);
  for (const file of sources.filter((p) => pkg(p) === "storage")) {
    for (const spec of importsOf(file)) {
      assert.ok(
        allowed.has(spec),
        `${relative(ROOT, file)} imports ${spec}; storage may only use types and util`,
      );
    }
  }
});

test("engine never reaches the server or the page", () => {
  for (const file of sources.filter((p) => pkg(p) === "engine")) {
    for (const spec of importsOf(file)) {
      assert.ok(
        !spec.startsWith("server/") && !spec.startsWith("ui/"),
        `${relative(ROOT, file)} imports ${spec}`,
      );
    }
  }
});

test("the page contains no TypeScript", () => {
  assert.equal(files(join(SRC, "ui")).filter((f) => f.endsWith(".ts")).length, 0);
});

test("only the entry points import the server", () => {
  for (const file of sources) {
    if (pkg(file) === "cli" || pkg(file) === "server") continue;
    for (const spec of importsOf(file)) {
      assert.ok(!spec.startsWith("server/"), `${relative(ROOT, file)} imports ${spec}`);
    }
  }
});

test("tests mirror the source packages", () => {
  const names = readdirSync(join(ROOT, "tests")).filter((f) => f.endsWith(".test.ts"));
  assert.ok(names.includes("ui.test.ts"), "the page has its tests");
  assert.ok(names.includes("api.test.ts"), "the api has its tests");
  assert.ok(names.includes("structure.test.ts"), "the rules are enforced");
});
