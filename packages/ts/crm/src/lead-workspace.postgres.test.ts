import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import type { AgentCapability } from "./agent-capabilities.js";
import {
  createAgentProfileDraft,
  publishAgentProfile,
} from "./cross-channel.js";
import {
  countLeads,
  getLeadDetail,
  LeadWorkspaceConflictError,
  listLeads,
  updateLeadForOperator,
} from "./lead-workspace.js";
import {
  createLeadFieldSchema,
  ensureLeadForInteraction,
  saveLeadFields,
  type LeadBinding,
} from "./leads.js";

const databaseUrl = process.env.CRM_TEST_DATABASE_URL;

const coordinatorFields = [
  {
    key: "preferred_name",
    label: "Preferred name",
    type: "text",
    required: true,
  },
  { key: "company", label: "Company", type: "text", required: true },
  {
    key: "service",
    label: "Requested service",
    type: "choice",
    required: true,
    choices: ["CRM", "Telephony", "Automation"],
  },
  { key: "budget", label: "Budget", type: "currency", required: false },
];

interface Fixture {
  readonly tenantId: string;
  readonly userId: string;
  readonly secondUserId: string;
  readonly contactId: string;
  readonly otherContactId: string;
  readonly conversationId: string;
  readonly agentVersionId: string;
  readonly schemaId: string;
  readonly schemaVersion: number;
}

function ownedDatabase() {
  if (databaseUrl === undefined)
    throw new Error("CRM_TEST_DATABASE_URL is required");
  const target = new URL(databaseUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/oron_ui_preview_[a-f0-9]+$/u.test(target.pathname)
  )
    throw new Error("Only owned fictional databases are permitted");
  return postgres(databaseUrl, { max: 4, prepare: false });
}

async function runtimeContext(
  sql: postgres.TransactionSql,
  fixture: Pick<Fixture, "tenantId" | "userId">,
) {
  await sql.unsafe("SET LOCAL ROLE platform_web");
  await sql`SET LOCAL lock_timeout = '2s'`;
  await sql`SET LOCAL statement_timeout = '10s'`;
  await sql`
    SELECT set_config('app.current_tenant', ${fixture.tenantId}, true),
           set_config('app.current_user', ${fixture.userId}, true),
           set_config('app.current_role', 'owner', true)
  `;
}

async function withTenant<T>(
  database: postgres.Sql,
  fixture: Pick<Fixture, "tenantId" | "userId">,
  run: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return database.begin(async (sql) => {
    await runtimeContext(sql, fixture);
    return run(sql);
  }) as Promise<T>;
}

async function insertContact(
  sql: postgres.TransactionSql,
  userId: string,
  name: string,
  phone: string,
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.contacts(tenant_id,created_by_user_id,name)
    VALUES(platform.current_tenant_id(),${userId}::uuid,${name})
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("fixture contact unavailable");
  await sql`
    INSERT INTO crm.contact_channel_identities(
      tenant_id,contact_id,channel,normalized_value,display_value,is_primary
    ) VALUES(
      platform.current_tenant_id(),${id}::uuid,'phone',${phone},${phone},true
    )
  `;
  return id;
}

