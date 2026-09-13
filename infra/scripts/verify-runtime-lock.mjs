// Image-build-only guard: legacy pnpm deploy may resolve a packaging graph, but
// every external runtime package/version must still exist in the reviewed lock.
import { readFileSync, readdirSync, existsSync } from "node:fs";

if (process.cwd() !== "/workspace") {
  throw new Error(
    "Runtime lock verification requires the isolated image build workspace",
  );
}
const locked = readFileSync("pnpm-lock.yaml", "utf8");
const store = "/runtime/node_modules/.pnpm";
let checked = 0;
function inspect(path) {
  if (!existsSync(`${path}/package.json`)) return;
  const manifest = JSON.parse(readFileSync(`${path}/package.json`, "utf8"));
  if (manifest.name.startsWith("@or-on/")) return;
  const identity = `${manifest.name}@${manifest.version}`.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&",
  );
  if (!new RegExp(`^  ['"]?${identity}(?:['"]?:|\\()`, "mu").test(locked)) {
    throw new Error(
      `Runtime package is absent from the reviewed lock: ${manifest.name}@${manifest.version}`,
    );
  }
  checked += 1;
}
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "node_modules") continue;
  const directory = `${store}/${entry.name}/node_modules`;
  for (const child of readdirSync(directory, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const path = `${directory}/${child.name}`;
    if (child.name.startsWith("@")) {
      for (const scoped of readdirSync(path)) inspect(`${path}/${scoped}`);
    } else inspect(path);
  }
}
if (checked === 0)
  throw new Error(
    "Runtime package verification found no external dependencies",
  );
console.log(
  `Verified ${checked} installed external runtime package records against pnpm-lock.yaml`,
);
