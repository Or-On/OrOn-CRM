/** Verify optional voice outage in the owned fictional preview, never a live tenant. */
/* global document, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
assert.match(fixture.database, /^oron_ui_preview_[a-f0-9]+$/);
assert.equal(fixture.email, "demo@example.invalid");
assert.match(fixture.fixture_routes.contact, /^[a-f0-9-]{36}$/);
const voiceUp = await fetch("http://127.0.0.1:3102/health/live", {
  signal: AbortSignal.timeout(1500),
}).then(
  () => true,
  () => false,
);
assert.equal(
  voiceUp,
  false,
  "Stop only the owned preview voice service before this check",
);
const runtime = process.argv[2];
if (!runtime) throw new Error("Supply the existing bundled Playwright module");
const { chromium } = createRequire(import.meta.url)(runtime);
const out = path.join(root, ".artifacts/readiness/contact-outage");
await fs.mkdir(out, { recursive: true });
const buildId = (
  await fs.readFile(path.join(root, "apps/web/.next/BUILD_ID"), "utf8")
).trim();
const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, locale, theme] of [
    [1440, "en", "light"],
    [390, "he", "dark"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      locale,
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    const page = await context.newPage();
    await page.route("**/*", (route) =>
      ["http://127.0.0.1:3100", "http://127.0.0.1:3101"].includes(
        new URL(route.request().url()).origin,
      )
        ? route.continue()
        : route.abort(),
    );
    await page.goto("http://127.0.0.1:3101/fictional-preview");
    await page.waitForURL("http://127.0.0.1:3100/**");
    await context.addCookies([
      { name: "or_on_locale", value: locale, domain: "127.0.0.1", path: "/" },
    ]);
    const messages = JSON.parse(
      await fs.readFile(
        path.join(root, `apps/web/src/i18n/messages/${locale}.json`),
        "utf8",
      ),
    );
    const started = performance.now();
    const response = await page.goto(
      `http://127.0.0.1:3100/contacts/${fixture.fixture_routes.contact}`,
    );
    await page
      .getByText(messages.contacts.voiceServiceUnavailable, { exact: true })
      .waitFor();
    assert.equal(response.status(), 200);
    assert.equal(
      await page
        .getByRole("button", { name: messages.tenantPrimary.call, exact: true })
        .isDisabled(),
      true,
    );
    const navigationMs = Math.round(performance.now() - started);
    await page
      .getByRole("button", {
        name: messages.premiumPrimary.profileEdit,
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: messages.premiumPrimary.profileEdit,
      exact: true,
    });
    await dialog.waitFor();
    assert.ok(await dialog.getByRole("textbox").count());
    await page.keyboard.press("Escape");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const screenshot = `contact-outage-${width}-${locale}-${theme}.png`;
    await page.screenshot({
      path: path.join(out, screenshot),
      fullPage: true,
      animations: "disabled",
    });
    results.push({
      buildId,
      width,
      locale,
      theme,
      navigationMs,
      httpStatus: response.status(),
      callDisabled: true,
      editDialogOpened: true,
      overflow: false,
      screenshot,
    });
    await context.close();
  }
} finally {
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ checks: results.length, results }, null, 2));
