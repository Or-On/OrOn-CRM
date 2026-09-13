/** Bounded browser QA against the task-owned fictional preview, never developer data. */
/* global document, innerWidth, innerHeight */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const [runtime] = process.argv.slice(2);
if (!runtime)
  throw new Error("Supply the existing bundled Playwright package path");
const { chromium } = createRequire(import.meta.url)(runtime);
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
    "Refusing a database/account outside the owned fictional preview",
  );
}
const out = path.join(
  root,
  ".artifacts/brand-rebuild/interaction-primary.json",
);
await fs.mkdir(path.dirname(out), { recursive: true });
const scenarios = [
  { width: 1440, height: 900, locale: "en", theme: "light" },
  { width: 1024, height: 844, locale: "he", theme: "dark" },
  { width: 768, height: 844, locale: "en", theme: "dark" },
  { width: 390, height: 844, locale: "he", theme: "dark" },
  { width: 360, height: 844, locale: "en", theme: "light" },
];
const results = [];
const browser = await chromium.launch({ headless: true });
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function geometry(page) {
  const observed = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    dialogs: [...document.querySelectorAll("dialog[open]")].map((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewportHeight: innerHeight,
      };
    }),
  }));
  assert(
    observed.width <= observed.viewport + 1,
    `Page overflow: ${observed.width}/${observed.viewport}`,
  );
  for (const rect of observed.dialogs) {
    assert(
      rect.left >= -1 &&
        rect.right <= observed.viewport + 1 &&
        rect.top >= -1 &&
        rect.bottom <= rect.viewportHeight + 1,
      "Dialog escapes viewport",
    );
  }
  return observed;
}

