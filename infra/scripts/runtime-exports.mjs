// Image-build-only packaging: runtime Node must not strip TypeScript in node_modules.
// Never run against a developer checkout. Source manifests remain untouched there.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

if (process.cwd() !== "/workspace") {
  throw new Error("Runtime export preparation is restricted to the image build workspace");
}
for (const name of ["config", "observability", "platform-integration"]) {
  const root = `packages/ts/${name}`;
  if (!existsSync(`${root}/dist/index.js`)) throw new Error(`Build ${name} first`);
  const path = `${root}/package.json`;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.exports = { ".": "./dist/index.js" };
  manifest.files = ["dist"];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}
for (const root of ["packages/ts/auth", "packages/ts/crm", "services/ts/messaging-worker"]) {
  const path = `${root}/package.json`;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.files = ["dist"];
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}
