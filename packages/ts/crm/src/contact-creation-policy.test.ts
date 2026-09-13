import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { createContact, importContacts } from "./contacts.js";

const contactId = "10000000-0000-4000-8000-000000000099";
const actorId = "20000000-0000-4000-8000-000000000099";

function transaction(duplicate = false, failInsertion?: Error) {
  const statements: string[] = [];
  let insertions = 0;
  const execute = vi.fn((parts: TemplateStringsArray) => {
    const statement = parts.join("?");
    statements.push(statement);
    if (statement.includes("SELECT EXISTS"))
      return Promise.resolve([{ found: duplicate }]);
    if (statement.includes("INSERT INTO crm.contacts")) {
      insertions++;
      if (insertions === 2 && failInsertion)
        return Promise.reject(failInsertion);
      return Promise.resolve([{ id: contactId }]);
    }
    return Promise.resolve([]);
  });
  const unsafe = vi.fn().mockResolvedValue([
    {
      id: contactId,
      name: "Fictional new contact",
      email: "new@example.invalid",
      company: null,
      lifecycle_status: "active",
      voice_consent: "granted",
      whatsapp_consent: "granted",
      whatsapp_opted_out_at: null,
      last_activity_at: null,
      created_at: new Date("2026-09-10T00:00:00Z"),
      identities: [],
      tags: [],
    },
  ]);
  const sql = Object.assign(execute, {
    unsafe,
  }) as unknown as postgres.TransactionSql;
  const savepoint = vi.fn(
    async (work: (rowSql: postgres.TransactionSql) => Promise<unknown>) =>
      work(sql),
  );
  Object.assign(sql, { savepoint });
  // Orchestration only: real rollback behavior is covered by the PostgreSQL suite.
  return {
    sql,
    statements,
    execute,
    unsafe,
    savepoint,
  };
}

describe("prospective contact permission policy (no network)", () => {
  it("isolates every imported row and counts only successful savepoints", async () => {
    const failure = Object.assign(new Error("private database row detail"), {
      code: "23514",
    });
    const fixture = transaction(false, failure);
    expect(
      await importContacts(fixture.sql, actorId, [
        { name: "Fictional first" },
        { name: "Fictional rejected" },
        { name: "Fictional last" },
      ]),
    ).toEqual({
      created: 2,
      skipped: 0,
      errors: [{ row: 3, reason: "Contact data is invalid" }],
    });
    expect(fixture.savepoint).toHaveBeenCalledTimes(3);
  });

  it.each(["42501", "08006", "40P01"])(
    "does not disguise an infrastructure failure (%s) as partial success",
    async (code) => {
      const failure = Object.assign(new Error("private connection detail"), {
        code,
      });
      const fixture = transaction(false, failure);
      await expect(
        importContacts(fixture.sql, actorId, [
          { name: "Fictional first" },
          { name: "Fictional failed" },
          { name: "Must not run" },
        ]),
      ).rejects.toBe(failure);
      expect(fixture.savepoint).toHaveBeenCalledTimes(2);
    },
  );
  it.each([actorId, null])(
    "rejects manual or API creation of any matching existing recipient before granting (%s)",
    async (actor) => {
      const fixture = transaction(true);
      await expect(
        createContact(fixture.sql, actor, {
          name: "Attempted shadow of restricted contact",
          phone: "+12025550199",
          email: "Existing@Example.Invalid",
        }),
      ).rejects.toMatchObject({ code: "23505" });
      expect(fixture.statements).toHaveLength(1);
      expect(fixture.statements[0]).toContain(
        "identity.channel IN ('phone', 'whatsapp')",
      );
      expect(fixture.statements[0]).toContain("identity.channel = 'email'");
      expect(fixture.statements[0]).not.toMatch(
        /INSERT|UPDATE|DELETE|lifecycle_status|voice_consent|whatsapp_consent/,
      );
      expect(fixture.unsafe).not.toHaveBeenCalled();
    },
  );

  it("inserts granted permissions for a newly created contact, never with an UPDATE", async () => {
    const fixture = transaction();
    const contact = await createContact(fixture.sql, actorId, {
      name: "Fictional new contact",
      email: "new@example.invalid",
    });
    expect(contact).toMatchObject({
      voiceConsent: "granted",
      whatsAppConsent: "granted",
      whatsAppOptedOutAt: null,
    });
    const insertion = fixture.statements.find((statement) =>
      statement.includes("INSERT INTO crm.contacts"),
    );
    expect(insertion).toContain("voice_consent, whatsapp_consent");
    expect(insertion).toMatch(/'granted',\s*'granted'/);
    expect(
      fixture.statements.some((statement) =>
        statement.includes("UPDATE crm.contacts"),
      ),
    ).toBe(false);
  });

  it("applies the same creation policy to genuinely new CSV rows", async () => {
    const fixture = transaction();
    expect(
      await importContacts(fixture.sql, actorId, [
        { name: "Fictional new contact", phone: "+12025550199" },
      ]),
    ).toEqual({ created: 1, skipped: 0, errors: [] });
    expect(
      fixture.statements.some(
        (statement) =>
          statement.includes("voice_consent, whatsapp_consent") &&
          statement.includes("'granted'"),
      ),
    ).toBe(true);
  });

  it.each(["unknown", "revoked", "opted-out"])(
    "skips an existing %s contact without writing permissions or opt-out state",
    async () => {
      const fixture = transaction(true);
      expect(
        await importContacts(fixture.sql, actorId, [
          {
            name: "Existing fictional contact",
            phone: "+12025550199",
            email: "existing@example.invalid",
          },
        ]),
      ).toEqual({ created: 0, skipped: 1, errors: [] });
      expect(fixture.statements).toHaveLength(1);
      expect(fixture.statements[0]).toContain("SELECT EXISTS");
      expect(fixture.statements[0]).not.toMatch(/INSERT|UPDATE|DELETE/);
      expect(fixture.unsafe).not.toHaveBeenCalled();
    },
  );
});
