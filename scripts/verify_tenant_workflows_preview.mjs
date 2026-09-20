/** Browser acceptance on the launcher's disposable fictional database only. */
/* global document, innerWidth */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.argv[2])
  throw new Error("Supply the bundled Playwright package path");
const { chromium } = require(process.argv[2]);
const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(
  await fs.readFile(
    path.join(root, ".artifacts/phase7-preview-login.json"),
    "utf8",
  ),
);
assert.match(fixture.database, /^oron_ui_preview_[a-f0-9]+$/);
assert.equal(fixture.email, "demo@example.invalid");
const out = path.join(root, ".artifacts/tenant-workflow-preview");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const mode = process.argv[3] ?? "owner";
const base = "http://127.0.0.1:3100";
const tenantId = "10000000-0000-4000-8000-000000000001";

async function mutation(context, pathname, body, method = "POST") {
  const csrf = (await context.cookies(base)).find(
    (cookie) => cookie.name === "or_on_csrf",
  )?.value;
  const response = await context.request.fetch(`${base}${pathname}`, {
    method,
    data: body,
    headers: { origin: base, "x-csrf-token": csrf ?? "" },
  });
  const payload = await response.json();
  assert.equal(response.ok(), true, `${pathname}: ${JSON.stringify(payload)}`);
  return payload;
}

