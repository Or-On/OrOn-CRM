import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";

import { disconnectOAuthProvider } from "../src/features/email";

function sqlFixture(results: readonly unknown[][]) {
  const statements: string[] = [];
  const values: unknown[][] = [];
  let index = 0;
  const query = vi.fn(
    (parts: TemplateStringsArray, ...parameters: readonly unknown[]) => {
      statements.push(parts.join("?"));
      values.push([...parameters]);
      return Promise.resolve(results[index++] ?? []);
    },
  );
  return {
    sql: Object.assign(query, { json: (value: unknown) => value }),
    statements,
    values,
  };
}

describe("OAuth provider disconnect", () => {
  it("revokes channels, tombstones tokens, invalidates pending state and audits", async () => {
    const fixture = sqlFixture([
      [],
      [{ id: "10000000-0000-4000-8000-000000000001" }],
      [{ id: "20000000-0000-4000-8000-000000000001" }],
      [],
      [],
    ]);

    await expect(
      disconnectOAuthProvider(
        fixture.sql as unknown as postgres.TransactionSql,
        "30000000-0000-4000-8000-000000000001",
        "google",
        "fictional-request",
      ),
    ).resolves.toEqual({ channels: 1, credentials: 1 });

    expect(fixture.statements).toHaveLength(5);
    expect(fixture.statements[0]).toContain("pg_advisory_xact_lock");
    expect(fixture.statements[1]).toContain("UPDATE messaging.channels");
    expect(fixture.statements[1]).toContain("credential_id=NULL");
    expect(fixture.statements[2]).toContain(
      "UPDATE platform.credential_records",
    );
    expect(fixture.statements[2]).toContain("ciphertext=NULL");
    expect(fixture.statements[3]).toContain(
      "DELETE FROM platform.oauth_authorizations",
    );
    expect(fixture.statements[4]).toContain("INSERT INTO audit.records");
    expect(fixture.values.flat()).toContain("email_oauth_token_google");
    expect(fixture.values.flat()).toContain("fictional-request");
  });

  it("is idempotent when local access is already disconnected", async () => {
    const fixture = sqlFixture([[], [], [], [], []]);
    await expect(
      disconnectOAuthProvider(
        fixture.sql as unknown as postgres.TransactionSql,
        "30000000-0000-4000-8000-000000000001",
        "microsoft",
        "fictional-replay",
      ),
    ).resolves.toEqual({ channels: 0, credentials: 0 });
  });
});