async function createFixture(database: postgres.Sql): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const secondUserId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  return database.begin(async (sql) => {
    await sql`
      INSERT INTO tenants(id,name,slug,status)
      VALUES(${tenantId}::uuid,'Fictional lead workspace tenant',
             ${`leadui-${suffix}`},'active')
    `;
    await sql`
      INSERT INTO users(id,email,display_name,status) VALUES
        (${userId}::uuid,${`leadui-${suffix}@example.invalid`},
         'Fictional workspace owner','active'),
        (${secondUserId}::uuid,${`leadui2-${suffix}@example.invalid`},
         'Fictional second reviewer','active')
    `;
    await sql`
      INSERT INTO memberships(tenant_id,user_id,role) VALUES
        (${tenantId}::uuid,${userId}::uuid,'owner'),
        (${tenantId}::uuid,${secondUserId}::uuid,'agent')
    `;
    await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${tenantId}::uuid)`;
    await runtimeContext(sql, { tenantId, userId });
    const schema = await createLeadFieldSchema(sql, userId, {
      name: `Fictional workspace schema ${suffix}`,
      definition: coordinatorFields,
    });
    const profileId = await createAgentProfileDraft(sql, userId, {
      name: `Fictional workspace coordinator ${suffix}`,
      systemPrompt: "Fictional lead coordinator for workspace tests.",
      channels: ["voice", "whatsapp"],
      toolPermissions: ["lead.read", "lead.write", "lead.finalize"],
      leadFieldSchemaId: schema.id,
    });
    if (!(await publishAgentProfile(sql, userId, profileId)))
      throw new Error("fixture agent could not be published");
    const versions = await sql<{ id: string }[]>`
      SELECT id FROM agents.agent_profile_versions
      WHERE agent_profile_id=${profileId}::uuid ORDER BY version DESC LIMIT 1
    `;
    const agentVersionId = versions[0]?.id;
    if (agentVersionId === undefined)
      throw new Error("fixture agent version unavailable");
    const contactId = await insertContact(
      sql,
      userId,
      "Fictional workspace contact",
      "+972500000111",
    );
    const otherContactId = await insertContact(
      sql,
      userId,
      "Fictional second contact",
      "+972500000222",
    );
    const channels = await sql<{ id: string }[]>`
      INSERT INTO messaging.channels(
        tenant_id,kind,provider,provider_account_id,status
      ) VALUES(
        platform.current_tenant_id(),'whatsapp','simulator',${`leadui-${suffix}`},
        'active'
      )
      RETURNING id
    `;
    const channelId = channels[0]?.id;
    if (channelId === undefined) throw new Error("fixture channel unavailable");
    const conversations = await sql<{ id: string }[]>`
      INSERT INTO messaging.conversations(
        tenant_id,channel_id,contact_id,status,ownership_mode,
        ai_agent_profile_version_id,ai_enabled_by_user_id,ai_enabled_at
      ) VALUES(
        platform.current_tenant_id(),${channelId}::uuid,${contactId}::uuid,'open',
        'ai',${agentVersionId}::uuid,${userId}::uuid,CURRENT_TIMESTAMP
      )
      RETURNING id
    `;
    const conversationId = conversations[0]?.id;
    if (conversationId === undefined)
      throw new Error("fixture conversation unavailable");
    return {
      tenantId,
      userId,
      secondUserId,
      contactId,
      otherContactId,
      conversationId,
      agentVersionId,
      schemaId: schema.id,
      schemaVersion: schema.version,
    };
  });
}

function binding(
  fixture: Fixture,
  overrides: Partial<LeadBinding> = {},
): LeadBinding {
  return {
    contactId: fixture.contactId,
    sourceChannel: "whatsapp",
    capabilities: [
      "lead.read",
      "lead.write",
      "lead.finalize",
    ] as AgentCapability[],
    actorUserId: fixture.userId,
    recordedBy: "agent",
    agentProfileVersionId: fixture.agentVersionId,
    conversationId: fixture.conversationId,
    ...overrides,
  };
}

async function openLead(
  database: postgres.Sql,
  fixture: Fixture,
  overrides: {
    readonly interestKey?: string;
    readonly contactId?: string;
    readonly objective?: string;
    readonly pinSchema?: boolean;
    readonly sourceChannel?: LeadBinding["sourceChannel"];
  } = {},
): Promise<string> {
  const base = binding(fixture, {
    ...(overrides.contactId === undefined
      ? {}
      : { contactId: overrides.contactId }),
    ...(overrides.sourceChannel === undefined
      ? {}
      : { sourceChannel: overrides.sourceChannel }),
  });
  // A voice lead is written from a live call for the same contact, and has no
  // WhatsApp conversation to fence against.
  const { conversationId, ...withoutConversation } = base;
  const voiceBinding: LeadBinding =
    conversationId === undefined ? base : withoutConversation;
  let leadBinding: LeadBinding = base;
  if (overrides.sourceChannel === "voice") {
    const sessionId = randomUUID();
    await database`
      INSERT INTO public.sessions
        (session_id, tenant_id, contact_id, provider, direction, room, status, flow_id)
      VALUES (${sessionId}::uuid, ${fixture.tenantId}::uuid,
              ${voiceBinding.contactId}::uuid, 'livekit', 'outbound',
              ${`workspace-call-${sessionId}`}, 'started', ${randomUUID()}::uuid)
    `;
    leadBinding = { ...voiceBinding, sessionId };
  }
  return withTenant(database, fixture, async (sql) => {
    const result = await ensureLeadForInteraction(sql, leadBinding, {
      operationKey: `workspace-open-${randomUUID()}`,
      businessObjective: overrides.objective ?? "Business software enquiry",
      interestKey: overrides.interestKey ?? `interest-${randomUUID()}`,
      ...(overrides.pinSchema === false
        ? {}
        : {
            fieldSchemaId: fixture.schemaId,
            fieldSchemaVersion: fixture.schemaVersion,
          }),
    });
    return result.lead.id;
  });
}

describe.skipIf(databaseUrl === undefined)(
  "lead workspace on PostgreSQL",
  () => {
    it("counts exactly the rows it lists, under every filter", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const whatsappA = await openLead(database, fixture, {
          objective: "Telephony rollout",
        });
        const whatsappB = await openLead(database, fixture, {
          objective: "Automation review",
        });
        const voice = await openLead(database, fixture, {
          contactId: fixture.otherContactId,
          sourceChannel: "voice",
          objective: "Telephony rollout",
        });
        const rejected = await openLead(database, fixture, {
          objective: "Automation review",
        });
        await withTenant(database, fixture, async (sql) => {
          await updateLeadForOperator(sql, fixture.userId, whatsappB, {
            ownerUserId: fixture.secondUserId,
            status: "qualified",
          });
          await updateLeadForOperator(sql, fixture.userId, rejected, {
            status: "disqualified",
          });
        });

        const cases = [
          {},
          { status: "all" as const },
          { status: "qualified" as const },
          { sourceChannel: "voice" as const },
          { ownerUserId: fixture.secondUserId },
          { unassigned: true },
          { query: "Telephony" },
          { query: "972500000222" },
          { contactId: fixture.otherContactId },
          { agentProfileVersionId: fixture.agentVersionId },
        ];
        for (const filter of cases) {
          const [page, counts] = await withTenant(database, fixture, (sql) =>
            Promise.all([
              listLeads(sql, { ...filter, limit: 100 }),
              countLeads(sql, filter),
            ]),
          );
          expect(
            { filter, rows: page.leads.length },
            `count must match rows for ${JSON.stringify(filter)}`,
          ).toEqual({ filter, rows: counts.total });
        }

        const open = await withTenant(database, fixture, (sql) =>
          listLeads(sql, { limit: 100 }),
        );
        // A qualified lead still needs converting, so it stays in the queue.
        // A disqualified one is finished with, so it leaves.
        expect(open.leads.map((lead) => lead.id).sort()).toEqual(
          [whatsappA, whatsappB, voice].sort(),
        );
        const byStatus = await withTenant(database, fixture, (sql) =>
          countLeads(sql, { status: "qualified" }),
        );
        // The breakdown drops the status predicate and keeps every other one.
        expect(byStatus.total).toBe(1);
        expect(byStatus.byStatus.qualified).toBe(1);
        expect(byStatus.byStatus.disqualified).toBe(1);
        expect(byStatus.byStatus.collecting).toBe(2);
      } finally {
        await database.end();
      }
    });

    it("pages by keyset without repeating or skipping a lead", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const created: string[] = [];
        for (let index = 0; index < 5; index += 1)
          created.push(
            await openLead(database, fixture, {
              objective: `Enquiry ${String(index)}`,
            }),
          );
        const seen: string[] = [];
        let cursor: { sortAt: string; id: string } | null = null;
        for (let page = 0; page < 5; page += 1) {
          const result: Awaited<ReturnType<typeof listLeads>> =
            await withTenant(database, fixture, (sql) =>
              listLeads(sql, {
                limit: 2,
                ...(cursor === null
                  ? {}
                  : { beforeSortAt: cursor.sortAt, beforeId: cursor.id }),
              }),
            );
          seen.push(...result.leads.map((lead) => lead.id));
          cursor = result.nextCursor;
          if (cursor === null) break;
        }
        expect(seen.length).toBe(created.length);
        expect(new Set(seen).size).toBe(created.length);
        expect([...seen].sort()).toEqual([...created].sort());
      } finally {
        await database.end();
      }
    });

    it("reports completeness from the pinned schema, not from answers alone", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        await withTenant(database, fixture, (sql) =>
          saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey: `workspace-save-${randomUUID()}`,
            observations: [
              {
                key: "preferred_name",
                state: "known",
                value: "דנה",
                confirmation: "customer_confirmed",
              },
              { key: "budget", state: "declined" },
            ],
          }),
        );
        const page = await withTenant(database, fixture, (sql) =>
          listLeads(sql, { limit: 10 }),
        );
        const entry = page.leads.find((lead) => lead.id === leadId);
        expect(entry?.completeness).toMatchObject({
          required: ["preferred_name", "company", "service"],
          satisfied: ["preferred_name"],
          missing: ["company", "service"],
          complete: false,
        });
        expect(entry?.agentVersion).toBe(1);
        expect(entry?.fieldSchemaVersion).toBe(fixture.schemaVersion);

        const detail = await withTenant(database, fixture, (sql) =>
          getLeadDetail(sql, leadId),
        );
        // Every reviewed question is listed, answered or not: hiding the
        // unanswered ones would hide the work still to do.
        expect(detail?.fields.map((field) => field.key)).toEqual([
          "preferred_name",
          "company",
          "service",
          "budget",
        ]);
        const declined = detail?.fields.find((field) => field.key === "budget");
        expect(declined?.state).toBe("declined");
        expect(declined?.normalizedValue).toBeNull();
        const unanswered = detail?.fields.find(
          (field) => field.key === "company",
        );
        expect(unanswered?.state).toBeNull();
        expect(unanswered?.required).toBe(true);
        expect(detail?.contact.primaryPhone).toBe("+972500000111");
        expect(detail?.interaction.conversationId).toBe(fixture.conversationId);
        // No call session is attached, so nothing claims a recording exists.
        expect(detail?.calls).toEqual([]);
      } finally {
        await database.end();
      }
    });

    it("keeps an operator edit audited, revision-checked and out of the field record", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const before = await withTenant(database, fixture, (sql) =>
          getLeadDetail(sql, leadId),
        );
        const revision = before?.lead.revision ?? 0;
        const updated = await withTenant(database, fixture, (sql) =>
          updateLeadForOperator(sql, fixture.userId, leadId, {
            status: "ready_for_review",
            ownerUserId: fixture.secondUserId,
            nextAction: "Call back on Sunday",
            expectedRevision: revision,
          }),
        );
        expect(updated.status).toBe("ready_for_review");
        expect(updated.revision).toBe(revision + 1);

        await expect(
          withTenant(database, fixture, (sql) =>
            updateLeadForOperator(sql, fixture.userId, leadId, {
              status: "qualified",
              expectedRevision: revision,
            }),
          ),
        ).rejects.toBeInstanceOf(LeadWorkspaceConflictError);

        const detail = await withTenant(database, fixture, (sql) =>
          getLeadDetail(sql, leadId),
        );
        expect(detail?.lead.ownerUserId).toBe(fixture.secondUserId);
        expect(detail?.lead.ownerName).toBe("Fictional second reviewer");
        expect(detail?.lead.nextAction).toBe("Call back on Sunday");
        // The operator moved the lead; they did not put words in the customer's
        // mouth, so no collected field was touched.
        expect(detail?.history).toEqual([]);
        const actions = (detail?.audit ?? []).map((entry) => entry.action);
        expect(actions).toContain("lead.operator_updated");
        expect(actions).toContain("lead.created");
        const record = detail?.audit.find(
          (entry) => entry.action === "lead.operator_updated",
        );
        expect(record?.actorName).toBe("Fictional workspace owner");
        expect(record?.metadata).toMatchObject({
          fromStatus: "collecting",
          toStatus: "ready_for_review",
        });
        // Only the transition is recorded. Customer content stays in the lead.
        expect(JSON.stringify(record?.metadata)).not.toContain("Sunday");
      } finally {
        await database.end();
      }
    });

    it("refuses to show or edit another tenant's lead", async () => {
      const database = ownedDatabase();
      try {
        const first = await createFixture(database);
        const second = await createFixture(database);
        const leadId = await openLead(database, first);
        const detail = await withTenant(database, second, (sql) =>
          getLeadDetail(sql, leadId),
        );
        expect(detail).toBeUndefined();
        const page = await withTenant(database, second, (sql) =>
          listLeads(sql, { status: "all", limit: 100 }),
        );
        expect(page.leads.map((lead) => lead.id)).not.toContain(leadId);
        await expect(
          withTenant(database, second, (sql) =>
            updateLeadForOperator(sql, second.userId, leadId, {
              status: "disqualified",
            }),
          ),
        ).rejects.toThrow(/lead not found/u);
      } finally {
        await database.end();
      }
    });

    it("sorts by follow-up date with undated leads last and stops paging there", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const dated = await openLead(database, fixture, { objective: "Dated" });
        const undated = await openLead(database, fixture, {
          objective: "Undated",
        });
        await withTenant(database, fixture, (sql) =>
          updateLeadForOperator(sql, fixture.userId, dated, {
            nextAction: "Follow up",
            nextActionDueAt: "2026-10-01T09:00:00.000Z",
          }),
        );
        const page = await withTenant(database, fixture, (sql) =>
          listLeads(sql, { sort: "due", limit: 10 }),
        );
        expect(page.leads[0]?.id).toBe(dated);
        expect(page.leads.map((lead) => lead.id)).toContain(undated);
        expect(page.nextCursor).toBeNull();
      } finally {
        await database.end();
      }
    });
  },
);
