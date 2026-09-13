/** Read-only composed-control QA, restricted to the owned fictional preview. */
/* global document, getComputedStyle, innerWidth, innerHeight, matchMedia */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_MODULE)
  throw new Error("Supply the existing Playwright runtime");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const preview = JSON.parse(
  await readFile(resolve(".artifacts/phase7-preview-login.json"), "utf8"),
);
assert.match(preview.database, /^oron_ui_preview_[a-f0-9]+$/);
assert.equal(preview.email, "demo@example.invalid");
const output = resolve(".artifacts/brand-rebuild/composed-controls");
await mkdir(output, { recursive: true });
const scenarios = [1440, 390].flatMap((width) =>
  ["en", "he"].flatMap((locale) =>
    ["light", "dark"].map((theme) => ({
      width,
      height: 844,
      locale,
      theme,
      reflow: false,
    })),
  ),
);
// 1440x900 at 200% browser zoom has a 720x450 CSS-pixel viewport. This tests
// equivalent reflow + 2x raster density, not browser chrome zoom controls.
scenarios.push(
  ...["en", "he"].map((locale) => ({
    width: 720,
    height: 450,
    locale,
    theme: "dark",
    reflow: true,
  })),
);
const browser = await chromium.launch({ headless: true });
const observations = [];

async function insideViewport(page, panel) {
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      viewport: innerWidth,
      height: innerHeight,
      topLayer: element.matches(":popover-open"),
      animationDuration: getComputedStyle(element).animationDuration,
    };
  });
  assert.ok(
    geometry.left >= 0 && geometry.right <= geometry.viewport + 1,
    `Inline collision: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.top >= 0 && geometry.bottom <= geometry.height + 1,
    `Block collision: ${JSON.stringify(geometry)}`,
  );
  assert.equal(geometry.topLayer, true);
  assert.ok(
    parseFloat(geometry.animationDuration) <= 0.001,
    "Reduced-motion removes popover entrance movement",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  return geometry;
}

async function openRail(page, messages) {
  const opener = page
    .locator(".shell__mobile-header")
    .getByRole("button", { name: messages.shell.openNav });
  if (await opener.isVisible()) {
    await opener.click();
    await page.locator("#workspace-navigation[aria-modal=true]").waitFor();
    return true;
  }
  return false;
}

async function searchContact(page, id, messages, scenario, name) {
  const trigger = page.locator(`#${id}`);
  const native = trigger
    .locator("xpath=ancestor::div[contains(@class,'or-combobox')]")
    .locator("select");
  const before = await native.inputValue();
  await trigger.click();
  const panel = page.locator(".or-combobox__panel:popover-open");
  const search = panel.getByRole("combobox", {
    name: messages.premiumVoice.searchContacts,
  });
  await search.waitFor();
  assert.equal(
    await search.evaluate((element) => element === document.activeElement),
    true,
  );
  await search.fill("no-matching-fictional-contact-zzzz");
  await panel.getByRole("status").waitFor();
  assert.equal(await panel.getByRole("option").count(), 0);
  await search.press("Enter");
  assert.equal(await native.inputValue(), before);
  await search.fill("לדוגמה");
  assert.ok((await panel.getByRole("option").count()) > 0);
  await search.press("End");
  const activeId = await search.getAttribute("aria-activedescendant");
  assert.ok(activeId);
  const active = page.locator(`[id=${JSON.stringify(activeId)}]`);
  assert.ok((await active.textContent()).includes("לדוגמה"));
  const geometry = await insideViewport(page, panel);
  await page.screenshot({
    path: `${output}/${name}-${scenario.width}-${scenario.locale}-${scenario.theme}.png`,
  });
  await search.press("Enter");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true,
  );
  const selected = await native.inputValue();
  assert.notEqual(selected, "");
  assert.equal(
    await native.evaluate((element) =>
      new FormData(element.form).get(element.name),
    ),
    selected,
  );
  await trigger.click();
  await panel.getByRole("combobox").press("Escape");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await native.inputValue(), selected);
  return geometry;
}

