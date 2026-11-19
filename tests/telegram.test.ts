import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pushTelegram } from "../src/deliver/telegram.ts";
import type { ScoredJob } from "../src/types.ts";

function job(over: Partial<ScoredJob> = {}): ScoredJob {
  return {
    id: "j1",
    source: "test",
    company: "Acme",
    title: "Mobile Team Lead",
    url: "https://example.com/1",
    locations: ["Tel Aviv"],
    remote: false,
    description: "x",
    lang: "en",
    country: "IL",
    track: "b_senior_em",
    score: 84,
    reasons: ["fits"],
    flags: [],
    ...over,
  };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const keys = Object.keys(vars);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const k of keys) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("pushTelegram is a no-op without credentials", async () => {
  await withEnv({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_CHAT_ID: undefined }, async () => {
    assert.equal(await pushTelegram([job()]), false);
  });
});

test("pushTelegram posts the digest to the Telegram API", async () => {
  let received: { path: string; body: string } | null = null;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received = { path: req.url ?? "", body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123:abc",
        TELEGRAM_CHAT_ID: "42",
        TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
      },
      async () => {
        const ok = await pushTelegram([job()], 5);
        assert.equal(ok, true);
      },
    );

    assert.ok(received, "the stub must have been called");
    assert.equal(received!.path, "/bot123:abc/sendMessage");
    const payload = JSON.parse(received!.body) as Record<string, unknown>;
    assert.equal(payload.chat_id, "42");
    assert.equal(payload.parse_mode, "HTML");
    assert.match(String(payload.text), /Acme/);
    assert.match(String(payload.text), /84/);
  } finally {
    server.close();
  }
});

test("pushTelegram reports failure instead of throwing", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("nope");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "123:abc",
        TELEGRAM_CHAT_ID: "42",
        TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
      },
      async () => {
        assert.equal(await pushTelegram([job()]), false);
      },
    );
  } finally {
    server.close();
  }
});

test("pushTelegram escapes HTML in titles", async () => {
  let body = "";
  const server = createServer((req, res) => {
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  try {
    await withEnv(
      {
        TELEGRAM_BOT_TOKEN: "t",
        TELEGRAM_CHAT_ID: "1",
        TELEGRAM_API_BASE: `http://127.0.0.1:${port}`,
      },
      async () => {
        await pushTelegram([job({ title: "Lead <script> & co" })]);
      },
    );
    assert.ok(body.includes("&lt;script&gt;"), "angle brackets must be escaped");
    assert.ok(!body.includes("<script>"));
  } finally {
    server.close();
  }
});
