/** Evidence-derived tenant rebuild review. Never changes the preceding rebuild. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const surfaces = [
  "overview",
  "inbox-list",
  "contacts",
  "pipeline",
  "messaging-campaigns",
  "messaging-automations",
  "messaging-history",
  "voice",
  "voice-numbers",
  "voice-campaigns",
  "voice-flows",
  "orchestration-agents",
  "orchestration-flows",
  "orchestration-activity",
  "orchestration-handoffs",
  "health",
  "settings-account",
  "settings-appearance",
  "settings-security",
  "settings-workspace",
  "settings-team",
  "settings-notifications",
  "settings-access",
  "settings-integrations",
  "start",
  "not-found",
  "fixture-contact",
  "fixture-conversation",
  "fixture-call",
  "login",
  "invite",
];
const widths = [1440, 1024, 768, 390, 360];
export const scenarios = widths.flatMap((width) =>
  ["en", "he"].flatMap((locale) =>
    ["light", "dark"].map((theme) => ({ width, locale, theme })),
  ),
);
const fileName = (surface, { width, locale, theme }) =>
  `${surface}-${width}-${locale}-${theme}.png`;
const expected = new Map(
  surfaces.flatMap((surface) =>
    scenarios.map((scenario) => [
      fileName(surface, scenario),
      { surface, ...scenario },
    ]),
  ),
);

/** Pure validation: complete cross-product, unique rows, typed observations and build provenance. */
export function analyze(observations, currentBuildId) {
  assert.ok(
    Array.isArray(observations),
    "Capture observations must be an array",
  );
  assert.equal(
    observations.length,
    expected.size,
    `Expected ${surfaces.length} surfaces × ${scenarios.length} scenarios = ${expected.size} captures; no review is written for partial coverage`,
  );
  const byFile = new Map();
  const builds = new Set();
  const issues = {
    runtime: [],
    overflow: [],
    server: [],
    headings: [],
    direction: [],
    theme: [],
  };
  let runtimeEvents = 0;
  let serverEvents = 0;
  for (const item of observations) {
    assert.ok(item && typeof item === "object", "Invalid capture row");
    const planned = expected.get(item.file);
    assert.ok(
      planned,
      `Unexpected or unsafe screenshot name: ${String(item.file)}`,
    );
    assert.ok(!byFile.has(item.file), `Duplicate capture: ${item.file}`);
    assert.equal(
      item.width,
      planned.width,
      `Width metadata mismatch: ${item.file}`,
    );
    assert.equal(
      item.locale,
      planned.locale,
      `Locale metadata mismatch: ${item.file}`,
    );
    assert.equal(
      item.height,
      planned.width === 1440 ? 900 : 844,
      `Viewport height mismatch: ${item.file}`,
    );
    assert.ok(
      ["light", "dark"].includes(item.theme),
      `Missing observed theme: ${item.file}`,
    );
    assert.ok(
      Number.isFinite(item.pageWidth) && item.pageWidth > 0,
      `Invalid document width: ${item.file}`,
    );
    assert.equal(
      item.viewport,
      planned.width,
      `Viewport width mismatch: ${item.file}`,
    );
    assert.ok(
      Number.isInteger(item.h1) && item.h1 >= 0,
      `Missing heading observation: ${item.file}`,
    );
    assert.ok(
      typeof item.route === "string" && item.route.startsWith("/"),
      `Invalid route metadata: ${item.file}`,
    );
    assert.ok(
      Array.isArray(item.errors) &&
        item.errors.every((error) => typeof error === "string"),
      `Missing runtime observations: ${item.file}`,
    );
    assert.ok(
      Array.isArray(item.failedResponses) &&
        item.failedResponses.every(
          (response) =>
            typeof response?.path === "string" &&
            Number.isInteger(response.status) &&
            response.status >= 500 &&
            response.status <= 599,
        ),
      `Missing or invalid 5xx observations: ${item.file}`,
    );
    assert.ok(
      typeof item.buildId === "string" &&
        /^[A-Za-z0-9_-]+$/u.test(item.buildId),
      `Missing build ID: ${item.file}`,
    );
    builds.add(item.buildId);
    byFile.set(item.file, item);
    if (item.errors.length) issues.runtime.push(item.file);
    if (item.pageWidth > item.viewport) issues.overflow.push(item.file);
    if (item.failedResponses.length) issues.server.push(item.file);
    if (item.h1 !== 1) issues.headings.push(item.file);
    if (item.direction !== (planned.locale === "he" ? "rtl" : "ltr"))
      issues.direction.push(item.file);
    if (item.theme !== planned.theme) issues.theme.push(item.file);
    runtimeEvents += item.errors.length;
    serverEvents += item.failedResponses.length;
  }
  for (const file of expected.keys())
    assert.ok(byFile.has(file), `Missing capture: ${file}`);
  assert.equal(
    builds.size,
    1,
    "Mixed screenshot builds are not a final capture matrix",
  );
  const buildId = [...builds][0];
  assert.equal(
    buildId,
    currentBuildId,
    "Captures do not match the current completed production build",
  );
  return {
    byFile,
    buildId,
    issues,
    runtimeEvents,
    serverEvents,
    affected: new Set(Object.values(issues).flat()).size,
  };
}

