/** Bounded read-only browser QA against the explicitly owned fictional preview. */
/* global document, innerWidth, innerHeight, getComputedStyle, scrollY */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const [runtime, onlyWidth, diagnostic] = process.argv.slice(2);
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
const contactId = preview.fixture_routes?.contact;
const callId = preview.fixture_routes?.call;
if (
  ![contactId, callId].every(
    (id) => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id),
  )
) {
  throw new Error("Owned fictional contact/call routes are required");
}
const out = path.join(
  root,
  ".artifacts/tenant-saas-rebuild/interaction-voice-operations.json",
);
await fs.mkdir(path.dirname(out), { recursive: true });
const scenarios = [
  { width: 1440, height: 900, locale: "en", theme: "light" },
  { width: 1024, height: 844, locale: "he", theme: "dark" },
  { width: 768, height: 844, locale: "en", theme: "dark" },
  { width: 390, height: 844, locale: "he", theme: "dark" },
  { width: 360, height: 844, locale: "en", theme: "light" },
].filter((scenario) => !onlyWidth || scenario.width === Number(onlyWidth));
const results = [];
const browser = await chromium.launch({ headless: true });
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
async function geometry(page) {
  const observed = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    indexActions: [
      ...document.querySelectorAll(".orchestration-index__header > button"),
    ]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => ({
        height: button.getBoundingClientRect().height,
        label: button.textContent,
      })),
    overflow: [...document.querySelectorAll("main, main *")]
      .map((element) => ({
        element: element.tagName,
        className: element.className,
        width: element.getBoundingClientRect().width,
        scrollWidth: element.scrollWidth,
        overflow: getComputedStyle(element).overflow,
        grid: getComputedStyle(element).gridTemplateColumns,
      }))
      .filter(
        (element) =>
          typeof element.className === "string" &&
          (element.className.includes("or-data-table") ||
            element.className.includes("voice-call-index") ||
            element.className.includes("voice-detail-index") ||
            element.className === "or-visually-hidden"),
      )
      .slice(0, 10),
    overlays: [
      ...document.querySelectorAll("dialog[open], .or-popover:popover-open"),
    ].map((element) => {
      const rect = element.getBoundingClientRect();
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
    `Page overflow: ${observed.width}/${observed.viewport} ${JSON.stringify(observed.overflow)}`,
  );
  for (const rect of observed.overlays) {
    assert(
      rect.left >= -1 &&
        rect.right <= observed.viewport + 1 &&
        rect.top >= -1 &&
        rect.bottom <= rect.viewportHeight + 1,
      "Overlay escapes viewport",
    );
  }
  if (observed.viewport <= 608) {
    for (const action of observed.indexActions)
      assert(
        action.height <= 64,
        `Mobile index action is excessively wrapped: ${action.height}px ${action.label}`,
      );
  }
  return observed;
}
async function focused(locator) {
  return locator.evaluate((element) => element === document.activeElement);
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
    const blocked = [];
    const runtimeErrors = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
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
      // No mutation exceptions, including draft creation, simulation and actual calls.
      if (!["GET", "HEAD"].includes(request.method())) {
        blocked.push({
          method: request.method(),
          path: url.pathname,
          reason: "mutation",
        });
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Blocked fictional QA mutation" }),
        });
      }
      return route.continue();
    });
    await context.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      scenario.theme,
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    const record = { ...scenario, checks: [], blocked, runtimeErrors };
    results.push(record);
    const check = async (name, work) => {
      try {
        record.checks.push({ name, passed: true, detail: await work() });
      } catch (error) {
        const screenshot = path.join(
          path.dirname(out),
          `voice-failure-${scenario.width}-${scenario.locale}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
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
        !new URL(page.url()).pathname.includes("login"),
        "Preview session is not authenticated",
      );
      if (diagnostic === "containment")
        await page.addStyleTag({
          content: ".or-data-table { position: relative; }",
        });
    };
    const tab = async (id) => page.locator(`#orchestration-${id}-tab`).click();
    try {
      await page.goto("http://127.0.0.1:3101/fictional-preview");
      await page.waitForURL("http://127.0.0.1:3100/**");
      await go(`/${scenario.locale}`);
      await check(
        "Voice number dialog keyboard focus and retained draft",
        async () => {
          await go("/voice");
          await page.locator(".tenant-voice-summary").waitFor();
          await geometry(page);
          await page.locator("#voice-numbers-tab").click();
          const trigger = page.getByRole("button", {
            name: messages.voice.numberSetup,
            exact: true,
          });
          await trigger.focus();
          await trigger.press("Enter");
          const dialog = page.getByRole("dialog", {
            name: messages.voice.register,
            exact: true,
          });
          const phone = dialog.locator("input[name=e164]");
          assert(
            await focused(phone),
            "Phone registration initial focus missing",
          );
          await phone.fill("+15550100999");
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            !(await dialog.isVisible()) && (await focused(trigger)),
            "Dialog Escape did not close and restore focus",
          );
          await trigger.click();
          assert(
            (await phone.inputValue()) === "+15550100999",
            "Unsubmitted number draft was lost",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Voice campaign blocked creation preserves draft",
        async () => {
          await go("/voice/campaigns");
          await geometry(page);
          await page
            .getByRole("button", {
              name: messages.voice.createCampaign,
              exact: true,
            })
            .click();
          const dialog = page.getByRole("dialog", {
            name: messages.voice.createCampaign,
            exact: true,
          });
          const name = dialog.locator("#voice-campaign-name");
          assert(await focused(name), "Campaign initial focus missing");
          await name.fill("Fictional intercepted voice campaign");
          const flow = dialog.locator("#voice-campaign-flow");
          const values = await flow
            .locator("option")
            .evaluateAll((options) =>
              options.map((option) => option.value).filter(Boolean),
            );
          assert(
            values.length > 0,
            "Published fictional Voice flow is missing",
          );
          await flow.selectOption(values[0]);
          await dialog
            .getByRole("button", { name: messages.voice.draft, exact: true })
            .click();
          await dialog.getByRole("alert").waitFor();
          assert(
            (await name.inputValue()) ===
              "Fictional intercepted voice campaign",
            "Rejected campaign draft was cleared",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Voice flow source dialog retains unsent source",
        async () => {
          await go("/flows");
          const trigger = page.getByRole("button", {
            name: messages.voice.source,
            exact: true,
          });
          await trigger.click();
          const source = page.locator("#flow-source");
          assert(await focused(source), "Source editor initial focus missing");
          await source.fill('{"fictional":"unsent UI inspection"}');
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            await focused(trigger),
            "Source editor focus was not restored",
          );
          await trigger.click();
          assert(
            (await source.inputValue()).includes("unsent UI inspection"),
            "Source draft discarded on close",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Orchestration URL scope and keyboard node inspector",
        async () => {
          await go(`/orchestration?contact=${contactId}&tab=agents`);
          await tab("flows");
          const query = new URL(page.url()).searchParams;
          assert(
            query.get("contact") === contactId && query.get("tab") === "flows",
            "Tab lost contact scope or URL state",
          );
          const node = page.locator(".flow-canvas__steps button").first();
          await node.focus();
          await node.press("Enter");
          assert(
            (await node.getAttribute("aria-expanded")) === "true",
            "Keyboard node inspection did not expand",
          );
          await page.locator(".flow-canvas__node-detail").first().waitFor();
          await geometry(page);
          await tab("agents");
          const trigger = page.getByRole("button", {
            name: messages.orchestration.draft,
            exact: true,
          });
          await trigger.click();
          const name = page.locator("#agent-name");
          assert(await focused(name), "Agent dialog initial focus missing");
          await name.fill("Fictional retained agent draft");
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(await focused(trigger), "Agent dialog focus was not restored");
          await trigger.click();
          assert(
            (await name.inputValue()) === "Fictional retained agent draft",
            "Agent draft discarded",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Cross-channel draft failure retains source fields",
        async () => {
          await go("/orchestration?tab=flows");
          const trigger = page.getByRole("button", {
            name: messages.orchestration.createFlow,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: messages.orchestration.createFlow,
            exact: true,
          });
          const name = dialog.locator("#flow-name");
          assert(
            await focused(name),
            "Cross-channel draft initial focus missing",
          );
          await name.fill("Fictional intercepted connected flow");
          await dialog.locator("#flow-company").fill("Fictional company");
          await dialog
            .locator("#flow-message")
            .fill("Fictional unsent follow-up");
          const voiceFlowId = preview.fixture_routes.voiceFlow;
          assert(
            typeof voiceFlowId === "string" &&
              /^[a-f0-9-]{36}$/.test(voiceFlowId),
            "Owned fictional voice flow route missing",
          );
          await dialog.locator("#flow-voice-id").fill(voiceFlowId);
          const agent = dialog.locator("#flow-agent");
          const versions = await agent
            .locator("option")
            .evaluateAll((options) =>
              options.map((option) => option.value).filter(Boolean),
            );
          assert(versions.length > 0, "Published fictional agent is missing");
          await agent.selectOption(versions[0]);
          await dialog
            .getByRole("button", {
              name: messages.orchestration.createFlow,
              exact: true,
            })
            .click();
          await dialog.getByRole("alert").waitFor();
          await geometry(page);
          await page.keyboard.press("Escape");
          await trigger.click();
          assert(
            (await name.inputValue()) ===
              "Fictional intercepted connected flow",
            "Rejected connected-flow draft was lost",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Simulation admission is intercepted and selection recoverable",
        async () => {
          await go("/orchestration?tab=activity");
          const trigger = page.getByRole("button", {
            name: messages.orchestration.simulations,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: messages.orchestration.simulations,
            exact: true,
          });
          const session = dialog.locator("#simulation-session");
          const sessions = await session
            .locator("option")
            .evaluateAll((options) =>
              options.map((option) => option.value).filter(Boolean),
            );
          assert(
            sessions.length > 0,
            "Completed fictional simulation outcome missing",
          );
          await session.selectOption(sessions[0]);
          await dialog
            .getByRole("button", {
              name: messages.orchestration.queue,
              exact: true,
            })
            .click();
          await dialog.getByRole("alert").waitFor();
          assert(
            blocked.some(
              (request) =>
                request.path === "/api/orchestration/simulate" &&
                request.reason === "mutation",
            ),
            "Simulation admission was not intercepted",
          );
          assert(
            (await session.inputValue()) === sessions[0],
            "Simulation failure discarded selected outcome",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            await focused(trigger),
            "Simulation dialog focus was not restored",
          );
          return observed;
        },
      );
      await check(
        "Activity Combobox search keyboard selection and GET scope",
        async () => {
          await go(`/orchestration?contact=${contactId}&tab=activity`);
          const trigger = page.locator("button#activity-contact");
          await trigger.focus();
          await trigger.press("Enter");
          const search = page.getByRole("combobox", {
            name: messages.premiumVoice.searchContacts,
            exact: true,
          });
          assert(await focused(search), "Contact search initial focus missing");
          await search.fill("no-matching-fictional-preview-contact");
          await page
            .getByText(messages.premiumVoice.noMatchingContacts, {
              exact: true,
            })
            .waitFor();
          await search.fill("");
          await search.press("ArrowDown");
          await geometry(page);
          await search.press("Enter");
          assert(
            await focused(trigger),
            "Combobox selection did not restore trigger focus",
          );
          const form = page
            .locator("form.feature-toolbar")
            .filter({ has: trigger });
          const selected = await form
            .locator("select[name=contact]")
            .inputValue();
          await form
            .getByRole("button", { name: messages.common.details, exact: true })
            .click();
          await page.waitForLoadState("networkidle");
          const query = new URL(page.url()).searchParams;
          assert(
            query.get("tab") === "activity" &&
              query.get("contact") === selected,
            "Contact GET form lost selected scope or tab",
          );
          return geometry(page);
        },
      );
      await check(
        "Handoff nested Combobox Escape and retained reason",
        async () => {
          await go("/orchestration?tab=handoffs");
          const revealed = await page
            .locator("#orchestration-handoffs-tab")
            .evaluate((tab) => {
              const strip = tab.closest('[role="tablist"]');
              if (!strip) return false;
              const selected = tab.getBoundingClientRect();
              const viewport = strip.getBoundingClientRect();
              return (
                selected.left >= viewport.left - 1 &&
                selected.right <= viewport.right + 1
              );
            });
          assert(
            revealed,
            "Direct handoff URL leaves the selected tab offscreen",
          );
          assert(
            await page.evaluate(() => scrollY === 0),
            "Revealing active tab moved the document",
          );
          const trigger = page.getByRole("button", {
            name: messages.orchestration.request,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: messages.orchestration.request,
            exact: true,
          });
          const reason = dialog.locator("#handoff-reason");
          await reason.fill("Fictional unsent handoff reason");
          const contact = dialog.locator("button#handoff-contact");
          await contact.click();
          const search = dialog.getByRole("combobox", {
            name: messages.premiumVoice.searchContacts,
            exact: true,
          });
          assert(
            await focused(search),
            "Nested contact search did not receive focus",
          );
          await search.fill("Fictional");
          await geometry(page);
          await page.keyboard.press("Escape");
          assert(
            (await dialog.isVisible()) && (await focused(contact)),
            "First Escape must close only the nested picker",
          );
          await page.keyboard.press("Escape");
          assert(
            !(await dialog.isVisible()) && (await focused(trigger)),
            "Second Escape must close dialog and restore focus",
          );
          await trigger.click();
          assert(
            (await reason.inputValue()) === "Fictional unsent handoff reason",
            "Handoff reason draft discarded",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Call investigation renders real fixture transcript and usage",
        async () => {
          await go(`/voice/calls/${callId}`);
          await page.locator(".voice-investigation").waitFor();
          assert(
            (await page.locator(".voice-transcript").innerText()).trim()
              .length > 0,
            "Recorded fixture transcript missing",
          );
          await page.locator(".voice-cost-inspector").waitFor();
          return geometry(page);
        },
      );
      await check("Call activity filters match existing sample", async () => {
        await go("/voice");
        const statuses = page.locator("#voice-call-status");
        await statuses.selectOption("failed");
        const failedRows = page.locator(".voice-call-index tbody tr");
        assert(
          (await failedRows.count()) > 0,
          "Expected fictional failed calls",
        );
        assert(
          (await failedRows.allTextContents()).every((text) =>
            text.includes(messages.status.failed),
          ),
          "Status filter leaked another state",
        );
        await page
          .locator("#voice-call-search")
          .fill("no-matching-fictional-record");
        await page
          .getByText(messages.tenantOperations.noMatches, { exact: true })
          .waitFor();
        await page.locator("#voice-call-search").fill("");
        await statuses.selectOption("all");
        await page.locator("#voice-call-direction").selectOption("outbound");
        assert(
          (
            await page.locator(".voice-call-index tbody tr").allTextContents()
          ).every((text) => text.includes(messages.status.outbound)),
          "Direction filter leaked an inbound call",
        );
        return geometry(page);
      });
      await check(
        "Agent configuration selection and empty search",
        async () => {
          await go("/orchestration?tab=agents");
          const inspector = page.getByRole("region", {
            name: messages.tenantOperations.agentConfiguration,
            exact: true,
          });
          await inspector.waitFor();
          const prompt = await inspector
            .locator(".tenant-agent-instructions p")
            .innerText();
          assert(
            prompt.length > 0 &&
              prompt !== messages.tenantOperations.noInstructions,
            "Existing fixture instructions not projected",
          );
          await page
            .locator("#agent-search")
            .fill("no-matching-fictional-agent");
          await page
            .getByText(messages.tenantOperations.noMatches, { exact: true })
            .waitFor();
          assert(
            !(await inspector.isVisible()),
            "Filtered-out agent configuration remains visible",
          );
          await page.locator("#agent-search").fill("");
          const agent = page.locator(".tenant-record-list button").first();
          await agent.focus();
          await agent.press("Enter");
          await inspector.waitFor();
          return geometry(page);
        },
      );
      await check("Voice catalog source search and configuration", async () => {
        await go("/flows");
        await page.locator("#voice-flow-source").selectOption("tenant");
        const inspector = page.getByRole("region", {
          name: messages.tenantOperations.executionConfiguration,
          exact: true,
        });
        await inspector.waitFor();
        await page
          .locator("#voice-flow-search")
          .fill("no-matching-fictional-flow");
        await page
          .getByText(messages.tenantOperations.noMatches, { exact: true })
          .waitFor();
        assert(
          !(await inspector.isVisible()),
          "Filtered-out voice flow remains selected",
        );
        await page.locator("#voice-flow-search").fill("");
        await page.locator("#voice-flow-source").selectOption("all");
        await inspector.waitFor();
        return geometry(page);
      });
      await check(
        "Messaging campaign filters and retained composer",
        async () => {
          await go("/operations");
          const search = page.locator("#campaign-search");
          await search.fill("no-matching-fictional-campaign");
          await page
            .getByText(messages.tenantOperations.noMatches, { exact: true })
            .waitFor();
          await search.fill("");
          const trigger = page.getByRole("button", {
            name: messages.premiumPrimary.newCampaign,
            exact: true,
          });
          await trigger.click();
          const dialog = page.getByRole("dialog", {
            name: messages.operations.draft,
            exact: true,
          });
          const name = dialog.locator("#campaign-name");
          await name.fill("Fictional unsent campaign");
          await dialog
            .locator("#campaign-body")
            .fill("Fictional unsent message");
          await page.keyboard.press("Escape");
          assert(
            await focused(trigger),
            "Campaign composer did not restore focus",
          );
          await trigger.click();
          assert(
            (await name.inputValue()) === "Fictional unsent campaign",
            "Campaign draft discarded",
          );
          const observed = await geometry(page);
          await page.keyboard.press("Escape");
          return observed;
        },
      );
      await check(
        "Messaging execution history and selected automation",
        async () => {
          await go("/operations?source=fixture&tab=automations");
          await page.locator("#operations-automations-panel").waitFor();
          const historyTrigger = page
            .locator("#operations-automations-panel .operation-index__row")
            .filter({ hasText: "Fictional welcome handoff" })
            .getByRole("button", {
              name: messages.tenantOperations.runHistory,
              exact: true,
            })
            .first();
          await historyTrigger.click();
          const history = page.locator(
            "#operations-automations-panel .tenant-run-history",
          );
          await history.waitFor();
          assert(
            (await history.locator("tbody tr").count()) > 0,
            "Selected automation history empty in populated fixture",
          );
          await page.locator("#operations-history-tab").click();
          assert(
            new URL(page.url()).searchParams.get("source") === "fixture",
            "History navigation lost unrelated scope",
          );
          const allHistory = page.locator(
            "#operations-history-panel .tenant-run-history",
          );
          await allHistory.waitFor();
          const observedOption = await allHistory
            .locator("select option")
            .nth(1)
            .evaluate((option) => ({
              value: option.value,
              label: option.textContent,
            }));
          await allHistory.locator("select").selectOption(observedOption.value);
          assert(
            (await allHistory.locator("tbody tr").allTextContents()).every(
              (text) => text.includes(observedOption.label),
            ),
            "Execution filter leaked another state",
          );
          return geometry(page);
        },
      );
      await check("Selected connected flow history", async () => {
        await go("/orchestration?tab=flows");
        await page
          .locator(".orchestration-flow-studio__flow")
          .filter({ hasText: "Fictional welcome handoff" })
          .click();
        await page.locator(".tenant-history-disclosure > summary").click();
        const history = page.locator(
          ".tenant-history-disclosure .tenant-run-history",
        );
        await history.waitFor();
        assert(
          (await history.locator("tbody tr").count()) > 0,
          "Selected connected flow history missing",
        );
        return geometry(page);
      });
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
        diagnosticCssApplied: diagnostic === "containment",
        realProvidersUsed: false,
        allMutationsIntercepted: true,
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
