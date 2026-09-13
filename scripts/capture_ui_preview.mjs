/** Task-owned visual evidence only; never authenticate against a developer/remote DB. */
/* global document, innerWidth, getComputedStyle */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const [
  runtime,
  phase = "baseline",
  coverage = "representative",
  selection = "",
  previousBuildId,
  evidenceName = "brand-rebuild",
] = process.argv.slice(2);
if (!runtime || !["baseline", "final"].includes(phase)) {
  throw new Error(
    "Supply the bundled Playwright package path and baseline|final",
  );
}
const require = createRequire(import.meta.url);
const { chromium } = require(runtime);
const root = path.resolve(import.meta.dirname, "..");
const preview = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
if (
  !/^oron_ui_preview_[a-f0-9]+$/.test(preview.database) ||
  preview.email !== "demo@example.invalid"
) {
  throw new Error(
    "Refusing any preview other than the owned fictional account/database",
  );
}
if (
  ![
    "brand-rebuild",
    "tenant-saas-rebuild",
    "studio-replica",
    "readiness",
  ].includes(evidenceName)
)
  throw new Error("Unknown evidence folder");
const out = path.join(root, ".artifacts", evidenceName, phase);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const buildId = (
  await fs.readFile(path.join(root, "apps/web/.next/BUILD_ID"), "utf8")
).trim();
if (selection && !previousBuildId)
  throw new Error("Partial recapture requires the previous captured BUILD_ID");
const observations = selection
  ? JSON.parse(
      await fs.readFile(path.join(out, "observations.json"), "utf8"),
    ).map((item) => ({ ...item, buildId: item.buildId ?? previousBuildId }))
  : [];
const selected = (name) =>
  !selection || selection.split(",").some((prefix) => name.startsWith(prefix));
const record = (entry) => {
  const index = observations.findIndex((item) => item.file === entry.file);
  const value = { ...entry, buildId };
  if (index < 0) observations.push(value);
  else observations[index] = value;
};
const scenarios =
  coverage === "tablet"
    ? [{ width: 768, height: 900, locale: "en", theme: "dark" }]
    : ["full", "readiness"].includes(coverage)
      ? (coverage === "readiness"
          ? [1440, 390]
          : [1440, 390, 768, 1024, 360]
        ).flatMap((width) =>
          ["en", "he"].flatMap((locale) =>
            ["light", "dark"].map((theme) => ({
              width,
              height: width === 1440 ? 900 : 844,
              locale,
              theme,
            })),
          ),
        )
      : [
          { width: 1440, height: 900, locale: "en", theme: "light" },
          { width: 390, height: 844, locale: "he", theme: "dark" },
        ];
