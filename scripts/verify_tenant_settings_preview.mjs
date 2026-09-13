/** Settings QA in the owned fictional preview; all application mutations are intercepted. */
/* global document, innerWidth, innerHeight, getComputedStyle */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.argv[2])
  throw new Error("Supply the existing bundled Playwright module");
const { chromium } = require(process.argv[2]);
const root = path.resolve(import.meta.dirname, "..");
const buildPath = path.join(root, "apps/web/.next/BUILD_ID");
const buildId = (await fs.readFile(buildPath, "utf8")).trim();
assert.match(buildId, /^[A-Za-z0-9_-]+$/);
const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
assert.match(fixture.database, /^oron_ui_preview_[a-f0-9]+$/);
assert.equal(fixture.email, "demo@example.invalid");
const out = path.resolve(
  process.argv[3] ?? path.join(root, ".artifacts/tenant-saas-rebuild/settings"),
);
await fs.mkdir(out, { recursive: true });
const results = [];
const scenarios = [
  [1440, 900, "en", "light", 1],
  [1024, 900, "he", "dark", 1],
  [768, 900, "en", "dark", 1],
  [390, 844, "he", "dark", 1],
  [360, 844, "en", "light", 1],
  // 200% zoom-equivalent CSS reflow and raster scale; not browser chrome zoom.
  [720, 450, "he", "dark", 2],
];
const categories = [
  "account",
  "appearance",
  "security",
  "workspace",
  "team",
  "notifications",
  "access",
  "integrations",
];
const browser = await chromium.launch({ headless: true });
try {
  for (const [width, height, locale, theme, deviceScaleFactor] of scenarios) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale,
      reducedMotion: "reduce",
      deviceScaleFactor,
    });
    context.setDefaultTimeout(8000);
    await context.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    const page = await context.newPage();
    const errors = [];
    const intercepted = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3101/fictional-preview");
    await page.waitForURL("http://127.0.0.1:3100/**");
    await context.addCookies([
      { name: "or_on_locale", value: locale, domain: "127.0.0.1", path: "/" },
    ]);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== "http://127.0.0.1:3100") return route.abort();
      if (!["GET", "HEAD"].includes(request.method())) {
        intercepted.push({ method: request.method(), pathname: url.pathname });
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
    const choose = async (id) => {
      const tab = page.locator(`#settings-${id}-tab`);
      if (await tab.isVisible()) await tab.click();
      else await page.locator(".settings-compact-navigation").selectOption(id);
      await page.locator(`#settings-${id}-panel`).waitFor({ state: "visible" });
    };
    const geometry = async () => {
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        "Settings has document overflow",
      );
      const visible = page.locator(".settings-panel:not([hidden])");
      assert.equal(await visible.count(), 1);
      assert.equal(
        await visible.evaluate(
          (element) => getComputedStyle(element).animationName,
        ),
        "none",
        "Reduced-motion panel animation remains",
      );
    };
    const record = async (name, operation) => {
      try {
        await operation();
        results.push({
          buildId,
          width,
          height,
          locale,
          theme,
          deviceScaleFactor,
          name,
          passed: true,
        });
      } catch (error) {
        results.push({
          buildId,
          width,
          height,
          locale,
          theme,
          deviceScaleFactor,
          name,
          passed: false,
          error: error.message,
        });
        await page.screenshot({
          path: path.join(
            out,
            `failure-${width}-${locale}-${results.length}.png`,
          ),
          fullPage: true,
        });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
      }
    };
    await page.goto("http://127.0.0.1:3100/settings");
    await page.waitForLoadState("networkidle");
    await record(
      "Eight category layouts, labels and reduced-motion",
      async () => {
        for (const id of categories) {
          await choose(id);
          await geometry();
          assert.ok(
            await page
              .locator(`#settings-${id}-panel > .settings-section-title h2`)
              .textContent(),
          );
          if (["team", "access"].includes(id)) {
            const action = page.locator(
              `#settings-${id}-panel .or-section-header__action > button`,
            );
            const bounds = await action.evaluate((button) => {
              const rect = button.getBoundingClientRect();
              const textRects = [...button.childNodes]
                .filter(
                  (node) => node.nodeType === 3 && node.textContent.trim(),
                )
                .flatMap((node) => {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  return [...range.getClientRects()].map((line) => ({
                    left: line.left,
                    right: line.right,
                    top: line.top,
                  }));
                });
              return {
                left: rect.left,
                right: rect.right,
                height: rect.height,
                textRects,
                viewport: innerWidth,
              };
            });
            assert.ok(bounds.textRects.length > 0);
            assert.equal(
              new Set(bounds.textRects.map((line) => Math.round(line.top)))
                .size,
              1,
              `${id} header action label wraps instead of its header`,
            );
            assert.ok(
              bounds.left >= 0 &&
                bounds.right <= bounds.viewport + 1 &&
                bounds.height <= 48 &&
                bounds.textRects.every(
                  (line) =>
                    line.left >= bounds.left - 1 &&
                    line.right <= bounds.right + 1,
                ),
              `${id} header action is squeezed or clipped`,
            );
          }
          if (id === "team") {
            const invitations = await page
              .locator(".settings-invitation-list article")
              .evaluateAll((rows) =>
                rows.map((row) => {
                  const rect = row.getBoundingClientRect();
                  const email = row
                    .querySelector("span:first-child")
                    .getBoundingClientRect();
                  const badge = row
                    .querySelector(".or-badge")
                    .getBoundingClientRect();
                  const expiry = row
                    .querySelector("time")
                    .getBoundingClientRect();
                  return {
                    width: rect.width,
                    left: rect.left,
                    right: rect.right,
                    emailWidth: email.width,
                    emailLeft: email.left,
                    emailRight: email.right,
                    emailBottom: email.bottom,
                    badgeTop: badge.top,
                    expiryTop: expiry.top,
                  };
                }),
              );
            assert.ok(invitations.length > 0, "Missing invitation fixture");
            for (const invitation of invitations) {
              assert.ok(
                invitation.emailLeft >= invitation.left - 1 &&
                  invitation.emailRight <= invitation.right + 1,
                "Invitation email escapes its row",
              );
              if (width <= 736)
                assert.ok(
                  invitation.emailWidth >= invitation.width - 2 &&
                    invitation.badgeTop >= invitation.emailBottom - 1 &&
                    invitation.expiryTop >= invitation.emailBottom - 1,
                  "Compact invitation email is squeezed by metadata",
                );
            }
          }
          if ([1440, 390].includes(width))
            await page.screenshot({
              path: path.join(out, `${id}-${width}-${locale}-${theme}.png`),
              fullPage: true,
            });
        }
        assert.equal(
          await page
            .getByText("Real delivery enabled", { exact: true })
            .count(),
          0,
        );
      },
    );
    await record("Account draft and personal controls", async () => {
      await choose("account");
      await page
        .locator("#account-display-name")
        .fill("Fictional unsaved name");
      await choose("appearance");
      const appearance = page.locator("#settings-appearance-panel");
      await appearance
        .getByRole("combobox", { name: messages.common.language })
        .waitFor();
      await appearance
        .getByRole("combobox", { name: messages.shell.themeToggle })
        .selectOption(theme);
      await choose("account");
      assert.equal(
        await page.locator("#account-display-name").inputValue(),
        "Fictional unsaved name",
      );
      if (await page.locator("#settings-security-tab").isVisible()) {
        await page.locator("#settings-security-tab").focus();
        await page.keyboard.press("ArrowUp");
        assert.equal(
          await page
            .locator("#settings-appearance-tab")
            .getAttribute("aria-selected"),
          "true",
        );
      }
    });
    await record(
      "Password mismatch remains local and does not submit",
      async () => {
        await choose("security");
        const before = intercepted.length;
        await page
          .locator("#password-current")
          .fill("fictional-current-password");
        await page.locator("#password-new").fill("fictional-new-password");
        await page
          .locator("#password-confirm")
          .fill("fictional-different-password");
        await page
          .locator("#settings-security-panel button[type=submit]")
          .click();
        await page
          .locator("#settings-security-panel")
          .getByRole("alert")
          .waitFor();
        assert.equal(intercepted.length, before);
        await choose("account");
        assert.equal(
          await page
            .locator("#settings-account-panel")
            .getByRole("alert")
            .count(),
          0,
        );
      },
    );
    await record(
      "Timezone search, no-results, keyboard selection and Escape focus",
      async () => {
        await choose("workspace");
        const trigger = page.locator("#timezone");
        await trigger.click();
        const panel = page.locator(".or-combobox__panel:popover-open");
        const search = panel.getByRole("combobox", {
          name: messages.tenantSettings.searchTimezones,
        });
        assert.equal(
          await search.evaluate(
            (element) => document.activeElement === element,
          ),
          true,
        );
        await search.fill("fictional-not-a-time-zone");
        await panel.getByRole("status").waitFor();
        assert.equal(await panel.getByRole("option").count(), 0);
        await search.fill("London");
        await search.press("ArrowDown");
        const bounds = await panel.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: innerWidth,
            height: innerHeight,
          };
        });
        assert.ok(
          bounds.left >= 0 &&
            bounds.right <= bounds.width + 1 &&
            bounds.top >= 0 &&
            bounds.bottom <= bounds.height + 1,
          "Timezone popup collides with viewport",
        );
        await search.press("Enter");
        assert.equal(
          await page.locator('select[name="timezone"]').inputValue(),
          "Europe/London",
        );
        assert.equal(
          await trigger.evaluate(
            (element) => document.activeElement === element,
          ),
          true,
        );
        await trigger.click();
        await panel.getByRole("combobox").press("Escape");
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        assert.equal(
          await trigger.evaluate(
            (element) => document.activeElement === element,
          ),
          true,
        );
        await geometry();
      },
    );
    await record(
      "Invitation preserves draft and focuses local failed action",
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
        await dialog
          .locator("#invitation-email")
          .fill("fictional-qa@example.invalid");
        await page.keyboard.press("Escape");
        assert.equal(
          await trigger.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
        );
        await trigger.click();
        assert.equal(
          await dialog.locator("#invitation-email").inputValue(),
          "fictional-qa@example.invalid",
        );
        await dialog.locator("button[type=submit]").click();
        await dialog.getByRole("alert").waitFor();
        assert.equal(
          await dialog.locator("#invitation-email").inputValue(),
          "fictional-qa@example.invalid",
        );
        await page.keyboard.press("Escape");
      },
    );
    await record(
      "API scopes default read-only and failed issue remains recoverable",
      async () => {
        await choose("access");
        await page
          .getByRole("button", { name: messages.management.issue, exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: messages.management.issue,
          exact: true,
        });
        assert.equal(
          await dialog.locator("#api-key-permissions").inputValue(),
          "read",
        );
        await dialog.locator("#api-key-name").fill("Fictional unissued key");
        await dialog.locator("button[type=submit]").click();
        await dialog.getByRole("alert").waitFor();
        assert.equal(
          await dialog.locator("#api-key-name").inputValue(),
          "Fictional unissued key",
        );
        await page.keyboard.press("Escape");
        await geometry();
      },
    );
    const revoke = page
      .locator("#settings-access-panel")
      .getByRole("button", {
        name: messages.tenantSettings.revoke,
        exact: true,
      })
      .first();
    if (await revoke.count()) {
      await record(
        "Revoke requires confirmation and keeps failure in the dialog",
        async () => {
          const before = intercepted.length;
          await revoke.click();
          let dialog = page.getByRole("dialog", {
            name: messages.tenantSettings.revokeTitle,
          });
          assert.equal(
            await dialog
              .getByRole("button", {
                name: messages.common.cancel,
                exact: true,
              })
              .evaluate((element) => element === document.activeElement),
            true,
          );
          await page.keyboard.press("Escape");
          assert.equal(intercepted.length, before);
          await revoke.click();
          dialog = page.getByRole("dialog", {
            name: messages.tenantSettings.revokeTitle,
          });
          await dialog
            .getByRole("button", {
              name: messages.tenantSettings.revoke,
              exact: true,
            })
            .click();
          await dialog.getByRole("alert").waitFor();
          await page.keyboard.press("Escape");
        },
      );
    } else
      results.push({
        buildId,
        width,
        locale,
        name: "Revoke browser coverage",
        skipped:
          "No API-key metadata in this preview; confirmation covered by unit tests",
      });
    results.push({
      buildId,
      width,
      locale,
      name: "Runtime and mutation containment",
      passed: errors.length === 0,
      errors,
      intercepted,
    });
    await context.close();
  }
} finally {
  await fs.writeFile(
    path.join(out, "interaction-settings.json"),
    JSON.stringify(results, null, 2),
  );
  await browser.close();
}
const failures = results.filter((result) => result.passed === false);
assert.equal(
  (await fs.readFile(buildPath, "utf8")).trim(),
  buildId,
  "Application build changed during Settings QA",
);
console.log(
  JSON.stringify(
    {
      buildId,
      checks: results.filter((result) => "passed" in result).length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
