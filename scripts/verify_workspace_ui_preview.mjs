/** Read-only browser QA of the task-owned preview. Mutation responses are mocked failures. */
/* global document, innerWidth */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const runtime = process.argv[2];
if (!runtime) throw new Error("Supply the existing bundled Playwright module");
const { chromium } = require(runtime);
const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
if (
  !/^oron_ui_preview_[a-f0-9]+$/.test(fixture.database) ||
  fixture.email !== "demo@example.invalid"
)
  throw new Error("Refusing non-fictional preview");
const out = path.join(root, ".artifacts/brand-rebuild");
await fs.mkdir(out, { recursive: true });
const results = [];
const browser = await chromium.launch({ headless: true });
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
try {
  for (const [width, locale, theme] of [
    [1440, "en", "light"],
    [1024, "he", "dark"],
    [768, "en", "dark"],
    [390, "he", "dark"],
    [360, "en", "light"],
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
    const errors = [];
    const blocked = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3101/fictional-preview");
    await page.waitForURL("http://127.0.0.1:3100/**");
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== "http://127.0.0.1:3100")
        return route.abort();
      if (!["GET", "HEAD"].includes(request.method())) {
        blocked.push(new URL(request.url()).pathname);
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporarily_unavailable" }),
        });
      }
      return route.continue();
    });
    const messages = JSON.parse(
      await fs.readFile(
        path.join(root, `apps/web/src/i18n/messages/${locale}.json`),
        "utf8",
      ),
    );
    const record = async (name, operation) => {
      try {
        await operation();
        results.push({ width, locale, theme, name, passed: true });
      } catch (error) {
        await page.screenshot({
          path: path.join(
            out,
            `workspace-failure-${width}-${locale}-${name.replace(/[^a-z0-9]/gi, "-")}.png`,
          ),
          fullPage: true,
          animations: "disabled",
        });
        results.push({
          width,
          locale,
          theme,
          name,
          passed: false,
          error: error.message,
        });
      }
    };
    await record(
      "Overview exact daily inspection and accessible data",
      async () => {
        await page.goto(`http://127.0.0.1:3100/${locale}`);
        await page.waitForLoadState("networkidle");
        const bars = page.locator(".overview-chart-hit-targets button");
        check((await bars.count()) === 14, "Expected14UTCdays");
        await bars.nth(13).focus();
        await page.keyboard.press("Enter");
        check(
          (await bars.nth(13).getAttribute("aria-pressed")) === "true",
          "Selecteddaynotannounced",
        );
        check(
          (await page.locator(".overview-chart-inspection").textContent()) ===
            (await bars.nth(13).getAttribute("aria-label")),
          "Inspection differsfromactualcounts",
        );
        await page.locator(".overview-chart-data summary").click();
        check(
          (await page.locator(".overview-chart-data tbody tr").count()) === 14,
          "Datatablemissingdays",
        );
        const fonts = await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .filter((e) => e.name.includes(".woff2"))
            .map((e) => ({
              file: new URL(e.name).pathname.split("/").pop(),
              encodedBytes: e.encodedBodySize,
            })),
        );
        results.push({
          width,
          locale,
          theme,
          name: "observed-font-resources",
          fonts,
        });
        check(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "Overviewoverflow",
        );
      },
    );
    await page.goto("http://127.0.0.1:3100/settings");
    await page.waitForLoadState("networkidle");
    const choose = async (name) => {
      const tab = page.locator(`#settings-${name}-tab`);
      if (await tab.isVisible()) await tab.click();
      else
        await page.locator(".settings-compact-navigation").selectOption(name);
    };
    await record("Settings account draft survives section change", async () => {
      const field = page.locator("#account-display-name");
      await field.fill("Fictional unsubmitted display name");
      await choose("notifications");
      await choose("account");
      check(
        (await field.inputValue()) === "Fictional unsubmitted display name",
        "Accountdraftlost",
      );
    });
    await record(
      "Invitation dialog restores draft, focus and local error",
      async () => {
        await choose("team");
        const trigger = page.getByRole("button", {
          name: messages.management.invite,
          exact: true,
        });
        await trigger.click();
        const dialog = page.getByRole("dialog", {
          name: messages.management.invite,
          exact: true,
        });
        const email = dialog.locator("#invitation-email");
        await email.fill("fictional-qa@example.invalid");
        await page.keyboard.press("Escape");
        check(
          await trigger.evaluate((e) => document.activeElement === e),
          "Invitationfocusnotrestored",
        );
        await trigger.click();
        check(
          (await email.inputValue()) === "fictional-qa@example.invalid",
          "Invitationdraftlost",
        );
        await dialog.locator("button[type=submit]").click();
        await dialog.getByRole("alert").waitFor();
        check(
          (await email.inputValue()) === "fictional-qa@example.invalid",
          "Faileddraftlost",
        );
        await page.keyboard.press("Escape");
      },
    );
    await record("API-key dialog contains failed action feedback", async () => {
      await choose("access");
      await page
        .getByRole("button", { name: messages.management.issue, exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: messages.management.issue,
        exact: true,
      });
      await dialog.locator("#api-key-name").fill("Fictional unissued key");
      await dialog.locator("button[type=submit]").click();
      await dialog.getByRole("alert").waitFor();
      check(
        (await dialog.locator("#api-key-name").inputValue()) ===
          "Fictional unissued key",
        "Faileddraftlost",
      );
      await page.keyboard.press("Escape");
      check(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "Settingsoverflow",
      );
    });
    results.push({
      width,
      locale,
      theme,
      name: "safety-and-runtime",
      passed: errors.length === 0,
      errors,
      blocked,
    });
    await context.close();
  }
} finally {
  await fs.writeFile(
    path.join(out, "interaction-workspace.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
const failures = results.filter((r) => r.passed === false);
console.log(
  JSON.stringify(
    { checks: results.filter((r) => "passed" in r).length, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
