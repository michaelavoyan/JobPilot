import { test } from "node:test";
import assert from "node:assert/strict";
import { LABEL, renderPlist, plistPath } from "../src/engine/schedule.ts";

const opts = {
  nodePath: "/usr/local/bin/node",
  cliPath: "/repo/src/cli.ts",
  command: "agent",
  workDir: "/repo",
  logPath: "/home/u/Library/Logs/jobpilot.log",
  errorLogPath: "/home/u/Library/Logs/jobpilot.err.log",
  hour: 7,
  minute: 30,
};

test("plist carries the label, command and working directory", () => {
  const xml = renderPlist(opts);
  assert.ok(xml.includes(`<string>${LABEL}</string>`));
  assert.ok(xml.includes("<string>/usr/local/bin/node</string>"));
  assert.ok(xml.includes("<string>/repo/src/cli.ts</string>"));
  assert.ok(xml.includes("<string>agent</string>"), "the daily job decides, not just runs");
  assert.ok(xml.includes("<string>/repo</string>"));
});

test("plist sets the requested time", () => {
  const xml = renderPlist({ ...opts, hour: 6, minute: 5 });
  assert.ok(xml.includes("<key>Hour</key>\n    <integer>6</integer>"));
  assert.ok(xml.includes("<key>Minute</key>\n    <integer>5</integer>"));
});

test("plist does not run at load", () => {
  assert.ok(renderPlist(opts).includes("<key>RunAtLoad</key>\n  <false/>"));
});

test("plist is well-formed enough to parse", () => {
  const xml = renderPlist(opts);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.trimEnd().endsWith("</plist>"));
  // Every <key> must be followed by a value element.
  const keys = (xml.match(/<key>/g) ?? []).length;
  const values = (xml.match(/<(string|integer|dict|array|false|true)>/g) ?? []).length;
  assert.ok(values >= keys, "each key needs a value");
});

test("plist lives in the user LaunchAgents directory", () => {
  assert.equal(plistPath("/home/u"), "/home/u/Library/LaunchAgents/ai.jobpilot.daily.plist");
});
