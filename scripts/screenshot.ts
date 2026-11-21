/**
 * Renders the real UI and writes docs/screenshot.png.
 *
 * Needs a populated config/ and Playwright's Chromium (`npx playwright install
 * chromium`). Dev-only: nothing in the product imports it, and the suite never
 * runs it.
 */
import { chromium } from "playwright";
import { startServer } from "../src/server/server.ts";
import { loadEnv } from "../src/engine/util.ts";

const PORT = 7791;
const MIN_SCORE = 75;
const OUT = "docs/screenshot.png";

loadEnv();
const server = startServer({ port: PORT });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForResponse((r) => r.url().includes("/api/jobs"), { timeout: 20_000 });

  // Wait for the reload this change triggers, not for whatever the first
  // render left on screen.
  const reloaded = page.waitForResponse(
    (r) => r.url().includes(`/api/jobs?min=${MIN_SCORE}`),
    { timeout: 20_000 },
  );
  await page.fill("#filterMin", String(MIN_SCORE));
  await page.dispatchEvent("#filterMin", "change");
  await reloaded;
  await page.waitForTimeout(300);

  const cards = await page.locator(".job").count();
  if (!cards) {
    throw new Error(`no matches at ${MIN_SCORE}; set MIN_SCORE lower in this script`);
  }
  console.log(`${cards} match(es) at ${MIN_SCORE}`);

  // The subtitle prints the CV's filename, which is personal. The app itself
  // falls back to "CV loaded" when no filename is set, so this is a state it
  // already has — not an invented one.
  const subtitle = (await page.locator("#subtitle").textContent()) ?? "";
  if (subtitle.startsWith("CV: ")) {
    for (const id of ["#subtitle", "#dropTitle"]) {
      await page.locator(id).evaluate((node) => {
        node.textContent = "CV loaded";
      });
    }
    console.log(`masked in the capture: "${subtitle}"`);
  }

  await page.screenshot({ path: OUT });
  console.log(`wrote ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
