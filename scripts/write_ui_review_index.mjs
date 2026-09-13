/** Generate an index from recorded screenshots, never inferred screenshots. */
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const evidence = path.join(root, ".artifacts/brand-rebuild");
const observations = JSON.parse(
  await fs.readFile(path.join(evidence, "final/observations.json"), "utf8"),
);
const baseline = new Set(await fs.readdir(path.join(evidence, "baseline")));
const files = new Set(await fs.readdir(path.join(evidence, "final")));
if (
  observations.length !== 540 ||
  observations.some((item) => !files.has(item.file))
)
  throw new Error("The full540-capture matrix must exist before indexing");
const issues = observations.filter(
  (item) =>
    item.pageWidth > item.viewport ||
    item.h1 !== 1 ||
    item.errors.length ||
    item.failedResponses?.length,
);
const names = [
  ...new Set(
    observations.map((item) =>
      item.file.replace(/-\d+-(en|he)-(light|dark)\.png$/, ""),
    ),
  ),
];
const link = (phase, name, width, locale, theme) => {
  const file = `${name}-${width}-${locale}-${theme}.png`;
  return (phase === "baseline" ? baseline : files).has(file)
    ? `[${phase === "baseline" ? "Before" : "After"}](${phase}/${file})`
    : "Not captured";
};
const lines = [
  "# Or-On UI review",
  "",
  `Recorded evidence: ${observations.length} route/view captures across 1440, 1024, 768, 390, 360px × English/Hebrew × light/dark. Chromium1234. ${issues.length} recorded geometry/heading/browser-response exceptions; see observations.json for exact details.`,
  "",
  "Screenshot build IDs are recorded per row. The complete matrix was captured before the final two scoped CSS fixes; all six Settings views and call detail were then recaptured across all20 scenarios. Unaffected route screenshots are retained from that full run.",
  "",
  "The preview is fictional and isolated; screenshots do not represent customer or production data. Browser interaction evidence and environment/performance limits are in the execution report.",
  "",
  "[Live fictional preview](http://127.0.0.1:3101/fictional-preview) · [Execution report](../../docs/plans/or-on-product-experience-2026-09-10.md) · [Full capture observations](final/observations.json)",
  "",
  "## Before and after",
  "",
  "| Route/view |1440 EN/light before|1440 EN/light after|390 HE/dark before|390 HE/dark after|",
  "|---|---|---|---|---|",
  ...names.map(
    (name) =>
      `|${name}|${link("baseline", name, 1440, "en", "light")}|${link("final", name, 1440, "en", "light")}|${link("baseline", name, 390, "he", "dark")}|${link("final", name, 390, "he", "dark")}|`,
  ),
  "",
  "## Interaction evidence",
  "",
  "- [Primary workflows](interaction-primary.json)",
  "- [Voice, orchestration and health](interaction-voice.json)",
  "- [Overview and Settings](interaction-workspace.json)",
  "- [Shared composed controls](composed-controls/observations.json)",
  "",
  "## Complete screenshot matrix",
  "",
  ...names.flatMap((name) => [
    "### " + name,
    "",
    ...observations
      .filter(
        (item) =>
          item.file.replace(/-\d+-(en|he)-(light|dark)\.png$/, "") === name,
      )
      .map(
        (item) =>
          `- [${item.width}px ${item.locale} ${item.theme}](final/${item.file})`,
      ),
    "",
  ]),
];
await fs.writeFile(path.join(evidence, "UI-REVIEW.md"), lines.join("\n"));
console.log(
  `Indexed ${names.length} surfaces / ${observations.length} captures; ${issues.length} recorded exceptions.`,
);