try {
  for (const scenario of scenarios) {
    const messages = JSON.parse(
      await fs.readFile(
        path.join(root, `apps/web/src/i18n/messages/${scenario.locale}.json`),
        "utf8",
      ),
    );
    const context = await browser.newContext({
      viewport: { width: scenario.width, height: scenario.height },
      locale: scenario.locale,
      reducedMotion: "reduce",
    });
    const observedErrors = [];
    const blocked = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      // Block all external traffic, all messaging/calling admissions and any mutation
      // except the explicitly checked fictional pipeline stage move below.
      if (
        !["http://127.0.0.1:3100", "http://127.0.0.1:3101"].includes(url.origin)
      ) {
        blocked.push({
          method: request.method(),
          path: url.pathname,
          reason: "external",
        });
        return route.abort();
      }
      if (
        request.method() !== "GET" &&
        request.method() !== "HEAD" &&
        !/^\/api\/crm\/deals\/[^/]+\/stage$/.test(url.pathname)
      ) {
        blocked.push({
          method: request.method(),
          path: url.pathname,
          reason: "mutation",
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
    page.on("pageerror", (error) => observedErrors.push(error.message));
    const record = {
      ...scenario,
      checks: [],
      blocked,
      runtimeErrors: observedErrors,
    };
    results.push(record);
    const check = async (name, work) => {
      try {
        const detail = await work();
        record.checks.push({ name, passed: true, detail });
      } catch (error) {
        const screenshot = path.join(
          path.dirname(out),
          `primary-failure-${scenario.width}-${scenario.locale}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
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
          screenshot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      console.log(
        `${scenario.width}/${scenario.locale}: ${name} ${record.checks.at(-1).passed ? "PASS" : "FAIL"}`,
      );
    };
    const go = async (pathname) => {
      await page.goto(`http://127.0.0.1:3100${pathname}`);
      await page.waitForLoadState("networkidle");
      assert(
        new URL(page.url()).pathname !== "/login",
        "Preview session is not authenticated",
      );
    };
    try {
      await page.goto("http://127.0.0.1:3101/fictional-preview");
      await page.waitForURL("http://127.0.0.1:3100/**");
      await go(`/${scenario.locale}`);
      await check(
        "Inbox single-pane navigation and isolated unsent drafts",
        async () => {
          await go("/inbox");
          const rows = page.locator("button.conversation-row");
          const count = await rows.count();
          assert(
            count > 1,
            "Fictional fixture needs two conversations for draft isolation",
          );
          await rows.first().click();
          const reply = page.getByRole("textbox", {
            name: messages.inbox.reply,
            exact: true,
          });
          const draft = `Fictional unsent UI check ${scenario.width}`;
          await reply.fill(draft);
          const back = page.getByRole("button", {
            name: messages.inbox.back,
            exact: true,
          });
          if (await back.isVisible()) await back.click();
          await rows.nth(1).click();
          assert(
            (await reply.inputValue()) === "",
            "Draft leaked into another conversation",
          );
          if (await back.isVisible()) await back.click();
          await rows.first().click();
          assert(
            (await reply.inputValue()) === draft,
            "Original unsent draft was discarded",
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
            "Conversation status control missing",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            !(await dialog.isVisible()),
            "Conversation controls did not close with Escape",
          );
          return observed;
        },
      );
      await check(
        "Contacts creation draft, focus restoration and loaded-data filters",
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
            "Create-contact focus was not restored",
          );
          await trigger.click();
          assert(
            (await name.inputValue()) === "Fictional retained contact draft",
            "Contact draft was discarded",
          );
          await page.keyboard.press("Escape");
          await page
            .getByRole("combobox", { name: messages.inbox.status, exact: true })
            .selectOption("active");
          await page
            .getByRole("searchbox", {
              name: messages.contacts.search,
              exact: true,
            })
            .fill("no-matching-fictional-contact");
          assert(
            await page
              .getByText(messages.inbox.noMatches, { exact: true })
              .isVisible(),
            "Filtered-empty state missing",
          );
          return geometry(page);
        },
      );
      await check(
        "Contact relationship controls stay inside viewport",
        async () => {
          const id = preview.fixture_routes?.contact;
          assert(
            typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
            "Fictional contact route missing",
          );
          await go(`/contacts/${id}`);
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
              name: messages.premiumPrimary.viewPermissions,
              exact: true,
            })
            .click();
          const observed = await geometry(page);
          // Only inspect safeguards. Never check approvals or press a call action.
          const dialog = page.getByRole("dialog", {
            name: messages.premiumPrimary.viewPermissions,
            exact: true,
          });
          assert(
            await dialog
              .getByRole("button", {
                name: messages.contacts.realCall,
                exact: true,
              })
              .isDisabled(),
            "Real calling should be disabled in this fixture",
          );
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Pipeline explicit keyboard stage movement and restoration",
        async () => {
          await go("/pipelines");
          const selectorId = await page
            .locator(".deal-card__move select")
            .first()
            .getAttribute("id");
          assert(
            typeof selectorId === "string" &&
              /^stage-[a-f0-9-]+$/.test(selectorId),
            "Fictional opportunity identity is invalid",
          );
          const selector = page.locator(`[id="${selectorId}"]`);
          assert(
            (await selector.count()) === 1,
            "Fictional pipeline opportunity missing",
          );
          const original = await selector.inputValue();
          const values = await selector
            .locator("option")
            .evaluateAll((options) => options.map((option) => option.value));
          assert(values.length > 1, "Fictional pipeline needs two stages");
          const target = original === values.at(-1) ? values[0] : values.at(-1);
          const move = async (value) => {
            const [saved] = await Promise.all([
              page.waitForResponse(
                (reply) =>
                  /\/api\/crm\/deals\/[^/]+\/stage$/.test(
                    new URL(reply.url()).pathname,
                  ) && reply.request().method() !== "GET",
              ),
              (async () => {
                await selector.focus();
                await page.keyboard.press("Space");
                const from = values.indexOf(await selector.inputValue());
                const to = values.indexOf(value);
                // Keep keyboard focus on the native picker's active option. Repeated
                // locator.press calls refocus the closed select in customizable-select
                // Chromium and do not exercise an actual keyboard selection.
                for (let step = 0; step < Math.abs(to - from); step++) {
                  await page.keyboard.press(
                    to > from ? "ArrowDown" : "ArrowUp",
                  );
                }
                await page.keyboard.press("Enter");
              })(),
            ]);
            assert(
              saved.ok(),
              `Fictional stage persistence failed (${saved.status()})`,
            );
            await page.waitForLoadState("networkidle");
            assert(
              (await selector.inputValue()) === value,
              "Keyboard stage change did not persist",
            );
          };
          try {
            await move(target);
          } finally {
            // Restore through the same real BFF contract, never by database writes.
            const card = selector;
            if ((await card.inputValue()) !== original) {
              const [restored] = await Promise.all([
                page.waitForResponse(
                  (reply) =>
                    /\/api\/crm\/deals\/[^/]+\/stage$/.test(
                      new URL(reply.url()).pathname,
                    ) && reply.request().method() !== "GET",
                ),
                card.selectOption(original),
              ]);
              assert(
                restored.ok(),
                "Could not restore fictional pipeline stage",
              );
            }
          }
          return geometry(page);
        },
      );
      await check(
        "Messaging tabs and recoverable blocked campaign creation",
        async () => {
          await go("/operations");
          await page
            .getByRole("button", {
              name: messages.premiumPrimary.newCampaign,
              exact: true,
            })
            .click();
          const dialog = page.getByRole("dialog", {
            name: messages.operations.draft,
            exact: true,
          });
          const name = dialog.getByRole("textbox", {
            name: messages.operations.campaignName,
            exact: true,
          });
          await name.fill("Fictional rejected UI request");
          await dialog
            .getByRole("textbox", {
              name: messages.operations.body,
              exact: true,
            })
            .fill("Fictional body; transport is blocked by this test.");
          await dialog
            .getByRole("button", {
              name: messages.operations.draft,
              exact: true,
            })
            .click();
          await dialog.getByRole("alert").waitFor();
          assert(
            (await name.inputValue()) === "Fictional rejected UI request",
            "Failed campaign input was lost",
          );
          await geometry(page);
          await page.keyboard.press("Escape");
          await page
            .getByRole("tab", {
              name: new RegExp(messages.operations.automations),
            })
            .click();
          await page
            .getByRole("button", {
              name: messages.premiumPrimary.newAutomation,
              exact: true,
            })
            .click();
          const automation = page.getByRole("dialog", {
            name: messages.operations.create,
            exact: true,
          });
          await automation
            .getByRole("textbox", {
              name: messages.operations.name,
              exact: true,
            })
            .fill("Fictional automation draft");
          await page.keyboard.press("Escape");
          await page
            .getByRole("tab", {
              name: new RegExp(messages.operations.campaigns),
            })
            .click();
          await page
            .getByRole("button", {
              name: messages.premiumPrimary.newCampaign,
              exact: true,
            })
            .click();
          assert(
            (await name.inputValue()) === "Fictional rejected UI request",
            "Switching tabs discarded campaign draft",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
    } catch (error) {
      record.checks.push({
        name: "scenario setup",
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await fs.writeFile(
    out,
    JSON.stringify(
      {
        previewDatabaseIsTaskOwned: true,
        realProvidersUsed: false,
        scenarios: results,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
if (
  results.some(
    (result) =>
      result.runtimeErrors.length ||
      result.checks.some((check) => !check.passed),
  )
)
  process.exitCode = 1;