export function summarizeInteraction(data) {
  const summary = {
    passed: 0,
    failed: 0,
    skipped: 0,
    runtimeEvents: 0,
    buildIds: new Set(),
    observations: 0,
  };
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    if (typeof value.name === "string") summary.observations += 1;
    if (value.passed === true) summary.passed += 1;
    if (value.passed === false) summary.failed += 1;
    if (value.skipped) summary.skipped += 1;
    if (typeof value.buildId === "string") summary.buildIds.add(value.buildId);
    for (const [key, nested] of Object.entries(value)) {
      if (["errors", "runtimeErrors"].includes(key) && Array.isArray(nested))
        summary.runtimeEvents += nested.length;
      visit(nested);
    }
  };
  visit(data);
  return summary;
}

async function interactionLines(evidence, buildId) {
  const entries = [
    ["Primary workflows", "interaction-primary.json"],
    ["Voice, messaging and orchestration", "interaction-voice-operations.json"],
    ["Settings", "settings/interaction-settings.json"],
    ["Overview and health", "overview-health/observations.json"],
  ];
  const lines = [];
  for (const [label, file] of entries) {
    let content;
    try {
      content = await fs.readFile(path.join(evidence, file), "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      lines.push(`- ${label}: evidence not present; no result inferred.`);
      continue;
    }
    const report = summarizeInteraction(JSON.parse(content));
    const provenance =
      report.buildIds.size === 0
        ? "Build ID not recorded; final-build equivalence is not inferred."
        : report.buildIds.size === 1 && report.buildIds.has(buildId)
          ? "Recorded build matches the capture matrix."
          : `Recorded build ID(s): ${[...report.buildIds].join(", ")}; not all match the capture matrix.`;
    lines.push(
      `- [${label}](${file}): ${report.passed} explicit passes, ${report.failed} explicit failures, ${report.skipped} skips, ${report.runtimeEvents} recorded runtime errors; ${report.observations} named observations. ${provenance}`,
    );
  }
  return lines;
}

function selfTest() {
  const build = "fictional-self-test";
  const rows = [...expected.entries()].map(([file, scenario]) => ({
    file,
    width: scenario.width,
    height: scenario.width === 1440 ? 900 : 844,
    locale: scenario.locale,
    theme: scenario.theme,
    viewport: scenario.width,
    pageWidth: scenario.width,
    h1: 1,
    route: "/fictional",
    errors: [],
    failedResponses: [],
    direction: scenario.locale === "he" ? "rtl" : "ltr",
    buildId: build,
  }));
  assert.equal(analyze(rows, build).affected, 0);
  assert.throws(() => analyze(rows.slice(1), build), /partial coverage/u);
  assert.throws(
    () => analyze([rows[0], ...rows.slice(0, -1)], build),
    /Duplicate/u,
  );
  assert.throws(
    () =>
      analyze(
        [{ ...rows[0], buildId: "other-build" }, ...rows.slice(1)],
        build,
      ),
    /Mixed/u,
  );
  assert.throws(() => analyze(rows, "other-build"), /current completed/u);
  assert.throws(
    () => analyze([{ ...rows[0], errors: undefined }, ...rows.slice(1)], build),
    /runtime observations/u,
  );
  assert.throws(
    () =>
      analyze(
        [{ ...rows[0], file: "../outside.png" }, ...rows.slice(1)],
        build,
      ),
    /unsafe/u,
  );
  const flagged = analyze(
    [
      {
        ...rows[0],
        pageWidth: 1441,
        h1: 0,
        direction: "rtl",
        theme: "dark",
        errors: ["Fictional runtime error"],
        failedResponses: [{ path: "/fictional", status: 503 }],
      },
      ...rows.slice(1),
    ],
    build,
  );
  assert.equal(flagged.affected, 1);
  assert.equal(flagged.runtimeEvents, 1);
  assert.equal(flagged.serverEvents, 1);
  assert.ok(Object.values(flagged.issues).every((files) => files.length === 1));
  const interaction = summarizeInteraction({
    scenarios: [
      {
        checks: [
          { name: "pass", passed: true },
          { name: "fail", passed: false },
          { name: "skip", skipped: "not covered" },
        ],
        runtimeErrors: ["fictional"],
      },
    ],
  });
  assert.equal(interaction.passed, 1);
  assert.equal(interaction.failed, 1);
  assert.equal(interaction.skipped, 1);
  assert.equal(interaction.runtimeEvents, 1);
  assert.equal(
    summarizeInteraction([{ name: "recorded but not a pass" }]).passed,
    0,
  );
  console.log("Review-index self-tests passed; no artifacts written.");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--self-test") return selfTest();
  assert.ok(
    ["--check", "--write"].includes(mode),
    "Use --check (read-only), --write (complete final evidence only), or --self-test",
  );
  const root = path.resolve(import.meta.dirname, "..");
  const evidence = path.join(root, ".artifacts/tenant-saas-rebuild");
  const finalDirectory = path.join(evidence, "final");
  const observationFile = path.join(finalDirectory, "observations.json");
  const buildFile = path.join(root, "apps/web/.next/BUILD_ID");
  const input = await fs.readFile(observationFile, "utf8");
  const currentBuildId = (await fs.readFile(buildFile, "utf8")).trim();
  const observations = JSON.parse(input);
  const analysis = analyze(observations, currentBuildId);
  for (const file of analysis.byFile.keys()) {
    const info = await fs.stat(path.join(finalDirectory, file));
    assert.ok(
      info.isFile() && info.size > 0,
      `Missing or empty screenshot: ${file}`,
    );
  }
  if (mode === "--check") {
    console.log(
      `Verified ${surfaces.length} surfaces × ${scenarios.length} scenarios / ${observations.length} nonempty screenshots, build ${analysis.buildId}; ${analysis.affected} captures have recorded exceptions. No artifacts written.`,
    );
    if (analysis.affected) process.exitCode = 1;
    return;
  }
  const beforeDirectory = path.join(root, ".artifacts/brand-rebuild/final");
  const beforeFiles = new Set(await fs.readdir(beforeDirectory));
  const link = (phase, surface, scenario) => {
    const file = fileName(surface, scenario);
    if (phase === "before" && !beforeFiles.has(file))
      return "New / no previous capture";
    return `[${phase === "before" ? "Before" : "After"}](${phase === "before" ? "../brand-rebuild/final" : "final"}/${file})`;
  };
  const desktop = { width: 1440, locale: "en", theme: "light" };
  const mobile = { width: 390, locale: "he", theme: "dark" };
  const lines = [
    "# Or-On tenant UI review",
    "",
    `Generated from the recorded [final capture observations](final/observations.json). Verified ${surfaces.length} surfaces × ${scenarios.length} scenarios = ${observations.length} unique, nonempty screenshots on one completed production build: \`${analysis.buildId}\`.`,
    "",
    "Scenarios: 1440 × 900, 1024 × 844, 768 × 844, 390 × 844 and 360 × 844 CSS pixels; English/Hebrew × light/dark. The capture harness disables animations. Functional and reduced-motion checks are separate evidence below.",
    "",
    "## Recorded capture checks",
    "",
    "| Observation | Affected captures | Recorded events |",
    "|---|---:|---:|",
    `| Runtime / console errors | ${analysis.issues.runtime.length} | ${analysis.runtimeEvents} |`,
    `| Document overflow | ${analysis.issues.overflow.length} | — |`,
    `| HTTP 5xx responses | ${analysis.issues.server.length} | ${analysis.serverEvents} |`,
    `| Visible main H1 count other than one | ${analysis.issues.headings.length} | — |`,
    `| Incorrect reading direction | ${analysis.issues.direction.length} | — |`,
    `| Observed theme differs from requested theme | ${analysis.issues.theme.length} | — |`,
    "",
    analysis.affected === 0
      ? "The complete capture matrix has no recorded exceptions in these checks. This is not a blanket claim that every application behavior was tested."
      : `${analysis.affected} unique captures have recorded exceptions. Do not treat the matrix as accepted; inspect the observations linked below.`,
    "",
    ...Object.entries(analysis.issues)
      .filter(([, files]) => files.length)
      .flatMap(([kind, files]) => [
        `- ${kind}: ${files.map((file) => `[${file}](final/${file})`).join(", ")}`,
        "",
      ]),
    "## Before and after",
    "",
    "Before links refer to the preceding brand rebuild's final captures, which remain unchanged. New / no previous capture denotes missing prior visual evidence, not necessarily newly added business functionality.",
    "",
    "| Surface | 1440 EN/light before | 1440 EN/light after | 390 HE/dark before | 390 HE/dark after |",
    "|---|---|---|---|---|",
    ...surfaces.map(
      (surface) =>
        `| ${surface} | ${link("before", surface, desktop)} | ${link("after", surface, desktop)} | ${link("before", surface, mobile)} | ${link("after", surface, mobile)} |`,
    ),
    "",
    "## Interaction evidence",
    "",
    "The following summaries use explicit recorded pass/fail flags only. Assertion traces without such flags are listed as observations, not inferred passes. These records have their own coverage and build provenance; snapshot completion does not upgrade them to final-build acceptance.",
    "",
    ...(await interactionLines(evidence, analysis.buildId)),
    "",
    "## Complete screenshot matrix",
    "",
    ...surfaces.flatMap((surface) => [
      `### ${surface}`,
      "",
      ...widths.map(
        (width) =>
          `- ${width}px: ${scenarios
            .filter((scenario) => scenario.width === width)
            .map(
              (scenario) =>
                `[${scenario.locale.toUpperCase()} / ${scenario.theme}](final/${fileName(surface, scenario)})`,
            )
            .join(" · ")}`,
      ),
      "",
    ]),
    "## Evidence limits",
    "",
    "These captures use an isolated fictional preview, not customer or production records. The capture observations establish geometry, direction, theme, heading and browser-response outcomes; they do not establish provider readiness, end-to-end real delivery, billing accuracy, production uptime or exhaustive accessibility compliance. See each interaction record for its intercepted mutations and tested scope.",
    "",
  ];
  assert.equal(
    await fs.readFile(observationFile, "utf8"),
    input,
    "Capture observations changed while indexing; retry after completion",
  );
  assert.equal(
    (await fs.readFile(buildFile, "utf8")).trim(),
    currentBuildId,
    "Production build changed while indexing; retry after completion",
  );
  await fs.writeFile(path.join(evidence, "UI-REVIEW.md"), lines.join("\n"));
  console.log(
    `Wrote only .artifacts/tenant-saas-rebuild/UI-REVIEW.md: ${observations.length} captures, ${analysis.affected} recorded exceptions.`,
  );
  if (analysis.affected) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  await main();
