import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverFromList, sameCompany, slugCandidates } from "../src/engine/discover-list.ts";

const response = (data: unknown, status = 200): Response =>
  new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

test("slugs are derived from the name and its meaningful words", () => {
  const slugs = slugCandidates("Check Point Software Technologies Ltd");
  assert.ok(slugs.includes("checkpoint"), "legal and category words are stripped");
  assert.ok(!slugs.some((s) => s.includes("ltd")));
  assert.ok(slugs.length <= 4, "a handful of candidates, not a combinatorial explosion");
});

test("a company is only accepted when the board names it", () => {
  assert.equal(sameCompany("Wix", "Wix.com Ltd"), true);
  assert.equal(sameCompany("Melio", "Torq"), false);
  assert.equal(sameCompany("Acme", ""), false);
});

test("only verified boards with roles are returned", async () => {
  const fetchFn = (async (input: string) => {
    const url = String(input);
    if (url.includes("wikipedia.org")) {
      return response({
        query: { categorymembers: [{ title: "Acme" }, { title: "Beta" }, { title: "Gamma" }] },
      });
    }
    if (url.includes("boards-api.greenhouse.io/v1/boards/acme/jobs")) {
      return response({ jobs: [{}, {}] });
    }
    if (url.includes("boards-api.greenhouse.io/v1/boards/acme")) {
      return response({ name: "Acme Ltd" });
    }
    if (url.includes("api.ashbyhq.com") && url.includes("/gamma")) {
      return response({ jobs: [{}] });
    }
    if (url.includes("jobs.ashbyhq.com/gamma")) {
      return response("<html><title>Another Company Jobs</title></html>");
    }
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  const result = await discoverFromList({ fetchFn, categories: ["Category:Test"] });
  assert.equal(result.probed, 3);
  assert.equal(result.hits.length, 1);
  assert.deepEqual(result.hits[0], {
    name: "Acme Ltd",
    source: "greenhouse",
    ident: "acme",
    openRoles: 2,
  });
});

test("companies already in the directory are not probed again", async () => {
  let probes = 0;
  const fetchFn = (async (input: string) => {
    const url = String(input);
    if (url.includes("wikipedia.org")) {
      return response({ query: { categorymembers: [{ title: "Acme" }, { title: "Beta" }] } });
    }
    probes++;
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  const result = await discoverFromList({
    fetchFn,
    categories: ["Category:Test"],
    known: new Set(["acme"]),
  });
  assert.equal(result.probed, 1);
  assert.equal(result.names, 2, "the list still reports its size");
  assert.ok(probes > 0);
});

test("the limit caps how many companies are checked", async () => {
  const fetchFn = (async (input: string) => {
    const url = String(input);
    if (url.includes("wikipedia.org")) {
      return response({
        query: { categorymembers: [{ title: "A" }, { title: "B" }, { title: "C" }] },
      });
    }
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  const result = await discoverFromList({ fetchFn, categories: ["Category:Test"], limit: 2 });
  assert.equal(result.probed, 2);
});

test("a failing probe is reported, not fatal", async () => {
  const fetchFn = (async (input: string) => {
    const url = String(input);
    if (url.includes("wikipedia.org")) {
      return response({ query: { categorymembers: [{ title: "Acme" }] } });
    }
    if (url.includes("boards-api.greenhouse.io/v1/boards/acme")) {
      return response({ name: "Acme" });
    }
    if (url.includes("jobs?content=false")) throw new Error("socket hang up");
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  const result = await discoverFromList({ fetchFn, categories: ["Category:Test"] });
  assert.equal(result.hits.length, 0);
});

test("a refused list is reported instead of looking empty", async () => {
  const fetchFn = (async (input: string) => {
    if (String(input).includes("wikipedia.org")) return response({}, 429);
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  const result = await discoverFromList({
    fetchFn,
    categories: ["Category:One", "Category:Two"],
  });
  assert.equal(result.names, 0);
  assert.equal(result.probed, 0);
  assert.equal(result.errors.length, 2, "one error per refused category");
  assert.match(result.errors[0].message, /429/);
});

test("the list request identifies itself", async () => {
  const seen: Record<string, string> = {};
  const fetchFn = (async (input: string, init?: RequestInit) => {
    if (String(input).includes("wikipedia.org")) {
      Object.assign(seen, init?.headers ?? {});
      return response({ query: { categorymembers: [] } });
    }
    return response({ status: 404 }, 404);
  }) as unknown as typeof fetch;

  await discoverFromList({ fetchFn, categories: ["Category:One"] });
  assert.match(String(seen["user-agent"] ?? ""), /JobPilot/);
});
