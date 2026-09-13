/* global document, getComputedStyle */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2]);
const root = path.resolve(import.meta.dirname, "..");
const preview = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
assert.match(preview.database, /^oron_ui_preview_[a-f0-9]+$/);
assert.equal(preview.email, "demo@example.invalid");
const out = path.join(root, ".artifacts/tenant-saas-rebuild/overview-health");
await fs.mkdir(out, { recursive: true });
const buildId = (
  await fs.readFile(path.join(root, "apps/web/.next/BUILD_ID"), "utf8")
).trim();
const results = [];
const browser = await chromium.launch({ headless: true });
try {
  const signedOut = await browser.newContext();
  assert.equal(
    (
      await signedOut.request.get("http://127.0.0.1:3100/api/system/health")
    ).status(),
    401,
  );
  await signedOut.close();
  for (const [width, locale, theme] of [
    [1440, "en", "light"],
    [1024, "en", "dark"],
    [768, "he", "light"],
    [390, "he", "dark"],
    [360, "en", "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    await context.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3101/fictional-preview");
    await page.waitForURL("http://127.0.0.1:3100/**");
    await page.goto("http://127.0.0.1:3100/" + locale);
    await page.waitForLoadState("networkidle");
    await context.route("**/*", (route) => {
      const request = route.request();
      if (
        new URL(request.url()).origin !== "http://127.0.0.1:3100" ||
        !["GET", "HEAD"].includes(request.method())
      )
        return route.abort();
      return route.continue();
    });
    const check = (name, data = {}) => {
      results.push({ width, locale, theme, name, buildId, ...data });
      console.log(width + " " + locale + ": " + name);
    };
    assert.equal(await page.locator(".overview-metric-card").count(), 4);
    assert.equal(await page.locator(".overview-conversation-list").count(), 0);
    assert.equal(await page.locator(".overview-bars button").count(), 14);
    await page.locator(".overview-bars button").last().focus();
    assert.equal(
      await page
        .locator(".overview-bars button")
        .last()
        .getAttribute("aria-pressed"),
      "true",
    );
    check("operational KPI hierarchy and keyboard chart inspection");
    await page.locator(".overview-chart-data summary").click();
    const data = await page
      .locator(".overview-chart-data tbody tr")
      .evaluateAll((rows) =>
        rows.map((row) =>
          [...row.querySelectorAll("td")].map((cell) =>
            Number(cell.textContent.replace(/[^0-9]/g, "")),
          ),
        ),
      );
    const volume = data.reduce((sum, row) => sum + row[0] + row[1], 0);
    const outcomes = data.reduce((sum, row) => sum + row[2] + row[3], 0);
    assert.equal(
      Number(
        (
          await page.locator(".overview-chart-summary strong").innerText()
        ).replace(/[^0-9]/g, ""),
      ),
      volume,
    );
    await page.locator(".overview-chart-switch input").nth(1).check();
    assert.equal(
      Number(
        (
          await page.locator(".overview-chart-summary strong").innerText()
        ).replace(/[^0-9]/g, ""),
      ),
      outcomes,
    );
    await page.locator(".overview-chart-data summary").click();
    assert.equal(
      await page
        .locator(".overview-bar-stack")
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    check(
      "delivery chart agrees with actual accessible record totals and reduced motion",
      { volume, outcomes },
    );
    if (width < 768) {
      assert.equal(
        await page.locator(".overview-products-compact li").count(),
        4,
      );
      assert.equal(
        await page.locator(".overview-products-compact").isVisible(),
        true,
      );
      const boxes = await page
        .locator(".overview-products-compact li")
        .evaluateAll((items) =>
          items.map((item) => ({
            scroll: item.scrollWidth,
            client: item.clientWidth,
          })),
        );
      assert.ok(boxes.every((box) => box.scroll <= box.client));
    }
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
    await page.screenshot({
      path: path.join(
        out,
        "overview-outcomes-" + width + "-" + locale + ".png",
      ),
      fullPage: true,
    });
    check("responsive overview exposes product outcomes");
    await page.goto("http://127.0.0.1:3100/system/health");
    await page.locator(".health-services tbody tr").first().waitFor();
    assert.equal(await page.locator(".health-services tbody tr").count(), 3);
    const statusGeometry = await page
      .locator(".health-services td:last-child")
      .evaluateAll((cells) =>
        cells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        }),
      );
    assert.ok(
      statusGeometry.every((box) => box.left >= 0 && box.right <= width),
      "All health statuses must be visible without horizontal scrolling",
    );
    const tone = await page
      .locator(".health-services .or-status")
      .first()
      .evaluate((element) => ({
        actual: getComputedStyle(element).color,
        marker: getComputedStyle(element.querySelector(".or-status__marker"))
          .backgroundColor,
      }));
    assert.equal(tone.actual, tone.marker);
    assert.equal(
      tone.actual,
      theme === "dark" ? "rgb(91, 209, 162)" : "rgb(22, 101, 52)",
    );
    check(
      "authenticated three-probe health status fits and semantic colors apply",
      tone,
    );
    await page.locator(".health-toolbar input[type=checkbox]").uncheck();
    const before = await page.locator(".health-history-bars > div").count();
    await page.locator(".health-toolbar button").click();
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll(".health-history-bars > div").length > count,
      before,
    );
    await page.route("**/api/system/health", (route) =>
      route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Fictional interrupted status response",
      }),
    );
    await page.locator(".health-toolbar button").click();
    await page.locator(".health-stale").waitFor();
    assert.equal(
      await page.locator(".health-overview").getAttribute("data-state"),
      "unknown",
    );
    assert.equal(await page.locator(".health-services tbody tr").count(), 3);
    await page.waitForFunction(() => {
      const signal = document.querySelector(".health-live-signal");
      const marker = document.querySelector(".health-overview .or-status");
      return (
        signal &&
        marker &&
        getComputedStyle(signal).color === getComputedStyle(marker).color
      );
    });
    await page.screenshot({
      path: path.join(out, "health-stale-" + width + "-" + locale + ".png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.unroute("**/api/system/health");
    await page.locator(".health-toolbar button").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector(".health-overview")
          ?.getAttribute("data-state") === "operational",
    );
    assert.equal(await page.locator(".health-stale").count(), 0);
    assert.equal(
      await page
        .locator(".health-live-signal")
        .evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
    assert.deepEqual(errors, []);
    check("manual refresh history, failed-check stale state and recovery");
    await context.close();
  }
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(out, "observations.json"),
    JSON.stringify(results, null, 2),
  );
}
console.log("Overview and health: " + results.length + " checks passed");
