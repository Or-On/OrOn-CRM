import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { hashPassword } from "../packages/ts/auth/src/crypto.js";

const root = process.cwd();
const envPath = resolve(root, ".env");
const artifactDirectory = resolve(root, ".artifacts");
const loginPath = resolve(artifactDirectory, "development-login.txt");

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function parse(source: string): Map<string, string> {
  return new Map(
    source
      .split(/\r?\n/u)
      .filter((line) => line.trim() && !line.trimStart().startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

async function main(): Promise<void> {
  const source = await readFile(envPath, "utf8");
  const values = parse(source);
  const additions: string[] = [];
  const ensure = (key: string, value: string) => {
    if (!values.get(key)) {
      values.set(key, value);
      additions.push(`${key}=${value}`);
    }
  };

  ensure("AUTH_TOKEN_PEPPER", token());
  ensure("AUTH_SERVICE_SECRET", token());
  if (!values.get("AUTH_DUMMY_PASSWORD_HASH")) {
    ensure("AUTH_DUMMY_PASSWORD_HASH", await hashPassword(token(24)));
  }

  const email = values.get("DEV_AUTH_EMAIL") || "operator@or-on.local";
  ensure("DEV_AUTH_EMAIL", email);
  let password: string | undefined;
  if (!values.get("DEV_AUTH_PASSWORD_HASH")) {
    password = token(18);
    ensure("DEV_AUTH_PASSWORD_HASH", await hashPassword(password));
  }

  if (additions.length > 0) {
    await writeFile(envPath, `${source.trimEnd()}\n\n# Generated local authentication material\n${additions.join("\n")}\n`, "utf8");
  }
  await mkdir(artifactDirectory, { recursive: true });
  const existing = password === undefined
    ? "Password unchanged; rotate by clearing DEV_AUTH_PASSWORD_HASH in .env and rerun bootstrap."
    : `Password: ${password}`;
  await writeFile(loginPath, `Or-On fictional local operator\nEmail: ${email}\n${existing}\n`, "utf8");
  await chmod(loginPath, 0o600);
  console.log("Local authentication material is ready in .artifacts/development-login.txt");
}

void main().catch((error: unknown) => {
  console.error("Unable to prepare local authentication material", {
    message: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
});
