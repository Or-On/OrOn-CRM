/** Task-owned Inbox/Contacts QA. All external requests and mutations are blocked. */
/* global document, innerWidth, innerHeight */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const [runtime] = process.argv.slice(2);
if (!runtime) throw new Error("Supply the existing bundled Playwright runtime");
const { chromium } = createRequire(import.meta.url)(runtime);
const root = path.resolve(import.meta.dirname, "..");
const buildId = (
  await fs.readFile(path.join(root, "apps/web/.next/BUILD_ID"), "utf8")
).trim();
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
  throw new Error(
    "Refusing a database/account outside the task-owned fictional preview",
  );
const out = path.join(
  root,
  ".artifacts/tenant-saas-rebuild/interaction-primary.json",
);
await fs.mkdir(path.dirname(out), { recursive: true });
const scenarios = [
  { width: 1920, height: 1080, locale: "en", theme: "light" },
  { width: 1440, height: 900, locale: "en", theme: "light" },
  { width: 1024, height: 844, locale: "he", theme: "dark" },
  { width: 768, height: 844, locale: "en", theme: "dark" },
  { width: 390, height: 844, locale: "he", theme: "dark" },
  { width: 360, height: 844, locale: "en", theme: "light" },
];
const results = [];
const assert = (ok, message) => {
  if (!ok) throw new Error(message);
};
const browser = await chromium.launch({ headless: true });
async function geometry(page) {
  const result = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll("dialog[open]")].map((element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        height: innerHeight,
      };
    }),
  }));
  assert(
    result.width <= result.viewport + 1,
    "Page overflow " + result.width + "/" + result.viewport,
  );
  result.dialogs.forEach((r) =>
    assert(
      r.left >= -1 &&
        r.right <= result.viewport + 1 &&
        r.top >= -1 &&
        r.bottom <= r.height + 1,
      "Dialog escapes viewport",
    ),
  );
  return result;
}
async function tenantCopy(page, selector) {
  const copy = await page.locator(selector).evaluate((element) => {
    const clone = element.cloneNode(true);
    // Fictional message bodies deliberately contain historic simulator wording.
    // Check application copy, never rewrite or censor customer-authored records.
    clone
      .querySelectorAll(
        ".message-timeline, .conversation-row, .quick-replies, .note-list, .timeline, input, textarea, bdi",
      )
      .forEach((node) => node.remove());
    return clone.textContent ?? "";
  });
  assert(
    !/\b(?:simulator|simulation|consent|delivery mode|real delivery|test mode)\b|מצב בדיקה|סימולטור|הסכמה|משלוח אמיתי/iu.test(
      copy,
    ),
    "Internal delivery/consent terminology is visible",
  );
}
try {
  for (const scenario of scenarios) {
    const messages = JSON.parse(
      await fs.readFile(
        path.join(
          root,
          "apps/web/src/i18n/messages/" + scenario.locale + ".json",
        ),
        "utf8",
      ),
    );
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      locale: scenario.locale,
      reducedMotion: "reduce",
    });
    const record = { ...scenario, checks: [], blocked: [], runtimeErrors: [] };
    results.push(record);
    await context.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        !["http://127.0.0.1:3100", "http://127.0.0.1:3101"].includes(
          url.origin,
        ) ||
        !["GET", "HEAD"].includes(request.method())
      ) {
        record.blocked.push({
          method: request.method(),
          path: url.pathname,
          reason: ["GET", "HEAD"].includes(request.method())
            ? "external"
            : "mutation",
        });
        return route.abort();
      }
      return route.continue();
    });
    await context.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      scenario.theme,
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => record.runtimeErrors.push(error.message));
    const go = async (pathname) => {
      await page.goto("http://127.0.0.1:3100" + pathname);
      await page.waitForLoadState("networkidle");
      assert(
        !new URL(page.url()).pathname.includes("/login"),
        "Fixture authentication lost",
      );
    };
    const check = async (name, work) => {
      try {
        record.checks.push({ name, passed: true, detail: await work() });
      } catch (error) {
        const screenshot = path.join(
          path.dirname(out),
          "primary-failure-" +
            scenario.width +
            "-" +
            scenario.locale +
            "-" +
            record.checks.length +
            ".png",
        );
        await page
          .screenshot({
            path: screenshot,
            fullPage: true,
            animations: "disabled",
          })
          .catch(() => undefined);
        record.checks.push({
          name,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
          screenshot,
        });
      }
      console.log(
        scenario.width +
          "/" +
          scenario.locale +
          ": " +
          name +
          " " +
          (record.checks.at(-1).passed ? "PASS" : "FAIL"),
      );
    };
    const back = async () => {
      const button = page.getByRole("button", {
        name: messages.inbox.back,
        exact: true,
      });
      if (await button.isVisible()) await button.click();
    };
    const reply = () =>
      page.getByRole("textbox", { name: messages.inbox.reply, exact: true });
    try {
      await page.goto("http://127.0.0.1:3101/fictional-preview");
      await page.waitForURL("http://127.0.0.1:3100/**");
      await go("/" + scenario.locale);
      await check(
        "Inbox density, full width, guarded send and isolated drafts",
        async () => {
          await go("/inbox");
          const filters = page.locator(".inbox-filter");
          await filters.last().focus();
          const focusedFilter = await filters.last().evaluate((element) => {
            const item = element.getBoundingClientRect();
            const container = element.parentElement.getBoundingClientRect();
            return (
              item.left >= container.left - 1 &&
              item.right <= container.right + 1
            );
          });
          assert(
            focusedFilter,
            "Keyboard-focused filter is clipped by horizontal navigator",
          );
          await filters.first().focus();
          const rows = page.locator("button.conversation-row");
          assert((await rows.count()) >= 2, "Need two fictional conversations");
          await rows.first().click();
          await page.waitForFunction(() => {
            const thread = document.querySelector(".message-thread");
            return (
              thread &&
              thread.scrollHeight - thread.clientHeight - thread.scrollTop <= 2
            );
          });
          await reply().fill("Unsent fictional Inbox draft");
          assert(
            await page
              .getByRole("button", {
                name: messages.tenantPrimary.send,
                exact: true,
              })
              .isDisabled(),
            "Sending must remain disabled in this isolated preview",
          );
          await back();
          await rows.nth(1).click();
          assert(
            (await reply().inputValue()) === "",
            "Draft leaked across contacts",
          );
          await back();
          await rows.first().click();
          assert(
            (await reply().inputValue()) === "Unsent fictional Inbox draft",
            "Original draft was lost",
          );
          await tenantCopy(page, ".inbox-workspace");
          const dimensions = await page.evaluate(() => {
            const rect = (selector) =>
              document.querySelector(selector).getBoundingClientRect();
            return {
              workspace: rect(".inbox-workspace").width,
              available: rect(".page--inbox").width,
              composer: rect(".conversation-composer").height,
              thread: rect(".message-thread").height,
              height: rect(".inbox-workspace").height,
              filtersHeight: rect(".inbox-filters").height,
              identityWidth: rect(".message-contact").width,
              nameClipped:
                document.querySelector(".message-contact h2").scrollWidth >
                document.querySelector(".message-contact h2").clientWidth + 1,
              phoneClipped:
                document.querySelector(".message-contact__metadata small")
                  .scrollWidth >
                document.querySelector(".message-contact__metadata small")
                  .clientWidth +
                  1,
            };
          });
          assert(
            Math.abs(dimensions.workspace - dimensions.available) <= 2,
            "Inbox is inset within available page width",
          );
          assert(
            dimensions.composer < dimensions.height * 0.5,
            "Text composer consumes most of the workspace",
          );
          assert(dimensions.thread > 150, "Message viewport is too short");
          assert(
            dimensions.identityWidth >= 128,
            "Conversation recipient identity was squeezed by status/actions",
          );
          assert(
            !dimensions.nameClipped && !dimensions.phoneClipped,
            "Fictional conversation name or phone is not fully readable",
          );
          assert(
            dimensions.filtersHeight < 75,
            "Inbox filters are not a single compact row",
          );
          if (scenario.width === 1920)
            assert(
              dimensions.workspace > 1536,
              "Large desktop Inbox is still capped at 96rem",
            );
          await page
            .getByRole("button", {
              name: messages.tenantPrimary.template,
              exact: true,
            })
            .click();
          await page
            .getByRole("textbox", {
              name: messages.inbox.templateName,
              exact: true,
            })
            .fill("fictional_template");
          await geometry(page);
          await page
            .getByRole("button", {
              name: messages.tenantPrimary.text,
              exact: true,
            })
            .click();
          assert(
            (await reply().inputValue()) === "Unsent fictional Inbox draft",
            "Message/Template toggle lost draft",
          );
          await page
            .getByRole("button", {
              name: messages.premiumPrimary.messageSettings,
              exact: true,
            })
            .click();
          const dialog = page.getByRole("dialog", {
            name: messages.premiumPrimary.messageSettings,
            exact: true,
          });
          assert(
            (await dialog
              .getByRole("combobox", {
                name: messages.inbox.status,
                exact: true,
              })
              .count()) === 1,
            "Status editing unavailable",
          );
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            !(await dialog.isVisible()),
            "Conversation controls Escape failed",
          );
          return { ...(await geometry(page)), dimensions };
        },
      );
      await check(
        "Inbox loading, empty, failure and retry retain draft",
        async () => {
          await go("/inbox");
          await page.locator("button.conversation-row").first().click();
          await back();
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          let mode = "loading";
          const handler = async (route) => {
            if (mode === "loading") await gate;
            if (mode === "error")
              return route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({
                  error: "Fictional injected unavailable",
                }),
              });
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ messages: [], nextCursor: null }),
            });
          };
          const pattern = "**/api/messaging/conversations/*/messages";
          await page.route(pattern, handler);
          try {
            await page.locator("button.conversation-row").nth(1).click();
            await page.locator(".thread-loading").waitFor();
            assert(
              (await page
                .locator(".thread-loading")
                .getAttribute("aria-label")) === messages.inbox.loading,
              "Loading announcement not localized",
            );
            mode = "empty";
            release();
            await page
              .getByText(messages.tenantPrimary.startsHint, { exact: true })
              .waitFor();
            await reply().fill("Retained through unavailable read");
            await tenantCopy(page, ".inbox-workspace");
            mode = "error";
            await page.locator(".thread-notice[role=alert]").waitFor();
            assert(
              (await reply().inputValue()) ===
                "Retained through unavailable read",
              "Read failure discarded draft",
            );
            mode = "empty";
            await page.locator(".thread-notice").getByRole("button").click();
            await page
              .getByText(messages.tenantPrimary.startsHint, { exact: true })
              .waitFor();
            assert(
              (await reply().inputValue()) ===
                "Retained through unavailable read",
              "Retry discarded draft",
            );
            return geometry(page);
          } finally {
            mode = "empty";
            release();
            await page.unroute(pattern, handler);
          }
        },
      );
      await check(
        "Contact filters, stable sorting and responsive results",
        async () => {
          await go("/contacts");
          await tenantCopy(page, ".contacts-workspace");
          const sort = page.getByRole("combobox", {
            name: messages.tenantPrimary.sort,
            exact: true,
          });
          await sort.selectOption("nameAsc");
          const links = page.locator(".contact-profile-link:visible");
          const ascending = await links.allTextContents();
          assert(ascending.length > 1, "Fictional contacts missing");
          assert(
            ascending.every(
              (item, index) =>
                index === 0 ||
                ascending[index - 1].localeCompare(item, scenario.locale) <= 0,
            ),
            "Name sort not ascending",
          );
          await sort.selectOption("nameDesc");
          const descending = await links.allTextContents();
          assert(
            descending.every(
              (item, index) =>
                index === 0 ||
                descending[index - 1].localeCompare(item, scenario.locale) >= 0,
            ),
            "Name sort not descending",
          );
          await page.locator("#contacts-status-filter").selectOption("active");
          const channel = page.locator("#contacts-channel-filter");
          const channelValues = await channel
            .locator("option")
            .evaluateAll((options) => options.map((option) => option.value));
          if (channelValues.length > 1)
            await channel.selectOption(channelValues[1]);
          const tags = page.locator("#contacts-tag-filter");
          if (await tags.count()) {
            const values = await tags
              .locator("option")
              .evaluateAll((options) => options.map((option) => option.value));
            await tags.selectOption(values[1]);
            await tags.selectOption("all");
          }
          await page
            .getByRole("searchbox", {
              name: messages.contacts.search,
              exact: true,
            })
            .fill("no-matching-fictional-contact");
          await page
            .getByText(messages.inbox.noMatches, { exact: true })
            .waitFor();
          return {
            ...(await geometry(page)),
            sortedContacts: ascending.length,
          };
        },
      );
      await check(
        "Contact create failure, draft retention and modal focus",
        async () => {
          await go("/contacts");
          const trigger = page.getByRole("button", {
            name: messages.contacts.add,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: messages.contacts.add,
            exact: true,
          });
          const name = dialog.getByRole("textbox", {
            name: messages.common.name,
            exact: true,
          });
          await name.fill("Fictional retained contact draft");
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            await trigger.evaluate(
              (button) => button === document.activeElement,
            ),
            "Focus not restored",
          );
          await trigger.click();
          assert(
            (await name.inputValue()) === "Fictional retained contact draft",
            "Closed modal discarded draft",
          );
          await dialog
            .getByRole("textbox", {
              name: messages.contacts.phone,
              exact: true,
            })
            .fill("+12025550999");
          await dialog
            .getByRole("button", { name: messages.contacts.add, exact: true })
            .click();
          await dialog.getByRole("alert").waitFor();
          assert(
            (await name.inputValue()) === "Fictional retained contact draft",
            "Blocked mutation discarded draft",
          );
          await tenantCopy(page, "dialog[open]");
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Contact tabs, unsaved note and guarded call review",
        async () => {
          const id = fixture.fixture_routes?.contact;
          assert(
            typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
            "Fictional contact ID missing",
          );
          await go("/contacts/" + id);
          await tenantCopy(page, ".contact-record");
          await page
            .getByRole("tab", { name: new RegExp(messages.contacts.notes) })
            .click();
          const note = page.getByRole("textbox", {
            name: messages.contacts.noteLabel,
            exact: true,
          });
          await note.fill("Fictional unsaved relationship note");
          await page
            .getByRole("tab", { name: new RegExp(messages.contacts.fields) })
            .click();
          await page
            .getByRole("tab", { name: new RegExp(messages.contacts.notes) })
            .click();
          assert(
            (await note.inputValue()) === "Fictional unsaved relationship note",
            "Tab switch discarded note",
          );
          await page
            .getByRole("tab", {
              name: new RegExp(messages.tenantPrimary.activity),
            })
            .click();
          await page
            .locator(".contact-activity-filters")
            .getByRole("button", {
              name: messages.tenantPrimary.voice,
              exact: true,
            })
            .click();
          await page
            .locator(".contact-activity-filters")
            .getByRole("button", {
              name: messages.tenantPrimary.allActivity,
              exact: true,
            })
            .click();
          await page
            .getByRole("button", {
              name: messages.premiumPrimary.profileEdit,
              exact: true,
            })
            .click();
          await geometry(page);
          await page.keyboard.press("Escape");
          await page
            .getByRole("button", {
              name: messages.tenantPrimary.call,
              exact: true,
            })
            .click();
          const dialog = page.getByRole("dialog", {
            name: messages.tenantPrimary.call,
            exact: true,
          });
          assert(
            await dialog
              .getByRole("button", {
                name: messages.tenantPrimary.call,
                exact: true,
              })
              .isDisabled(),
            "Calling must stay disabled",
          );
          assert(
            await dialog.getByRole("checkbox").isDisabled(),
            "Approval should be disabled when admission is unavailable",
          );
          await tenantCopy(page, "dialog[open]");
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
    } catch (error) {
      record.checks.push({
        name: "scenario setup",
        passed: false,
        error: String(error),
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        previewDatabaseIsTaskOwned: true,
        buildId,
        realProvidersUsed: false,
        allMutationsBlocked: true,
        scenarios: results,
      },
      null,
      2,
    ),
  );
}
if (
  results.some(
    (item) =>
      item.runtimeErrors.length || item.checks.some((check) => !check.passed),
  )
)
  process.exitCode = 1;