try {
  // Inspect the primary before/after pair early, then finish the full matrix.
  const priority = (scenario) =>
    scenario.width === 1440 &&
    scenario.locale === "en" &&
    scenario.theme === "light"
      ? 0
      : scenario.width === 390 &&
          scenario.locale === "he" &&
          scenario.theme === "dark"
        ? 1
        : 2;
  scenarios.sort((a, b) => priority(a) - priority(b));
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      locale: scenario.locale,
      reducedMotion: "reduce",
    });
    // Scenario preferences, not business state or authentication credentials.
    await context.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      scenario.theme,
    );
    const page = await context.newPage();
    await page.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      return ["http://127.0.0.1:3100", "http://127.0.0.1:3101"].includes(origin)
        ? route.continue()
        : route.abort();
    });
    const errors = [];
    const failedResponses = [];
    page.on("response", (response) => {
      if (response.status() >= 400)
        failedResponses.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("http://127.0.0.1:3101/fictional-preview");
    await page.waitForURL("http://127.0.0.1:3100/**");
    await page.goto(`http://127.0.0.1:3100/${scenario.locale}`);
    await page.waitForLoadState("networkidle");
    if (new URL(page.url()).pathname === "/login")
      throw new Error("Fictional preview authentication failed");

    const routes = [
      { name: "overview", url: "/" },
      { name: "inbox-list", url: "/inbox" },
      { name: "email", url: "/email" },
      { name: "calendar", url: "/calendar" },
      { name: "tasks", url: "/tasks" },
      { name: "contacts", url: "/contacts" },
      { name: "pipeline", url: "/pipelines" },
      { name: "messaging-campaigns", url: "/operations" },
      { name: "messaging-automations", url: "/operations", tab: 1 },
      ...(["tenant-saas-rebuild", "studio-replica", "readiness"].includes(
        evidenceName,
      )
        ? [{ name: "messaging-history", url: "/operations?tab=history" }]
        : []),
      { name: "voice", url: "/voice" },
      ...(["tenant-saas-rebuild", "studio-replica", "readiness"].includes(
        evidenceName,
      )
        ? [{ name: "voice-numbers", url: "/voice?tab=numbers" }]
        : []),
      { name: "voice-campaigns", url: "/voice/campaigns" },
      { name: "voice-flows", url: "/flows" },
      { name: "finance", url: "/finance" },
      ...["agents", "flows", "activity", "handoffs"].map((tab) => ({
        name: `orchestration-${tab}`,
        url: `/orchestration?tab=${tab}`,
      })),
      { name: "health", url: "/system/health" },
      { name: "profile", url: "/profile" },
      { name: "users", url: "/users" },
      { name: "roles", url: "/roles" },
      ...(evidenceName === "readiness"
        ? [{ name: "tenants", url: "/tenants" }]
        : []),
      ...[
        "account",
        ...(["tenant-saas-rebuild", "studio-replica", "readiness"].includes(
          evidenceName,
        )
          ? ["appearance", "security"]
          : []),
        "workspace",
        "team",
        "notifications",
        "access",
        "integrations",
      ].map((tab, index) => ({
        name: `settings-${tab}`,
        url: "/settings",
        tab: index,
      })),
      { name: "start", url: "/start" },
      { name: "not-found", url: "/not-a-valid-product-route" },
    ];
    for (const [name, id] of Object.entries(preview.fixture_routes ?? {})) {
      if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) continue;
      const url =
        name === "contact"
          ? `/contacts/${id}`
          : name === "conversation"
            ? `/inbox?conversation=${id}`
            : name === "call"
              ? `/voice/calls/${id}`
              : undefined;
      if (url) routes.push({ name: `fixture-${name}`, url });
    }
    for (const route of routes.filter((route) => selected(route.name))) {
      await page.goto(`http://127.0.0.1:3100${route.url}`);
      await page.waitForLoadState("networkidle");
      if (route.tab !== undefined) {
        const tabs = page.getByRole("tab");
        if (
          (await tabs.count()) > route.tab &&
          (await tabs.nth(route.tab).isVisible())
        )
          await tabs.nth(route.tab).click();
        else if (route.name.startsWith("settings-")) {
          const selector = page
            .locator(".settings-navigation")
            .getByRole("combobox");
          if (await selector.count())
            await selector.selectOption(route.name.slice("settings-".length));
        }
      }
      if (route.name === "fixture-conversation" && scenario.width < 992) {
        const item = page.locator(".conversation-row").first();
        if (await item.count()) await item.click();
      }
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => ({
        navigation: performance.getEntriesByType("navigation").map((entry) => ({
          responseStartMs: Math.round(entry.responseStart),
          responseEndMs: Math.round(entry.responseEnd),
          domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
        })),
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        h1: Array.from(document.querySelectorAll("main h1")).filter(
          (e) => e.getClientRects().length,
        ).length,
        title: document.title,
        headingFont: document.querySelector("main h1")
          ? getComputedStyle(document.querySelector("main h1")).fontFamily
          : null,
        direction: document.documentElement.dir,
        theme: document.documentElement.dataset.theme,
      }));
      const file = `${route.name}-${scenario.width}-${scenario.locale}-${scenario.theme}.png`;
      await page.screenshot({
        path: path.join(out, file),
        fullPage: true,
        animations: "disabled",
      });
      record({
        file,
        route: route.url,
        ...scenario,
        ...geometry,
        errors: [...new Set(errors)],
        failedResponses: [...failedResponses],
      });
      errors.length = 0;
      failedResponses.length = 0;
      console.log(
        `${phase}: ${file} overflow=${geometry.pageWidth > geometry.viewport}`,
      );
    }
    // Reuse this isolated context after clearing only its test cookies. A second
    // simultaneous context is unnecessary and increased Windows socket pressure.
    await context.clearCookies();
    const authPage = page;
    await authPage.goto(`http://127.0.0.1:3100/${scenario.locale}`);
    for (const name of ["login", "invite"].filter(selected)) {
      await authPage.goto(`http://127.0.0.1:3100/${name}`);
      await authPage.waitForLoadState("networkidle");
      await authPage.evaluate(() => document.fonts.ready);
      const geometry = await authPage.evaluate(() => ({
        pageWidth: document.documentElement.scrollWidth,
        viewport: innerWidth,
        h1: Array.from(document.querySelectorAll("main h1")).filter(
          (e) => e.getClientRects().length,
        ).length,
        title: document.title,
        headingFont: document.querySelector("main h1")
          ? getComputedStyle(document.querySelector("main h1")).fontFamily
          : null,
        direction: document.documentElement.dir,
        theme: document.documentElement.dataset.theme,
      }));
      const file = `${name}-${scenario.width}-${scenario.locale}-${scenario.theme}.png`;
      await authPage.screenshot({
        path: path.join(out, file),
        fullPage: true,
        animations: "disabled",
      });
      record({
        file,
        route: `/${name}`,
        ...scenario,
        ...geometry,
        errors: [...new Set(errors)],
        failedResponses: [...failedResponses],
      });
      errors.length = 0;
      failedResponses.length = 0;
    }
    await context.close();
    await fs.writeFile(
      path.join(out, "observations.json"),
      JSON.stringify(observations, null, 2),
    );
  }
} finally {
  await fs.writeFile(
    path.join(out, "observations.json"),
    JSON.stringify(observations, null, 2),
  );
  await browser.close();
}