try {
  let caseId;
  if (mode === "owner" || mode === "leads") {
    const setup = await browser.newContext();
    const page = await setup.newPage();
    await page.goto("http://127.0.0.1:3101/fictional-preview", {
      timeout: 120000,
    });
    await page.waitForURL(`${base}/**`, { timeout: 120000 });
    await mutation(setup, "/api/auth/tenant", { tenantId });
    await page.goto(`${base}/settings/business`, { timeout: 120000 });
    await page
      .getByRole("heading", { name: "Business configuration" })
      .waitFor();
    // A resumed fixture may have been submitted by its normal-owner role.
    const approve = page.getByRole("button", { name: "Approve & publish" });
    if (await approve.isVisible()) {
      await approve.click();
      await page
        .getByText(
          "Approved and published. The workspace now uses this configuration.",
        )
        .waitFor();
    }
    const template = page
      .getByRole("heading", {
        name: mode === "leads" ? "Leads only" : "Field Service",
        exact: true,
      })
      .locator("xpath=ancestor::article");
    await template.getByRole("button").click();
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page
      .getByText("Draft saved. Continue configuring or submit it for review.")
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "Submit for approval" }).click();
    await page.getByRole("button", { name: "Approve & publish" }).waitFor();
    await page.getByRole("button", { name: "Approve & publish" }).click();
    await page
      .getByText(
        "Approved and published. The workspace now uses this configuration.",
      )
      .waitFor({ timeout: 30000 });
    results.push({
      mode,
      name: "Real draft → submit → approve through UI",
      passed: true,
    });

    if (mode === "owner") {
      const contactsResponse = await setup.request.get(
        `${base}/api/crm/contacts?limit=5`,
      );
      const contacts = await contactsResponse.json();
      const contactId = contacts.contacts?.[0]?.id;
      assert.ok(contactId, "Preview needs a fictional contact");
      const chain = await mutation(setup, "/api/field-service/directory", {
        kind: "chain",
        name: "Preview retail network",
      });
      const store = await mutation(setup, "/api/field-service/directory", {
        kind: "store",
        name: "North branch · סניף צפון",
        chainId: chain.id,
        contactId,
        address: "18 Example Street · רחוב לדוגמה",
      });
      const created = await mutation(setup, "/api/field-service/cases", {
        customerContactId: contactId,
        serviceLocationId: store.id,
        title: "Receipt printer stops during checkout · תקלה בקופה",
        faultDescription:
          "The printer powers on but receipts stay blank after restarting.",
        exactFailure: "Receipt printing fails while payments remain available.",
        warrantyStatus: "unknown",
        priority: "high",
      });
      caseId = created.case.id;
      await mutation(setup, "/api/field-service/cases", {
        customerContactId: contactId,
        serviceLocationId: store.id,
        title: "Network switch keeps restarting · ניתוק רשת",
        faultDescription:
          "Store equipment loses its connection every few minutes.",
        exactFailure: "Checkout network connection drops repeatedly.",
        warrantyStatus: "unknown",
        priority: "urgent",
      });
      const technician = await mutation(
        setup,
        "/api/field-service/technicians",
        {
          fullName: "Fictional field technician",
          verified: true,
        },
      );
      await mutation(setup, "/api/field-service/visits", {
        caseId,
        technicianId: technician.id,
      });
      await fs.writeFile(
        path.join(out, "fixture.json"),
        JSON.stringify({
          caseId,
          technicianId: technician.id,
          database: fixture.database,
        }),
      );
    }
    await setup.close();
  } else {
    const saved = JSON.parse(
      await fs.readFile(path.join(out, "fixture.json"), "utf8"),
    );
    assert.equal(saved.database, fixture.database);
    caseId = saved.caseId;
  }

  for (const [width, height, locale, theme] of [
    [1440, 1000, "en", "light"],
    [768, 1024, "he", "dark"],
    [390, 844, "he", "dark"],
    [360, 800, "en", "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale,
      reducedMotion: "reduce",
    });
    context.setDefaultTimeout(15000);
    await context.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:3101/fictional-preview", {
      timeout: 120000,
    });
    await page.waitForURL(`${base}/**`, { timeout: 120000 });
    await mutation(context, "/api/auth/tenant", { tenantId });
    await context.addCookies([
      { name: "or_on_locale", value: locale, domain: "127.0.0.1", path: "/" },
    ]);
    async function capture(name) {
      if (name === "configuration" || name === "directory")
        await page.evaluate(() => {
          if (document.scrollingElement)
            document.scrollingElement.scrollTop = 0;
        });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
        `${name} overflows at ${width}`,
      );
      assert.equal(
        await page.locator("html").getAttribute("dir"),
        locale === "he" ? "rtl" : "ltr",
      );
      await page.screenshot({
        path: path.join(out, `${mode}-${name}-${width}-${locale}-${theme}.png`),
        fullPage: name === "configuration" || name === "directory",
      });
      results.push({ mode, name, width, locale, theme, passed: true });
    }
    if (mode === "leads") {
      await page.goto(`${base}/`, { timeout: 120000 });
      await page
        .getByRole("region", {
          name: locale === "he" ? "סביבת העבודה שלי" : "My workspace",
        })
        .waitFor();
      assert.equal(await page.locator('a[href="/tickets"]').count(), 0);
      assert.equal(await page.locator('a[href="/inbox"]').count(), 0);
      assert.equal(await page.locator('a[href="/field-service"]').count(), 0);
      await capture("overview");
      if (width <= 390) {
        await page
          .locator('button[aria-controls="workspace-navigation"]')
          .click();
        await capture("navigation");
      }
    } else if (mode === "owner") {
      await page.goto(`${base}/settings/business`, { timeout: 120000 });
      await page
        .getByRole("heading", {
          name: locale === "he" ? "הגדרת העסק" : "Business configuration",
        })
        .waitFor();
      await capture("configuration");
      await page.goto(`${base}/field-service`, { timeout: 120000 });
      await page
        .getByRole("tab", {
          name: locale === "he" ? "רשתות וסניפים" : "Chains & stores",
        })
        .click();
      await page
        .getByText("North branch · סניף צפון", { exact: true })
        .waitFor();
      await capture("directory");
      if (width === 1440 || width === 360) {
        await page.goto(`${base}/tickets`, { timeout: 120000 });
        await page
          .getByRole("heading", {
            name: locale === "he" ? "פניות" : "Tickets",
            exact: true,
          })
          .waitFor();
        await capture("tickets");
      }
      await page.goto(`${base}/field-service/cases/${caseId}`, {
        timeout: 120000,
      });
      await page
        .getByRole("button", {
          name: locale === "he" ? "דוח" : "Report",
          exact: true,
        })
        .click();
      await page
        .getByRole("dialog", {
          name: locale === "he" ? "דוח טכנאי" : "Technician report",
        })
        .waitFor();
      await capture("report");
      if (width <= 390) {
        const finalize = page.getByRole("button", {
          name: locale === "he" ? "סיום וחתימה" : "Finalize report",
        });
        await finalize.scrollIntoViewIfNeeded();
        assert.equal(
          await finalize.isVisible(),
          true,
          "Report actions must be reachable on mobile",
        );
        const bounds = await finalize.boundingBox();
        assert.ok(
          bounds && bounds.y >= 0 && bounds.y + bounds.height <= height,
          "Report completion stays inside the mobile viewport",
        );
        await capture("report-actions");
      }
    } else {
      await page.goto(`${base}/field-service`, { timeout: 120000 });
      await page
        .getByRole("button", {
          name: locale === "he" ? "זמינים לטיפול" : "Available incidents",
        })
        .click();
      await page
        .getByRole("button", {
          name: locale === "he" ? "לקחת לטיפולי" : "Take this incident",
        })
        .first()
        .waitFor();
      if (width <= 390)
        await page
          .getByRole("button", {
            name: locale === "he" ? "לקחת לטיפולי" : "Take this incident",
          })
          .first()
          .scrollIntoViewIfNeeded();
      await capture("queue");
      if (width === 360) {
        await page
          .getByRole("button", { name: "Take this incident" })
          .first()
          .click();
        await page.waitForURL(`${base}/field-service/cases/**`);
        await page
          .getByRole("button", { name: "Report", exact: true })
          .waitFor();
        results.push({
          mode,
          name: "Technician claims incident and opens assigned dossier",
          passed: true,
        });
      }
    }
    assert.deepEqual(errors, [], "Browser runtime errors");
    await context.close();
  }
  await fs.writeFile(
    path.join(out, `${mode}-results.json`),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({ mode, passed: results.length, screenshots: out }),
  );
} finally {
  await browser.close();
}
