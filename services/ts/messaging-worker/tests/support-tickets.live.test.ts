import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  closeTicket,
  listTickets,
  openOrAttachTicket,
  recordTicketEvent,
  reopenTicket,
  setTicketHandlingMode,
} from "@or-on/crm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Explicit opt-in. Creates/drops only its own UUID-named database; no .env reads.
// "live" means real local PostgreSQL — never Meta, a carrier or a telephone.
const sourceUrl = process.env.CROSS_CHANNEL_TEST_DATABASE_URL;
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tenantId = "10000000-0000-4000-8000-000000000001";
const otherTenantId = "10000000-0000-4000-8000-000000000002";
const userId = "20000000-0000-4000-8000-000000000001";

describe.skipIf(sourceUrl === undefined)("support ticket invariant", () => {
  const databaseName = `oron_tickets_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: postgres.Sql;
  let admin: postgres.Sql;
  let web: postgres.Sql;
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    if (sourceUrl === undefined)
      throw new Error("explicit PostgreSQL test URL required");
    const url = new URL(sourceUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("isolated ticket tests require localhost PostgreSQL");
    url.pathname = "/postgres";
    maintenance = postgres(url.toString(), { max: 1 });
    cleanup.push(() => maintenance.end());
    await maintenance.unsafe(`CREATE DATABASE "${databaseName}"`);
    cleanup.push(async () => {
      await maintenance.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    });
    url.pathname = `/${databaseName}`;
    const environment = {
      ...process.env,
      DATABASE_URL: url.toString(),
      ENABLE_REAL_WHATSAPP: "false",
      ENABLE_REAL_TELEPHONY: "false",
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_APP_SECRET: "",
      DEV_AUTH_EMAIL: "operator@or-on.local",
      DEV_AUTH_PASSWORD_HASH: "$argon2id$isolated-test-not-a-login-hash",
    };
    execFileSync(
      "uv",
      ["run", "alembic", "-c", "db/alembic/alembic.ini", "upgrade", "head"],
      { cwd: root, env: environment, stdio: "pipe" },
    );
    execFileSync("uv", ["run", "python", "db/seeds/seed_development.py"], {
      cwd: root,
      env: environment,
      stdio: "pipe",
    });
    admin = postgres(url.toString(), { max: 1 });
    cleanup.push(() => admin.end());
    await admin`
      INSERT INTO public.tenants (id, name, slug, status)
      VALUES (${otherTenantId}::uuid, 'Other fictional tenant',
              ${`other-${databaseName}`}, 'active')
    `;
    url.searchParams.set("options", "-c role=platform_web");
    web = postgres(url.toString(), { max: 2 });
    cleanup.push(() => web.end());
  }, 180_000);

  afterAll(async () => {
    for (const close of cleanup.reverse()) await close();
  });

  async function contact(name: string, tenant = tenantId): Promise<string> {
    const contactId = randomUUID();
    await admin`
      INSERT INTO crm.contacts (id, tenant_id, name)
      VALUES (${contactId}::uuid, ${tenant}::uuid, ${name})
    `;
    return contactId;
  }

  async function scoped<T>(
    work: (tx: postgres.TransactionSql) => Promise<T>,
    tenant = tenantId,
  ): Promise<T> {
    return web.begin(async (tx) => {
      await tx`SELECT set_config('app.current_tenant', ${tenant}, true),
                      set_config('app.current_user', ${userId}, true)`;
      return work(tx);
    }) as Promise<T>;
  }

  it("opens exactly one ticket for a new sender and reuses it for the same issue", async () => {
    const contactId = await contact("Fictional ticket contact");
    const key = `inbound-${randomUUID()}`;

    const first = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Router keeps dropping",
        attachmentKey: key,
      }),
    );

    expect(first.created).toBe(true);
    expect(first.ticket.reference).toMatch(/^T-\d{4}-[0-9A-F]{8}$/u);
    expect(first.ticket.status).toBe("open");
    expect(first.ticket.stage).toBe("new");
    expect(first.ticket.handlingMode).toBe("ai_whatsapp");
    expect(first.ticket.resolutionClassification).toBe("unknown");
  });

  it("does not create a second ticket for a redelivered webhook or a retried job", async () => {
    const contactId = await contact("Fictional duplicate contact");
    const key = `inbound-${randomUUID()}`;
    const open = async () =>
      scoped((tx) =>
        openOrAttachTicket(tx, userId, {
          contactId,
          subject: "Duplicate delivery",
          attachmentKey: key,
        }),
      );

    const first = await open();
    const redelivered = await open();
    // Concurrent workers racing the same admission.
    const [a, b] = await Promise.all([open(), open()]);

    expect(first.created).toBe(true);
    expect(redelivered.created).toBe(false);
    expect(redelivered.ticket.id).toBe(first.ticket.id);
    expect(a.ticket.id).toBe(first.ticket.id);
    expect(b.ticket.id).toBe(first.ticket.id);
    const rows = await admin`
      SELECT count(*)::int AS total FROM support.tickets
      WHERE tenant_id = ${tenantId}::uuid AND contact_id = ${contactId}::uuid
    `;
    expect(rows[0]?.total).toBe(1);
  });

  it("keeps a contact's separate issues apart instead of picking the latest open one", async () => {
    const contactId = await contact("Fictional two-issue contact");

    const billing = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Charged twice",
        attachmentKey: `billing-${randomUUID()}`,
      }),
    );
    const router = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Router dropping",
        attachmentKey: `router-${randomUUID()}`,
      }),
    );

    // Two genuine issues for one contact, and neither swallowed the other.
    expect(router.created).toBe(true);
    expect(router.ticket.id).not.toBe(billing.ticket.id);
  });

  it("refuses to record a resolution that nothing confirms", async () => {
    const contactId = await contact("Fictional unconfirmed contact");
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Says it works now",
        attachmentKey: `resolve-${randomUUID()}`,
      }),
    );

    await expect(
      scoped((tx) =>
        closeTicket(tx, userId, {
          ticketId: opened.ticket.id,
          closureReason: "resolved",
          resolutionClassification: "resolved",
          resolutionConfirmedBy: "none",
          summarySafe: "Model believed it was fixed.",
        }),
      ),
    ).rejects.toThrow(/customer confirmation or authoritative evidence/u);

    const confirmed = await scoped((tx) =>
      closeTicket(tx, userId, {
        ticketId: opened.ticket.id,
        closureReason: "resolved",
        resolutionClassification: "resolved",
        resolutionConfirmedBy: "customer",
        summarySafe: "Customer confirmed the line is stable.",
      }),
    );
    expect(confirmed?.status).toBe("closed");
    expect(confirmed?.stage).toBe("closed");
    expect(confirmed?.closedAt).not.toBeNull();
  });

  it("records an administrative closure without calling it a resolution", async () => {
    const contactId = await contact("Fictional no-response contact");
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "No response after callback",
        attachmentKey: `admin-${randomUUID()}`,
      }),
    );

    const closed = await scoped((tx) =>
      closeTicket(tx, userId, {
        ticketId: opened.ticket.id,
        closureReason: "administrative",
        resolutionClassification: "unresolved",
        resolutionConfirmedBy: "none",
        summarySafe: "Closed after the configured no-response window.",
      }),
    );

    expect(closed?.closureReason).toBe("administrative");
    expect(closed?.resolutionClassification).toBe("unresolved");
  });

  it("reopens the same issue and keeps its earlier timeline", async () => {
    const contactId = await contact("Fictional recurrence contact");
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Fault returned",
        attachmentKey: `reopen-${randomUUID()}`,
      }),
    );
    await scoped((tx) =>
      closeTicket(tx, userId, {
        ticketId: opened.ticket.id,
        closureReason: "resolved",
        resolutionClassification: "resolved",
        resolutionConfirmedBy: "customer",
        summarySafe: "Customer confirmed.",
      }),
    );

    const reopened = await scoped((tx) =>
      reopenTicket(tx, userId, opened.ticket.id, "Same fault returned."),
    );

    expect(reopened?.status).toBe("open");
    expect(reopened?.closureReason).toBeNull();
    // Reopening must not reinstate a stale success claim.
    expect(reopened?.resolutionClassification).toBe("unresolved");
    expect(reopened?.resolutionConfirmedBy).toBe("none");
    const events = await admin`
      SELECT kind FROM support.ticket_events
      WHERE tenant_id = ${tenantId}::uuid AND ticket_id = ${opened.ticket.id}::uuid
      ORDER BY sequence
    `;
    expect(events.map((row) => row.kind as string)).toEqual([
      "opened",
      "status_change",
      "reopened",
    ]);
  });

  it("does not hand a human-owned issue back to the AI implicitly", async () => {
    const contactId = await contact("Fictional takeover contact");
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Escalated issue",
        attachmentKey: `takeover-${randomUUID()}`,
      }),
    );

    const taken = await scoped((tx) =>
      setTicketHandlingMode(
        tx,
        userId,
        opened.ticket.id,
        "human",
        "Agent took the issue over.",
      ),
    );
    const attemptedReturn = await scoped((tx) =>
      setTicketHandlingMode(
        tx,
        userId,
        opened.ticket.id,
        "ai_whatsapp",
        "Customer sent another message.",
      ),
    );

    expect(taken?.handlingMode).toBe("human");
    expect(taken?.stage).toBe("awaiting_human");
    expect(attemptedReturn).toBeUndefined();
  });

  it("allocates timeline sequences without collision under concurrency", async () => {
    const contactId = await contact("Fictional timeline contact");
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Busy timeline",
        attachmentKey: `timeline-${randomUUID()}`,
      }),
    );

    await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        scoped((tx) =>
          recordTicketEvent(tx, userId, {
            ticketId: opened.ticket.id,
            kind: "customer_message",
            actorKind: "customer",
            summarySafe: `Inbound turn ${String(index)}`,
            evidence: { messageIndex: index },
          }),
        ),
      ),
    );

    const rows = await admin`
      SELECT sequence FROM support.ticket_events
      WHERE tenant_id = ${tenantId}::uuid AND ticket_id = ${opened.ticket.id}::uuid
      ORDER BY sequence
    `;
    expect(rows.map((row) => row.sequence as number)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it("never returns another tenant's ticket", async () => {
    const mine = await contact("Fictional tenant A contact");
    const theirs = await contact("Fictional tenant B contact", otherTenantId);
    const ours = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId: mine,
        subject: "Tenant A issue",
        attachmentKey: `iso-a-${randomUUID()}`,
      }),
    );
    const other = await scoped(
      (tx) =>
        openOrAttachTicket(tx, userId, {
          contactId: theirs,
          subject: "Tenant B issue",
          attachmentKey: `iso-b-${randomUUID()}`,
        }),
      otherTenantId,
    );

    const visible = await scoped((tx) => listTickets(tx, { status: "all" }));
    const identifiers = visible.tickets.map((ticket) => ticket.id);

    expect(identifiers).toContain(ours.ticket.id);
    expect(identifiers).not.toContain(other.ticket.id);
  });

  it("pages the queue with a stable keyset instead of shipping the whole tenant", async () => {
    const contactId = await contact("Fictional paging contact");
    for (let index = 0; index < 4; index += 1)
      await scoped((tx) =>
        openOrAttachTicket(tx, userId, {
          contactId,
          subject: `Paged issue ${String(index)}`,
          attachmentKey: `page-${randomUUID()}`,
        }),
      );

    const first = await scoped((tx) => listTickets(tx, { limit: 2 }));
    expect(first.tickets).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const cursor = first.nextCursor;
    if (cursor === null) throw new Error("a second page was expected");
    const second = await scoped((tx) =>
      listTickets(tx, {
        limit: 2,
        beforeActivityAt: cursor.activityAt,
        beforeId: cursor.id,
      }),
    );

    const overlap = second.tickets.filter((ticket) =>
      first.tickets.some((earlier) => earlier.id === ticket.id),
    );
    expect(overlap).toHaveLength(0);
  });

  it("finds a ticket by the phone number the customer quotes", async () => {
    const contactId = await contact("Fictional phone lookup contact");
    await admin`
      INSERT INTO crm.contact_channel_identities
        (tenant_id, contact_id, channel, normalized_value, validation_status)
      VALUES (${tenantId}::uuid, ${contactId}::uuid, 'whatsapp',
              '+972500000123', 'valid')
    `;
    const opened = await scoped((tx) =>
      openOrAttachTicket(tx, userId, {
        contactId,
        subject: "Phone lookup issue",
        attachmentKey: `phone-${randomUUID()}`,
      }),
    );

    const found = await scoped((tx) =>
      listTickets(tx, { status: "all", query: "972500000123" }),
    );

    expect(found.tickets.map((ticket) => ticket.id)).toContain(
      opened.ticket.id,
    );
  });
});
