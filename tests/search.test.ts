import { test } from "node:test";
import assert from "node:assert/strict";
import { search, searchConfigured } from "../src/engine/discovery.ts";

const KEYS = ["SERPER_API_KEY", "BRAVE_API_KEY", "GOOGLE_API_KEY", "GOOGLE_CSE_ID"] as const;

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("a Serper key is enough to enable discovery", async () => {
  await withEnv({ SERPER_API_KEY: "sk-test" }, async () => {
    assert.equal(searchConfigured(), true);
  });
});

test("Serper is queried with a POST and the key in a header", async (t) => {
  let seen: { url: string; method?: string; headers?: Record<string, string>; body?: string } =
    { url: "" };

  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    seen = {
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: String(init?.body ?? ""),
    };
    return new Response(
      JSON.stringify({
        organic: [
          { link: "https://boards.greenhouse.io/acme" },
          { link: "https://jobs.lever.co/beta" },
          { title: "no link" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  await withEnv({ SERPER_API_KEY: "sk-test" }, async () => {
    const urls = await search('site:boards.greenhouse.io "Tel Aviv"');
    assert.deepEqual(urls, ["https://boards.greenhouse.io/acme", "https://jobs.lever.co/beta"]);
  });

  assert.match(seen.url, /google\.serper\.dev\/search/);
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers?.["x-api-key"], "sk-test");
  assert.match(String(seen.body), /boards\.greenhouse\.io/);
});

test("a refused search is an error, not an empty result", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("quota", { status: 429 }),
  );

  await withEnv({ SERPER_API_KEY: "sk-test" }, async () => {
    await assert.rejects(() => search("anything"), /serper HTTP 429/);
  });
});
