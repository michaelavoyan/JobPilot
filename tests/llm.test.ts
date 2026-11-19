import { test } from "node:test";
import assert from "node:assert/strict";
import { provider, requireModel } from "../src/score/llm.ts";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "LLM_MODEL",
] as const;

function withEnv(vars: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const key of KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("no key means no provider", () => {
  withEnv({}, () => assert.equal(provider(), null));
});

test("a DeepSeek key alone selects DeepSeek", () => {
  withEnv({ DEEPSEEK_API_KEY: "sk-test" }, () => assert.equal(provider(), "deepseek"));
});

test("an OpenAI key alone selects OpenAI", () => {
  withEnv({ OPENAI_API_KEY: "sk-test" }, () => assert.equal(provider(), "openai"));
});

test("Anthropic wins when several keys are present", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "a", DEEPSEEK_API_KEY: "d", OPENAI_API_KEY: "o" },
    () => assert.equal(provider(), "anthropic"),
  );
});

test("DeepSeek is preferred over OpenAI", () => {
  withEnv(
    { DEEPSEEK_API_KEY: "d", OPENAI_API_KEY: "o" },
    () => assert.equal(provider(), "deepseek"),
  );
});

test("an OpenCode key alone selects OpenCode Go", () => {
  withEnv({ OPENCODE_API_KEY: "oc" }, () => assert.equal(provider(), "opencode"));
});

test("OpenCode is preferred over DeepSeek and OpenAI", () => {
  withEnv(
    { OPENCODE_API_KEY: "oc", DEEPSEEK_API_KEY: "d", OPENAI_API_KEY: "o" },
    () => assert.equal(provider(), "opencode"),
  );
});

test("Anthropic still wins over OpenCode", () => {
  withEnv(
    { ANTHROPIC_API_KEY: "a", OPENCODE_API_KEY: "oc" },
    () => assert.equal(provider(), "anthropic"),
  );
});

test("an empty key is treated as absent", () => {
  withEnv({ DEEPSEEK_API_KEY: "" }, () => assert.equal(provider(), null));
});

test("requireModel refuses to guess a model id", () => {
  withEnv({}, () => assert.throws(() => requireModel(), /LLM_MODEL is not set/));
});

test("requireModel returns the configured id", () => {
  withEnv({ LLM_MODEL: "deepseek-chat" }, () => assert.equal(requireModel(), "deepseek-chat"));
});
