import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, detectLang, jobId, repairMojibake } from "../src/engine/enrich/normalize.ts";
import { extractComp, toMonthly } from "../src/engine/enrich/comp.ts";
import { canonicalLocation, inRadius } from "../src/engine/enrich/location.ts";

const MARKERS = {
  ILS: ["₪", 'ש"ח', "ils", "nis", "שקל", "שקלים"],
  USD: ["$", "usd"],
};
const IL = { markers: MARKERS, defaultPeriod: "month" as const };

test("clean strips tags, scripts and entities", () => {  const html = `<div><script>alert(1)</script><p>Hello&nbsp;world &amp; friends</p><br/><li>a</li></div>`;
  const out = clean(html);
  assert.ok(!out.includes("<p>"));
  assert.ok(!out.includes("alert"));
  assert.ok(out.includes("Hello world & friends"));
  assert.ok(out.includes("• a"));
});

test("clean is stable under repeated cleaning", () => {
  const once = clean("<p>a  <b>b</b></p>");
  assert.equal(clean(once), once);
});

test("detectLang separates Hebrew, English and mixed", () => {
  assert.equal(detectLang("We are hiring a senior Android engineer to lead our mobile team."), "en");
  assert.equal(
    detectLang("אנחנו מגייסים מהנדס תוכנה בכיר להובלת צוות מובייל בחברה גדולה במרכז הארץ."),
    "he",
  );
  assert.equal(
    detectLang("We are hiring an Android engineer. דרוש מהנדס תוכנה."),
    "mixed",
  );
  assert.equal(detectLang("short"), "und");
});

test("extractComp reads a monthly shekel range", () => {
  const comp = extractComp('שכר: 45,000 ש"ח לחודש, כולל אופציות', IL);
  assert.ok(comp);
  assert.equal(comp!.amount, 45000);
  assert.equal(comp!.period, "month");
  assert.equal(comp!.currency, "ILS");
});

test("extractComp reads a K suffix", () => {
  const comp = extractComp("Salary: 50K NIS per month", IL);
  assert.equal(comp!.amount, 50000);
});

test("extractComp handles a non-shekel currency from config", () => {
  const comp = extractComp("Compensation: $12,000 per month", IL);
  assert.equal(comp!.currency, "USD");
  assert.equal(comp!.amount, 12000);
});

test("extractComp assumes a US annual salary when no period is stated", () => {
  const comp = extractComp("Base salary: $150,000", {
    markers: { USD: ["$"] },
    defaultPeriod: "year",
  });
  assert.equal(comp!.period, "year");
  assert.equal(comp!.currency, "USD");
  assert.equal(toMonthly(comp), 12500);
});

test("extractComp refuses numbers without a currency marker", () => {
  assert.equal(
    extractComp("Join us, 2024 was a great year and we have 45000 customers.", IL),
    undefined,
  );
});

test("extractComp does not treat words containing 'ils' as a currency", () => {
  assert.equal(extractComp("See details at https://acme.com/622653", IL), undefined);
});

test("extractComp ignores unrealistic amounts", () => {
  assert.equal(extractComp("Budget: ₪2,000,000 for the project", IL), undefined);
});

test("extractComp is a no-op when no markers are configured", () => {
  assert.equal(extractComp("Salary: 45,000 ₪ per month", { markers: {} }), undefined);
});

test("toMonthly normalises a yearly salary", () => {
  assert.equal(toMonthly({ amount: 600000, currency: "ILS", period: "year" }), 50000);
  assert.equal(toMonthly({ amount: 45000, currency: "ILS", period: "month" }), 45000);
});

test("canonicalLocation maps Hebrew city names", () => {
  const aliases = { "תל אביב": "Tel Aviv", "הרצליה": "Herzliya", "מרחוק": "Remote" };
  const r = canonicalLocation(["תל אביב-יפו"], aliases);
  assert.deepEqual(r.cities, ["Tel Aviv"]);
  assert.equal(r.remote, false);
});

test("canonicalLocation detects remote and hybrid", () => {
  const r = canonicalLocation(["Remote - Israel"], {});
  assert.equal(r.remote, true);
});

test("inRadius matches a city substring", () => {
  assert.equal(inRadius(["Tel Aviv District, Israel"], ["Tel Aviv"], []).hit, true);
  assert.equal(inRadius(["Beer Sheva"], ["Tel Aviv"], []).hit, false);
  assert.equal(inRadius(["השרון"], [], ["השרון"]).hit, true);
});

test("jobId is order independent for locations", () => {
  const a = jobId("Acme", "Engineering Manager", ["Tel Aviv", "Herzliya"]);
  const b = jobId("Acme", "Engineering Manager", ["Herzliya", "Tel Aviv"]);
  assert.equal(a, b);
  const c = jobId("Acme", "Engineering Manager", ["Haifa"]);
  assert.notEqual(a, c);
});

test("repairMojibake fixes double-encoded UTF-8", () => {
  assert.equal(repairMojibake("doctor\u00e2\u0080\u0099s office"), "doctor\u2019s office");
  assert.equal(repairMojibake("f\u00c3\u00bcr"), "f\u00fcr");
});

test("repairMojibake fixes Arabic decoded as Windows-1252", () => {
  assert.equal(repairMojibake("Ù…Ø³Ù‚Ø·"), "مسقط");
});

test("repairMojibake leaves correctly encoded text alone", () => {
  assert.equal(repairMojibake("f\u00fcr"), "f\u00fcr");
  assert.equal(repairMojibake("naive"), "naive");
  assert.equal(repairMojibake("Café … yes"), "Café … yes");
  assert.equal(repairMojibake("Tel Aviv — Israel"), "Tel Aviv — Israel");
});

test("repairMojibake keeps the original when the repair is not clean", () => {
  const broken = "Caf\u00e9 \u0085 trailing";
  assert.equal(repairMojibake(broken), broken);
});

test("clean repairs mojibake inside a description", () => {
  const out = clean("Gr\u00c3\u00bc\u00c3\u009fe \u00c3\u00a4us M\u00c3\u00bcnchen, doctor\u00e2\u0080\u0099s office");
  assert.ok(out.includes("doctor\u2019s office"));
  assert.ok(!out.includes("\u00e2\u0080"));
});

test("clean strips HTML that arrives escaped", () => {
  const out = clean("&lt;div&gt;&lt;p&gt;Real text&lt;/p&gt;&lt;/div&gt;");
  assert.ok(!out.includes("<div>"), "escaped markup must not survive");
  assert.ok(out.includes("Real text"));
});
