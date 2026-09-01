import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
      .filter(
        (line) =>
          line.trim() &&
          !line.trimStart().startsWith("#") &&
          line.includes("="),
      )
      .map((line) => {
        const index = line.indexOf("=");
        const rawValue = line.slice(index + 1).trim();
        const value =
          (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
          (rawValue.startsWith('"') && rawValue.endsWith('"'))
            ? rawValue.slice(1, -1)
            : rawValue;
        return [line.slice(0, index).trim(), value];
      }),
  );
}

const composeLiteralKeys = new Set([
  "AUTH_DUMMY_PASSWORD_HASH",
  "DEV_AUTH_PASSWORD_HASH",
]);

function serialize(key: string, value: string): string {
  // Compose interpolates dollar signs in unquoted dotenv values. Argon2 PHC
  // strings therefore need literal quoting while repository loaders strip it.
  return composeLiteralKeys.has(key) ? `${key}='${value}'` : `${key}=${value}`;
}

function normalizeComposeLiterals(source: string): string {
  return source
    .split(/\r?\n/u)
    .map((line) => {
      const index = line.indexOf("=");
      if (index < 0) return line;
      const key = line.slice(0, index).trim();
      if (!composeLiteralKeys.has(key)) return line;
      const value = parse(line).get(key);
      return value ? serialize(key, value) : line;
    })
    .join("\n");
}

function replaceValue(source: string, key: string, value: string): string {
  const lines = source.split(/\r?\n/u);
  const index = lines.findIndex(
    (line) => line.slice(0, line.indexOf("=")).trim() === key,
  );
  if (index < 0) lines.push(serialize(key, value));
  else lines[index] = serialize(key, value);
  return lines.join("\n");
}

async function main(): Promise<void> {
  let source = await readFile(envPath, "utf8");
  const values = parse(source);
  const additions: string[] = [];
  const ensure = (key: string, value: string) => {
    if (!values.get(key)) {
      values.set(key, value);
      additions.push(serialize(key, value));
    }
  };

  ensure("AUTH_TOKEN_PEPPER", token());
  ensure("AUTH_SERVICE_SECRET", token());
  if (!values.get("AUTH_DUMMY_PASSWORD_HASH")) {
    ensure("AUTH_DUMMY_PASSWORD_HASH", await hashPassword(token(24)));
  }

  const email = values.get("DEV_AUTH_EMAIL") ?? "operator@or-on.local";
  ensure("DEV_AUTH_EMAIL", email);
  let password: string | undefined;
  const rotatePassword = process.argv.includes("--rotate");
  if (rotatePassword) {
    password = token(18);
    const passwordHash = await hashPassword(password);
    values.set("DEV_AUTH_PASSWORD_HASH", passwordHash);
    source = replaceValue(source, "DEV_AUTH_PASSWORD_HASH", passwordHash);
  }
  if (!values.get("DEV_AUTH_PASSWORD_HASH")) {
    password = token(18);
    ensure("DEV_AUTH_PASSWORD_HASH", await hashPassword(password));
  }

  const normalizedSource = normalizeComposeLiterals(source);
  if (rotatePassword || additions.length > 0 || normalizedSource !== source) {
    await writeFile(
      envPath,
      additions.length > 0
        ? `${normalizedSource.trimEnd()}\n\n# Generated local authentication material\n${additions.join("\n")}\n`
        : `${normalizedSource.trimEnd()}\n`,
      "utf8",
    );
  }
  await mkdir(artifactDirectory, { recursive: true });
  let loginArtifactExists = true;
  try {
    await access(loginPath);
  } catch {
    loginArtifactExists = false;
  }
  if (password !== undefined || !loginArtifactExists) {
    const passwordLine =
      password === undefined
        ? "Password unavailable; rotate by clearing DEV_AUTH_PASSWORD_HASH in .env and rerun bootstrap."
        : `Password: ${password}`;
    await writeFile(
      loginPath,
      `Or-On fictional local operator\nEmail: ${email}\n${passwordLine}\n`,
      "utf8",
    );
  }
  await chmod(loginPath, 0o600);
  console.log(
    "Local authentication material is ready in .artifacts/development-login.txt",
  );
}

void main().catch((error: unknown) => {
  console.error("Unable to prepare local authentication material", {
    message: error instanceof Error ? error.message : "unknown error",
  });
  process.exitCode = 1;
});
