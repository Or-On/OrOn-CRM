/** Browser-level form/picker checks using an explicitly supplied test runtime. */
/* global CSS, document, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
if (!process.env.PLAYWRIGHT_MODULE)
  throw new Error("Supply the existing Playwright test runtime path");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const css = await readFile(resolve("packages/ts/ui/src/styles.css"), "utf8");
const output = resolve(".artifacts/brand-rebuild/control-contracts");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const observations = [];
try {
  for (const width of [390, 768, 1440]) {
    for (const direction of ["ltr", "rtl"]) {
      for (const theme of ["light", "dark"]) {
        const page = await browser.newPage({
          viewport: { width, height: 844 },
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setContent(`<!doctype html><html dir="${direction}" data-theme="${theme}"><head><style>${css}</style></head>
          <body style="margin:0;background:var(--or-bg);color:var(--or-text);font:14px system-ui">
          <form style="position:fixed;inset-inline-end:16px;bottom:16px;width:320px">
          <label for="fixture">${direction === "rtl" ? "בחירת תפקיד לדוגמה" : "Fictional role selector"}</label>
          <select id="fixture" name="role" class="or-select"><option value="a">Atlas — fictional preview</option>
          <option value="b">Bloom — fictional preview</option><option value="c">תפקיד ארוך בעברית לצורך בדיקת תפריט</option>
          <option value="disabled" disabled>Unavailable — fictional preview</option></select>
          </form></body></html>`);
        assert.equal(
          await page.evaluate(() => CSS.supports("appearance", "base-select")),
          true,
        );
        const select = page.locator("#fixture");
        await select.click();
        await page.waitForFunction(
          () =>
            getComputedStyle(
              document.querySelector("select"),
              "::picker(select)",
            ).opacity === "1",
        );
        await page.screenshot({
          path: `${output}/native-picker-${width}-${direction}-${theme}.png`,
        });
        const geometry = await page.evaluate(() => {
          const option = document.querySelector("option");
          const select = document.querySelector("select");
          const bounds = option.getBoundingClientRect();
          return {
            optionLeft: bounds.left,
            optionRight: bounds.right,
            optionTop: bounds.top,
            optionBottom: bounds.bottom,
            controlHeight: select.getBoundingClientRect().height,
            pickerBackground: getComputedStyle(select, "::picker(select)")
              .backgroundColor,
            pageWidth: document.documentElement.scrollWidth,
            viewport: innerWidth,
          };
        });
        assert.ok(
          geometry.optionLeft >= 0 && geometry.optionRight <= width,
          "picker stays inside inline viewport",
        );
        assert.ok(
          geometry.optionTop >= 0 && geometry.optionBottom <= 844,
          "picker flips inside block viewport",
        );
        assert.equal(geometry.pageWidth, width);
        if (width === 390) assert.ok(geometry.controlHeight >= 44);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        assert.equal(await select.inputValue(), "b");
        await select.click();
        await page.keyboard.press("Escape");
        assert.equal(
          await select.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
        );
        assert.deepEqual(errors, []);
        observations.push({ width, direction, theme, ...geometry, errors });
        await page.close();
      }
    }
  }
  await writeFile(
    `${output}/observations.json`,
    JSON.stringify(observations, null, 2),
  );
  console.log(
    `PASS ${observations.length} native-picker browser variants: keyboard, Escape/focus, RTL, themes, collision and compact targets.`,
  );
} finally {
  await browser.close();
}