try {
  for (const scenario of scenarios) {
    if (process.env.CONTROL_QA_FIRST_ONLY === "1" && observations.length > 0)
      break;
    const messages = JSON.parse(
      await readFile(
        resolve(`apps/web/src/i18n/messages/${scenario.locale}.json`),
        "utf8",
      ),
    );
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      locale: scenario.locale,
      reducedMotion: "reduce",
      deviceScaleFactor: scenario.reflow ? 2 : 1,
    });
    await context.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      scenario.theme,
    );
    const page = await context.newPage();
    const errors = [];
    const result = { ...scenario, errors, checks: [] };
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    try {
      await page.goto("http://127.0.0.1:3101/fictional-preview");
      await page.waitForURL("http://127.0.0.1:3100/**");
      const campaigns = await context.request.get(
        "http://127.0.0.1:3100/api/campaigns",
      );
      assert.equal(campaigns.ok(), true);
      const { broadcasts } = await campaigns.json();
      result.broadcastCounters = broadcasts
        .filter((item) => item.name.startsWith("Fictional "))
        .map(({ status, totalRecipients, deliveredCount, failedCount }) => ({
          status,
          totalRecipients,
          deliveredCount,
          failedCount,
        }));
      assert.equal(result.broadcastCounters.length, 4);
      for (const campaign of result.broadcastCounters) {
        assert.equal(campaign.totalRecipients, 8);
        assert.equal(
          campaign.deliveredCount,
          campaign.status === "sent" ? 8 : 0,
        );
        assert.equal(
          campaign.failedCount,
          campaign.status === "failed" ? 2 : 0,
        );
      }
      await page.goto(`http://127.0.0.1:3100/${scenario.locale}`);
      await page.waitForLoadState("networkidle");
      assert.equal(
        await page.evaluate(
          () => matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
        true,
      );
      const mobile = await openRail(page, messages);
      const account = page.getByRole("button", {
        name: messages.shell.account,
      });
      await account.click();
      const accountPanel = page.locator(".account-menu__panel:popover-open");
      await accountPanel.waitFor();
      result.account = await insideViewport(page, accountPanel);
      await page.screenshot({
        path: `${output}/account-${scenario.width}-${scenario.locale}-${scenario.theme}.png`,
      });
      const tenant = accountPanel.locator("#active-tenant");
      await tenant.click();
      result.nativePickerWasOpen = await tenant.evaluate((element) =>
        element.matches(":open"),
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await account.getAttribute("aria-expanded"),
        "true",
        "Native picker Escape must not close its parent",
      );
      await page.keyboard.press("Escape");
      assert.equal(await account.getAttribute("aria-expanded"), "false");
      assert.equal(
        await account.evaluate((element) => element === document.activeElement),
        true,
      );
      if (mobile)
        assert.equal(
          await page
            .locator("#workspace-navigation")
            .getAttribute("aria-modal"),
          "true",
        );
      else
        assert.equal(
          await page.locator(".rail-collapse").getAttribute("aria-expanded"),
          "true",
        );
      result.checks.push(
        "account top-layer collision, native picker Escape, parent Escape/focus restore",
      );

      await account.click();
      if (mobile) {
        await accountPanel
          .getByRole("button", { name: messages.shell.signOut })
          .focus();
        await page.keyboard.press("Tab");
        assert.equal(
          await page
            .locator("#workspace-navigation")
            .evaluate((element) => element.contains(document.activeElement)),
          true,
          "Drawer focus trap includes top-layer account descendants",
        );
        result.checks.push("mobile drawer traps focus from account popover");
      }
      const quick = page.getByRole("button", {
        name: messages.premiumShell.quickCreate,
      });
      await quick.click();
      assert.equal(
        await account.getAttribute("aria-expanded"),
        "false",
        "Outside click dismisses account",
      );
      const menu = page.getByRole("menu", {
        name: messages.premiumShell.quickCreate,
      });
      await menu.waitFor();
      result.quickCreate = await insideViewport(page, menu);
      const items = menu.getByRole("menuitem");
      assert.equal(await items.count(), 3);
      assert.equal(
        await items
          .first()
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await items
          .nth(1)
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("End");
      assert.equal(
        await items
          .last()
          .evaluate((element) => element === document.activeElement),
        true,
      );
      await page.keyboard.press("Home");
      await page.screenshot({
        path: `${output}/quick-create-${scenario.width}-${scenario.locale}-${scenario.theme}.png`,
      });
      await page.keyboard.press("Escape");
      assert.equal(await quick.getAttribute("aria-expanded"), "false");
      assert.equal(
        await quick.evaluate((element) => element === document.activeElement),
        true,
      );
      if (mobile)
        assert.equal(
          await page
            .locator("#workspace-navigation")
            .getAttribute("aria-modal"),
          "true",
        );
      result.checks.push(
        "quick create menu roles, arrows/Home/End, Escape and focus restore",
      );

      await page.goto("http://127.0.0.1:3100/orchestration?tab=activity");
      await page.waitForLoadState("networkidle");
      result.activity = await searchContact(
        page,
        "activity-contact",
        messages,
        scenario,
        "activity-contact",
      );
      await page.goto("http://127.0.0.1:3100/orchestration?tab=handoffs");
      await page.waitForLoadState("networkidle");
      const request = page.getByRole("button", {
        name: messages.orchestration.request,
        exact: true,
      });
      await request.click();
      result.handoff = await searchContact(
        page,
        "handoff-contact",
        messages,
        scenario,
        "handoff-contact",
      );
      const dialog = page.locator("dialog[open]");
      assert.equal(
        await dialog.count(),
        1,
        "Combobox Escape must preserve enclosing dialog",
      );
      await page.keyboard.press("Escape");
      assert.equal(await dialog.count(), 0);
      assert.equal(
        await request.evaluate((element) => element === document.activeElement),
        true,
      );
      result.checks.push(
        "both real contact comboboxes: Hebrew search, empty, keyboard selection, FormData, nested Escape",
      );
      assert.deepEqual(errors, []);
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.failure = error.message;
      await page
        .screenshot({
          path: `${output}/failure-${scenario.width}-${scenario.locale}-${scenario.theme}.png`,
        })
        .catch(() => undefined);
    } finally {
      observations.push(result);
      console.log(
        `composed controls ${scenario.width}/${scenario.locale}/${scenario.theme}: ${result.passed ? "PASS" : result.failure}`,
      );
      await context.close();
    }
  }
} finally {
  await writeFile(
    `${output}/observations.json`,
    JSON.stringify(observations, null, 2),
  );
  await browser.close();
}
assert.ok(
  observations.every((item) => item.passed),
  "One or more composed control scenarios failed",
);
