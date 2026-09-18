import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it } from "vitest";

import type { AgentCapability } from "./agent-capabilities.js";
import {
  createAgentProfileDraft,
  createAgentProfileRevision,
  listAgentProfiles,
  publishAgentProfile,
  rebindAgentConversations,
} from "./cross-channel.js";
import { parseLeadFieldSchema } from "./lead-schema.js";
import { executeLeadTool, leadToolDescriptors } from "./lead-tools.js";
import { getLeadDetail } from "./lead-workspace.js";
import {
  createLeadFieldSchema,
  ensureLeadForInteraction,
  finalizeLeadCollection,
  findInteractionLead,
  LeadAuthorizationError,
  LeadNotFoundError,
  LeadOwnershipError,
  LeadRevisionConflictError,
  readLeadOperation,
  readLeadState,
  requestLeadFollowUp,
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
  { key: "seats", label: "Users", type: "number", required: false, minimum: 1 },
  { key: "budget", label: "Budget", type: "currency", required: false },
];

interface Fixture {
  readonly tenantId: string;
  readonly userId: string;
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
  role:
    "platform_web" | "platform_messaging" | "platform_voice" = "platform_web",
) {
  await sql.unsafe(`SET LOCAL ROLE ${role}`);
  await sql`SET LOCAL lock_timeout = '2s'`;
  await sql`SET LOCAL statement_timeout = '10s'`;
  await sql`
    SELECT set_config('app.current_tenant', ${fixture.tenantId}, true),
           set_config('app.current_user', ${fixture.userId}, true),
           set_config('app.current_role', 'owner', true)
  `;
}

/** Every assertion reads through the same tenant-scoped runtime role the
 * application uses, so row-level security is exercised rather than sidestepped. */
async function withTenant<T>(
  database: postgres.Sql,
  fixture: Fixture,
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
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO crm.contacts(tenant_id,created_by_user_id,name)
    VALUES(platform.current_tenant_id(),${userId}::uuid,${name})
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("fixture contact unavailable");
  return id;
}

async function createFixture(database: postgres.Sql): Promise<Fixture> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const suffix = randomUUID().replaceAll("-", "");
  return database.begin(async (sql) => {
    await sql`
      INSERT INTO tenants(id,name,slug,status)
      VALUES(${tenantId}::uuid,'Fictional lead tenant',${`lead-${suffix}`},'active')
    `;
    await sql`
      INSERT INTO users(id,email,display_name,status)
      VALUES(${userId}::uuid,${`lead-${suffix}@example.invalid`},
             'Fictional lead owner','active')
    `;
    await sql`
      INSERT INTO memberships(tenant_id,user_id,role)
      VALUES(${tenantId}::uuid,${userId}::uuid,'owner')
    `;
    await sql`INSERT INTO crm.tenant_settings(tenant_id) VALUES(${tenantId}::uuid)`;
    await runtimeContext(sql, { tenantId, userId });
    const schema = await createLeadFieldSchema(sql, userId, {
      name: `Fictional coordinator schema ${suffix}`,
      definition: coordinatorFields,
    });
    // Author the agent through the real drafting and publication path so the
    // capability grant under test is the one an operator would actually create.
    const profileId = await createAgentProfileDraft(sql, userId, {
      name: `Fictional lead coordinator ${suffix}`,
      systemPrompt: "Fictional Hebrew lead coordinator for automated tests.",
      channels: ["voice", "whatsapp"],
      toolPermissions: [
        "lead.read",
        "lead.write",
        "lead.finalize",
        "lead.follow_up",
      ],
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
      "Fictional lead contact",
    );
    const otherContactId = await insertContact(
      sql,
      userId,
      "Fictional other contact",
    );
    const channels = await sql<{ id: string }[]>`
      INSERT INTO messaging.channels(
        tenant_id,kind,provider,provider_account_id,status
      ) VALUES(
        platform.current_tenant_id(),'whatsapp','simulator',${`lead-${suffix}`},
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
      contactId,
      otherContactId,
      conversationId,
      agentVersionId,
      schemaId: schema.id,
      schemaVersion: schema.version,
    };
  });
}

/** A live call for the fixture contact, as the dispatcher would admit it. */
async function startCall(
  database: postgres.Sql,
  fixture: Fixture,
  contactId: string = fixture.contactId,
): Promise<string> {
  const sessionId = randomUUID();
  await database`
    INSERT INTO public.sessions
      (session_id, tenant_id, contact_id, provider, direction, room, status, flow_id)
    VALUES (${sessionId}::uuid, ${fixture.tenantId}::uuid, ${contactId}::uuid,
            'livekit', 'outbound', ${`lead-call-${sessionId}`}, 'started',
            ${randomUUID()}::uuid)
  `;
  return sessionId;
}

/**
 * A secured callback for the fixture conversation, as the dispatcher admits
 * it: a handoff, the admission record naming the conversation, and identity
 * verification already unlocked (verification is tested on its own).
 */
async function startCallback(
  database: postgres.Sql,
  fixture: Fixture,
): Promise<{ readonly sessionId: string; readonly handoffId: string }> {
  const handoffs = await database<{ id: string }[]>`
    INSERT INTO automation.handoffs
      (tenant_id, contact_id, conversation_id, source_channel, reason_safe,
       idempotency_key)
    VALUES (${fixture.tenantId}::uuid, ${fixture.contactId}::uuid,
            ${fixture.conversationId}::uuid, 'whatsapp', 'Secure voice continuation',
            ${`lead-callback-${randomUUID()}`})
    RETURNING id
  `;
  const handoffId = handoffs[0]?.id;
  if (handoffId === undefined) throw new Error("fixture handoff unavailable");
  const sessionId = await startCall(database, fixture);
  await database`
    INSERT INTO public.session_events (tenant_id, session_id, sequence, event_type, payload)
    VALUES (${fixture.tenantId}::uuid, ${sessionId}::uuid, 0, 'voice.call.admission.v1',
            ${database.json({
              source_conversation_id: fixture.conversationId,
              handoff_id: handoffId,
            })})
  `;
  await database.begin(async (sql) => {
    await sql`SELECT set_config('app.current_tenant', ${fixture.tenantId}, true)`;
    await sql`
      SELECT platform.initialize_voice_identity_verification(
        ${sessionId}::uuid, ${handoffId}::uuid)
    `;
    await sql`
      UPDATE automation.voice_identity_verifications
      SET state='context_unlocked', verified_at=clock_timestamp(),
          context_unlocked_at=clock_timestamp()
      WHERE tenant_id=${fixture.tenantId}::uuid AND session_id=${sessionId}::uuid
    `;
  });
  return { sessionId, handoffId };
}

/** Publish another fictional agent through the real authoring path. */
async function publishAgent(
  database: postgres.Sql,
  fixture: Fixture,
  toolPermissions: readonly AgentCapability[],
): Promise<string> {
  return database.begin(async (sql) => {
    await runtimeContext(sql, fixture);
    const profileId = await createAgentProfileDraft(sql, fixture.userId, {
      name: `Fictional agent ${randomUUID()}`,
      systemPrompt: "Fictional agent for automated tests.",
      channels: ["voice", "whatsapp"],
      toolPermissions: [...toolPermissions],
      ...(toolPermissions.length === 0
        ? {}
        : { leadFieldSchemaId: fixture.schemaId }),
    });
    if (!(await publishAgentProfile(sql, fixture.userId, profileId)))
      throw new Error("fixture agent could not be published");
    const versions = await sql<{ id: string }[]>`
      SELECT id FROM agents.agent_profile_versions
      WHERE agent_profile_id=${profileId}::uuid ORDER BY version DESC LIMIT 1
    `;
    const id = versions[0]?.id;
    if (id === undefined) throw new Error("fixture agent version unavailable");
    return id;
  });
}

function voiceBinding(
  fixture: Fixture,
  sessionId: string,
  overrides: Partial<LeadBinding> = {},
): LeadBinding {
  return {
    contactId: fixture.contactId,
    sourceChannel: "voice",
    capabilities: [
      "lead.read",
      "lead.write",
      "lead.finalize",
      "lead.follow_up",
    ],
    recordedBy: "agent",
    agentProfileVersionId: fixture.agentVersionId,
    sessionId,
    normalization: { phoneRegion: "IL" },
    ...overrides,
  };
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
      "lead.follow_up",
    ] as AgentCapability[],
    actorUserId: fixture.userId,
    recordedBy: "agent",
    agentProfileVersionId: fixture.agentVersionId,
    conversationId: fixture.conversationId,
    normalization: { phoneRegion: "IL" },
    ...overrides,
  };
}

async function openLead(
  database: postgres.Sql,
  fixture: Fixture,
  overrides: {
    readonly interestKey?: string;
    readonly operationKey?: string;
  } = {},
): Promise<string> {
  return database.begin(async (sql) => {
    await runtimeContext(sql, fixture);
    const result = await ensureLeadForInteraction(sql, binding(fixture), {
      operationKey: overrides.operationKey ?? `lead-open-${randomUUID()}`,
      businessObjective: "Business software enquiry",
      interestKey: overrides.interestKey ?? `crm-${randomUUID()}`,
      fieldSchemaId: fixture.schemaId,
      fieldSchemaVersion: fixture.schemaVersion,
    });
    return result.lead.id;
  });
}

describe.skipIf(databaseUrl === undefined)("lead capture on PostgreSQL", () => {
  it("creates, saves, reads back and finalizes a lead under platform_web", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      const saved = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return saveLeadFields(sql, binding(fixture), {
          leadId,
          operationKey: `lead-save-${randomUUID()}`,
          observations: [
            {
              key: "preferred_name",
              state: "known",
              value: "דנה",
              confirmation: "customer_confirmed",
            },
            { key: "company", state: "known", value: "Fictional Ltd" },
            { key: "service", state: "known", value: "crm" },
            { key: "budget", state: "declined" },
          ],
        });
      });
      expect(saved.receipt).toMatchObject({
        leadId,
        operation: "lead.save_fields",
        status: "committed",
      });
      expect(saved.receipt.reference).toMatch(/^LD-[0-9A-F]{8}$/u);
      expect([...saved.receipt.changed].sort()).toEqual([
        "budget",
        "company",
        "preferred_name",
        "service",
      ]);
      // Budget is optional, so declining it neither blocks completeness nor
      // counts as a required-field refusal.
      expect(saved.lead.completeness).toMatchObject({
        required: ["preferred_name", "company", "service"],
        missing: [],
        declined: [],
        complete: true,
      });
      expect(
        saved.lead.fields.find((field) => field.key === "budget"),
      ).toMatchObject({ state: "declined", rawValue: null });
      const readBack = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return readLeadState(sql, binding(fixture), leadId);
      });
      expect(
        readBack.fields.find((field) => field.key === "service")
          ?.normalizedValue,
      ).toBe("CRM");
      const finalized = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return finalizeLeadCollection(sql, binding(fixture), {
          leadId,
          operationKey: `lead-final-${randomUUID()}`,
          summary: "Wants CRM for a ten-person team.",
          nextAction: "Call back Sunday morning.",
        });
      });
      // Collection completeness is not sales qualification.
      expect(finalized.lead.status).toBe("ready_for_review");
      expect(finalized.receipt.revision).toBeGreaterThan(
        saved.receipt.revision,
      );
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("replays a repeated delivery instead of writing the lead twice", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      const operationKey = `lead-save-${randomUUID()}`;
      const save = async () =>
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey,
            observations: [
              { key: "company", state: "known", value: "Fictional Ltd" },
            ],
          });
        });
      const first = await save();
      const second = await save();
      expect(first.receipt.status).toBe("committed");
      expect(second.receipt.status).toBe("replayed");
      expect(second.receipt.revision).toBe(first.receipt.revision);
      expect(
        await withTenant(
          database,
          fixture,
          async (sql) => sql<{ count: string }[]>`
            SELECT count(*)::text FROM crm.lead_field_values
            WHERE lead_id=${leadId}::uuid AND field_key='company'
          `,
        ),
      ).toEqual([{ count: "1" }]);
      // A caller with an unknown commit result can reconcile before rewriting.
      const reconciled = await withTenant(database, fixture, async (sql) =>
        readLeadOperation(sql, binding(fixture), operationKey),
      );
      expect(reconciled).toMatchObject({ leadId, status: "replayed" });
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("returns the same lead for a replayed create and a repeated interest", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const operationKey = `lead-open-${randomUUID()}`;
      const interestKey = `crm-${randomUUID()}`;
      const first = await openLead(database, fixture, {
        interestKey,
        operationKey,
      });
      const replayed = await openLead(database, fixture, {
        interestKey,
        operationKey,
      });
      expect(replayed).toBe(first);
      const sameInterest = await openLead(database, fixture, { interestKey });
      expect(sameInterest).toBe(first);
      // A different commercial interest for the same person stays distinct.
      const other = await openLead(database, fixture, {
        interestKey: `telephony-${randomUUID()}`,
      });
      expect(other).not.toBe(first);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("keeps a human correction safe from a later agent extraction", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return saveLeadFields(
          sql,
          binding(fixture, { recordedBy: "human", sourceChannel: "manual" }),
          {
            leadId,
            operationKey: `lead-human-${randomUUID()}`,
            observations: [
              {
                key: "company",
                state: "known",
                value: "Corrected Fictional Ltd",
                confirmation: "human_verified",
              },
            ],
          },
        );
      });
      const stale = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return saveLeadFields(sql, binding(fixture), {
          leadId,
          operationKey: `lead-stale-${randomUUID()}`,
          observations: [
            { key: "company", state: "known", value: "Misheard Ltd" },
            { key: "preferred_name", state: "known", value: "דנה" },
          ],
        });
      });
      expect(stale.rejected).toEqual([
        {
          key: "company",
          code: "human_verified",
          reason: "a person has verified this value",
        },
      ]);
      expect(stale.receipt.changed).toEqual(["preferred_name"]);
      expect(
        stale.lead.fields.find((field) => field.key === "company")
          ?.normalizedValue,
      ).toBe("Corrected Fictional Ltd");
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("supersedes a correction while preserving the earlier observation", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      for (const value of ["Fictional Ltd", "Fictional Holdings Ltd"])
        await database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey: `lead-save-${randomUUID()}`,
            observations: [{ key: "company", state: "known", value }],
          });
        });
      const history = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return readLeadState(sql, binding(fixture), leadId, { history: true });
      });
      const company = history.fields.filter((field) => field.key === "company");
      expect(company).toHaveLength(2);
      expect(company.filter((field) => field.supersededAt === null)).toEqual([
        expect.objectContaining({ normalizedValue: "Fictional Holdings Ltd" }),
      ]);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("rejects a write from an agent whose conversation a person has taken over", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      const epochs = await withTenant(
        database,
        fixture,
        async (sql) => sql<{ ownership_epoch: string }[]>`
          SELECT ownership_epoch::text FROM messaging.conversations
          WHERE id=${fixture.conversationId}::uuid
        `,
      );
      const epoch = epochs[0]?.ownership_epoch;
      if (epoch === undefined)
        throw new Error("conversation epoch unavailable");
      await withTenant(
        database,
        fixture,
        async (sql) => sql`
          UPDATE messaging.conversations
          SET ownership_mode='human', ownership_epoch=ownership_epoch + 1,
              ai_agent_profile_version_id=NULL
          WHERE id=${fixture.conversationId}::uuid
        `,
      );
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(
            sql,
            binding(fixture, { conversationOwnershipEpoch: epoch }),
            {
              leadId,
              operationKey: `lead-fenced-${randomUUID()}`,
              observations: [
                { key: "company", state: "known", value: "Too late Ltd" },
              ],
            },
          );
        }),
      ).rejects.toBeInstanceOf(LeadOwnershipError);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("refuses a stale revision rather than overwriting a newer edit", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      const first = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return saveLeadFields(sql, binding(fixture), {
          leadId,
          operationKey: `lead-save-${randomUUID()}`,
          observations: [
            { key: "company", state: "known", value: "First Ltd" },
          ],
        });
      });
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey: `lead-save-${randomUUID()}`,
            expectedRevision: first.receipt.revision - 1,
            observations: [
              { key: "company", state: "known", value: "Stale Ltd" },
            ],
          });
        }),
      ).rejects.toBeInstanceOf(LeadRevisionConflictError);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("denies a lead write to an agent without the capability", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return ensureLeadForInteraction(
            sql,
            binding(fixture, { capabilities: ["lead.read"] }),
            {
              operationKey: `lead-denied-${randomUUID()}`,
              fieldSchemaId: fixture.schemaId,
              fieldSchemaVersion: fixture.schemaVersion,
            },
          );
        }),
      ).rejects.toMatchObject({ name: "CapabilityDeniedError" });
      expect(
        await withTenant(
          database,
          fixture,
          async (sql) =>
            sql<{ count: string }[]>`SELECT count(*)::text FROM crm.leads`,
        ),
      ).toEqual([{ count: "0" }]);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("hides another contact's lead from this interaction", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return readLeadState(
            sql,
            binding(fixture, { contactId: fixture.otherContactId }),
            leadId,
          );
        }),
      ).rejects.toBeInstanceOf(LeadNotFoundError);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("isolates leads across tenants under row-level security", async () => {
    const database = ownedDatabase();
    try {
      const first = await createFixture(database);
      const second = await createFixture(database);
      const leadId = await openLead(database, first);
      const visible = await withTenant(
        database,
        second,
        async (sql) => sql<{ id: string }[]>`
          SELECT id FROM crm.leads WHERE id=${leadId}::uuid
        `,
      );
      expect(visible).toEqual([]);
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, second);
          return readLeadState(
            sql,
            { contactId: first.contactId, capabilities: ["lead.read"] },
            leadId,
          );
        }),
      ).rejects.toBeInstanceOf(LeadNotFoundError);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("lets the least-privileged voice role save and finalize a lead", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const voice = voiceBinding(fixture, await startCall(database, fixture));
      const result = await database.begin(async (sql) => {
        await runtimeContext(sql, fixture, "platform_voice");
        const opened = await ensureLeadForInteraction(sql, voice, {
          operationKey: `voice-open-${randomUUID()}`,
          fieldSchemaId: fixture.schemaId,
          fieldSchemaVersion: fixture.schemaVersion,
        });
        const saved = await saveLeadFields(sql, voice, {
          leadId: opened.lead.id,
          operationKey: `voice-save-${randomUUID()}`,
          observations: [
            {
              key: "seats",
              state: "known",
              value: "12",
              sourceReferenceId: "turn-17",
            },
            { key: "budget", state: "known", value: "1200", currency: "ILS" },
          ],
        });
        return requestLeadFollowUp(sql, voice, {
          leadId: opened.lead.id,
          operationKey: `voice-followup-${randomUUID()}`,
          note: "Customer asked for a human call back.",
        }).then((followUp) => ({ saved, followUp }));
      });
      expect(result.saved.lead.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "budget",
            normalizedValue: "1200.00",
            currency: "ILS",
            sourceChannel: "voice",
          }),
          expect.objectContaining({
            key: "seats",
            sourceReferenceId: "turn-17",
          }),
        ]),
      );
      expect(result.followUp.lead.nextAction).toBe(
        "Customer asked for a human call back.",
      );
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("rejects a field the reviewed schema does not contain", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      await expect(
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey: `lead-bad-${randomUUID()}`,
            observations: [
              { key: "national_id", state: "known", value: "123456789" },
            ],
          });
        }),
      ).rejects.toMatchObject({ name: "LeadFieldValidationError" });
      expect(
        await withTenant(
          database,
          fixture,
          async (sql) => sql<{ count: string }[]>`
            SELECT count(*)::text FROM crm.lead_field_values
            WHERE lead_id=${leadId}::uuid
          `,
        ),
      ).toEqual([{ count: "0" }]);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("serializes two concurrent writers on the same lead", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      const write = async (value: string) =>
        database.begin(async (sql) => {
          await runtimeContext(sql, fixture);
          return saveLeadFields(sql, binding(fixture), {
            leadId,
            operationKey: `lead-race-${randomUUID()}`,
            observations: [{ key: "company", state: "known", value }],
          });
        });
      const [first, second] = await Promise.all([
        write("Racer A Ltd"),
        write("Racer B Ltd"),
      ]);
      expect(
        new Set([first.receipt.revision, second.receipt.revision]).size,
      ).toBe(2);
      expect(
        await withTenant(
          database,
          fixture,
          async (sql) => sql<{ count: string }[]>`
            SELECT count(*)::text FROM crm.lead_field_values
            WHERE lead_id=${leadId}::uuid AND field_key='company'
              AND superseded_at IS NULL
          `,
        ),
      ).toEqual([{ count: "1" }]);
    } finally {
      await database.end({ timeout: 2 });
    }
  });

  it("records an audit entry for every committed lead action", async () => {
    const database = ownedDatabase();
    try {
      const fixture = await createFixture(database);
      const leadId = await openLead(database, fixture);
      await database.begin(async (sql) => {
        await runtimeContext(sql, fixture);
        return saveLeadFields(sql, binding(fixture), {
          leadId,
          operationKey: `lead-audit-${randomUUID()}`,
          observations: [
            { key: "company", state: "known", value: "Audited Ltd" },
          ],
        });
      });
      const records = await withTenant(
        database,
        fixture,
        async (sql) => sql<{ action: string }[]>`
          SELECT action FROM audit.records
          WHERE target_type='lead' AND target_id=${leadId}::uuid
          ORDER BY occurred_at ASC
        `,
      );
      expect(records.map((record) => record.action)).toEqual([
        "lead.created",
        "lead.fields_saved",
      ]);
    } finally {
      await database.end({ timeout: 2 });
    }
  });
});

describe.skipIf(databaseUrl === undefined)(
  "lead tools against PostgreSQL",
  () => {
    const schema = parseLeadFieldSchema(coordinatorFields);

    function toolContext(fixture: Fixture, leadId: string, turnKey: string) {
      return {
        leadId,
        interactionKey: fixture.conversationId,
        turnKey,
        schema,
      };
    }

    it("saves what the customer gave and reports what is still missing", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const result = await withTenant(database, fixture, async (sql) =>
          executeLeadTool(
            sql,
            binding(fixture),
            toolContext(fixture, leadId, "message-1"),
            "lead_save_fields",
            {
              observations: [
                {
                  key: "preferred_name",
                  state: "known",
                  value: "דנה",
                  confirmed: true,
                  sourceReference: "message-1",
                },
                { key: "service", state: "known", value: "Automation" },
              ],
            },
          ),
        );
        expect(result.receipt?.leadId).toBe(leadId);
        expect(result.missingRequired).toEqual(["company"]);
        expect(result.collected).toEqual(
          expect.arrayContaining([
            { key: "preferred_name", state: "known", value: "דנה" },
            { key: "service", state: "known", value: "Automation" },
          ]),
        );
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("recognises its own committed write after a worker restart", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const call = async () =>
          withTenant(database, fixture, async (sql) =>
            executeLeadTool(
              sql,
              binding(fixture),
              // A restarted worker rebuilds this context from durable facts, so
              // the operation key is the same one the first attempt used.
              toolContext(fixture, leadId, "message-7"),
              "lead_save_fields",
              {
                observations: [
                  { key: "company", state: "known", value: "Fictional Ltd" },
                ],
              },
            ),
          );
        const first = await call();
        const afterRestart = await call();
        expect(first.receipt?.status).toBe("committed");
        expect(afterRestart.receipt?.status).toBe("replayed");
        expect(afterRestart.receipt?.revision).toBe(first.receipt?.revision);
        expect(
          await withTenant(
            database,
            fixture,
            async (sql) => sql<{ count: string }[]>`
              SELECT count(*)::text FROM crm.lead_field_values
              WHERE lead_id=${leadId}::uuid
            `,
          ),
        ).toEqual([{ count: "1" }]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("refuses an invented tool and an unpublished capability", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const context = toolContext(fixture, leadId, "message-2");
        await expect(
          withTenant(database, fixture, async (sql) =>
            executeLeadTool(
              sql,
              binding(fixture),
              context,
              "lead_delete_everything",
              {},
            ),
          ),
        ).rejects.toMatchObject({ name: "LeadToolError" });
        await expect(
          withTenant(database, fixture, async (sql) =>
            executeLeadTool(
              sql,
              binding(fixture, { capabilities: ["lead.read"] }),
              context,
              "lead_save_fields",
              {
                observations: [
                  { key: "company", state: "known", value: "Unauthorized Ltd" },
                ],
              },
            ),
          ),
        ).rejects.toMatchObject({
          name: "LeadToolError",
          reason: "is not enabled for this agent",
        });
        expect(
          await withTenant(
            database,
            fixture,
            async (sql) => sql<{ count: string }[]>`
              SELECT count(*)::text FROM crm.lead_field_values
              WHERE lead_id=${leadId}::uuid
            `,
          ),
        ).toEqual([{ count: "0" }]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("rejects malformed arguments without writing anything", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const context = toolContext(fixture, leadId, "message-3");
        for (const input of [
          { observations: [] },
          { observations: [{ key: "company" }] },
          { observations: [{ key: "company", state: "maybe", value: "x" }] },
          { observations: [{ key: "company", state: "known" }] },
          { observations: [{ key: "budget", state: "known", value: "1200" }] },
        ])
          await expect(
            withTenant(database, fixture, async (sql) =>
              executeLeadTool(
                sql,
                binding(fixture),
                context,
                "lead_save_fields",
                input,
              ),
            ),
          ).rejects.toSatisfy(
            (error: Error) =>
              error.name === "LeadToolError" ||
              error.name === "LeadFieldValidationError",
          );
        expect(
          await withTenant(
            database,
            fixture,
            async (sql) => sql<{ count: string }[]>`
              SELECT count(*)::text FROM crm.lead_field_values
              WHERE lead_id=${leadId}::uuid
            `,
          ),
        ).toEqual([{ count: "0" }]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("cannot raise its own confirmation above the customer's word", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        await withTenant(database, fixture, async (sql) =>
          executeLeadTool(
            sql,
            binding(fixture),
            toolContext(fixture, leadId, "message-4"),
            "lead_save_fields",
            {
              observations: [
                {
                  key: "company",
                  state: "known",
                  value: "Fictional Ltd",
                  confirmed: true,
                  confirmation: "human_verified",
                },
              ],
            },
          ),
        );
        const stored = await withTenant(
          database,
          fixture,
          async (sql) => sql<{ confirmation_status: string }[]>`
            SELECT confirmation_status FROM crm.lead_field_values
            WHERE lead_id=${leadId}::uuid AND field_key='company'
              AND superseded_at IS NULL
          `,
        );
        expect(stored).toEqual([{ confirmation_status: "customer_confirmed" }]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("finalizes for review without claiming qualification", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const result = await withTenant(database, fixture, async (sql) =>
          executeLeadTool(
            sql,
            binding(fixture),
            toolContext(fixture, leadId, "message-9"),
            "lead_finalize_collection",
            {
              summary: "Automation for a small team.",
              nextAction: "Call back.",
            },
          ),
        );
        expect(result.status).toBe("ready_for_review");
        expect(result.receipt?.status).toBe("committed");
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "a materially different field list runs through the same code",
  () => {
    const propertyFields = [
      {
        key: "preferred_name",
        label: "Preferred name",
        type: "text",
        required: true,
      },
      {
        key: "property_reference",
        label: "Property of interest",
        type: "text",
        required: true,
      },
      {
        key: "viewing_date",
        label: "Requested viewing date",
        type: "date",
        required: true,
      },
      {
        key: "party_size",
        label: "People attending",
        type: "number",
        required: false,
        minimum: 1,
        maximum: 20,
      },
      {
        key: "mortgage_preapproved",
        label: "Mortgage pre-approved",
        type: "boolean",
        required: false,
      },
      {
        key: "contact_window",
        label: "Best time to reach them",
        type: "choice",
        required: false,
        choices: ["Morning", "Afternoon", "Evening"],
      },
    ];

    it("advertises, normalizes, stores and completes against the property questions", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const property = await withTenant(database, fixture, async (sql) =>
          createLeadFieldSchema(sql, fixture.userId, {
            name: `Fictional property viewing ${randomUUID()}`,
            definition: propertyFields,
          }),
        );
        // The tool surface enumerates the property questions, not the
        // coordinator's: nothing about the business-software example is baked in.
        const advertised = leadToolDescriptors(
          ["lead.write"],
          property.schema,
        ).find((tool) => tool.name === "lead_save_fields");
        expect(JSON.stringify(advertised?.parameters)).toContain(
          "viewing_date",
        );
        expect(JSON.stringify(advertised?.parameters)).not.toContain("company");
        const result = await withTenant(database, fixture, async (sql) => {
          const opened = await ensureLeadForInteraction(sql, binding(fixture), {
            operationKey: `property-open-${randomUUID()}`,
            interestKey: `viewing-${randomUUID()}`,
            fieldSchemaId: property.id,
            fieldSchemaVersion: property.version,
          });
          return saveLeadFields(sql, binding(fixture), {
            leadId: opened.lead.id,
            operationKey: `property-save-${randomUUID()}`,
            observations: [
              { key: "preferred_name", state: "known", value: "נועה" },
              { key: "viewing_date", state: "known", value: "2026-10-05" },
              { key: "party_size", state: "known", value: "4" },
              { key: "mortgage_preapproved", state: "known", value: "כן" },
              { key: "contact_window", state: "known", value: "evening" },
            ],
          });
        });
        const byKey = new Map(
          result.lead.fields.map((field) => [field.key, field]),
        );
        expect(byKey.get("viewing_date")?.normalizedValue).toBe("2026-10-05");
        expect(byKey.get("mortgage_preapproved")?.normalizedValue).toBe("true");
        expect(byKey.get("contact_window")?.normalizedValue).toBe("Evening");
        expect(byKey.get("party_size")?.normalizedValue).toBe("4");
        expect(result.lead.completeness).toMatchObject({
          required: ["preferred_name", "property_reference", "viewing_date"],
          missing: ["property_reference"],
          complete: false,
        });
        // A question from the other schema is not accepted into this lead.
        await expect(
          withTenant(database, fixture, async (sql) =>
            saveLeadFields(sql, binding(fixture), {
              leadId: result.lead.id,
              operationKey: `property-wrong-${randomUUID()}`,
              observations: [{ key: "company", state: "known", value: "Acme" }],
            }),
          ),
        ).rejects.toMatchObject({ name: "LeadFieldValidationError" });
        // And the property rules are enforced, not the coordinator's.
        await expect(
          withTenant(database, fixture, async (sql) =>
            saveLeadFields(sql, binding(fixture), {
              leadId: result.lead.id,
              operationKey: `property-bounds-${randomUUID()}`,
              observations: [
                { key: "party_size", state: "known", value: "40" },
              ],
            }),
          ),
        ).rejects.toMatchObject({ code: "above_maximum" });
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "draft, published, assigned and running stay distinct",
  () => {
    it("keeps v1 running after v2 is published until an explicit rebind", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const profiles = await database<{ id: string }[]>`
          SELECT agent_profile_id AS id FROM agents.agent_profile_versions
          WHERE id=${fixture.agentVersionId}::uuid
        `;
        const profileId = profiles[0]?.id;
        if (profileId === undefined)
          throw new Error("fixture profile unavailable");
        // A call admitted with v1 is in progress.
        const call = await startCall(database, fixture);
        await database`
          INSERT INTO public.session_events (tenant_id, session_id, sequence, event_type, payload)
          VALUES (${fixture.tenantId}::uuid, ${call}::uuid, 0, 'voice.call.admission.v1',
                  ${database.json({ agent_version_id: fixture.agentVersionId })})
        `;
        // A second, human-owned conversation that must never be rebound.
        const humanOwned = await database<{ id: string }[]>`
          INSERT INTO messaging.conversations(tenant_id,channel_id,contact_id,status)
          SELECT tenant_id, channel_id, ${fixture.otherContactId}::uuid, 'open'
          FROM messaging.conversations WHERE id=${fixture.conversationId}::uuid
          RETURNING id
        `;
        const revised = await withTenant(database, fixture, async (sql) => {
          const revision = await createAgentProfileRevision(
            sql,
            fixture.userId,
            profileId,
            {
              baseVersionId: fixture.agentVersionId,
              systemPrompt: "Fictional lead coordinator, second revision.",
              channels: ["voice", "whatsapp"],
              toolPermissions: [
                "lead.read",
                "lead.write",
                "lead.finalize",
                "lead.follow_up",
              ],
              leadFieldSchemaId: fixture.schemaId,
            },
          );
          const drafted = (await listAgentProfiles(sql)).find(
            (agent) => agent.id === profileId,
          );
          await publishAgentProfile(sql, fixture.userId, profileId);
          const published = (await listAgentProfiles(sql)).find(
            (agent) => agent.id === profileId,
          );
          return { revision, drafted, published };
        });
        // Draft: v2 exists but v1 is still what is published and running.
        expect(revised.drafted?.lifecycle).toMatchObject({
          draftVersion: 2,
          assignedConversations: 1,
          staleConversations: 0,
          runningCalls: 1,
        });
        expect(revised.drafted?.publishedVersion).toBe(1);
        // Published v2: the WhatsApp conversation still runs v1 and is flagged.
        expect(revised.published?.publishedVersion).toBe(2);
        expect(revised.published?.lifecycle).toMatchObject({
          draftVersion: null,
          assignedConversations: 1,
          staleConversations: 1,
          runningCalls: 1,
        });
        const v2 = revised.revision?.versionId;
        if (v2 === undefined) throw new Error("revision unavailable");
        await expect(
          withTenant(database, fixture, async (sql) =>
            rebindAgentConversations(
              sql,
              fixture.userId,
              profileId,
              fixture.agentVersionId,
            ),
          ),
        ).rejects.toThrow(/newer version/u);
        const before = await withTenant(
          database,
          fixture,
          async (sql) => sql<{ ownership_epoch: string }[]>`
            SELECT ownership_epoch::text FROM messaging.conversations
            WHERE id=${fixture.conversationId}::uuid
          `,
        );
        const rebound = await withTenant(database, fixture, async (sql) =>
          rebindAgentConversations(sql, fixture.userId, profileId, v2),
        );
        expect(rebound).toEqual({ versionId: v2, rebound: 1 });
        const after = await withTenant(
          database,
          fixture,
          async (sql) => sql<
            {
              id: string;
              ai_agent_profile_version_id: string | null;
              ownership_epoch: string;
            }[]
          >`
            SELECT id, ai_agent_profile_version_id, ownership_epoch::text
            FROM messaging.conversations
            WHERE id IN (${fixture.conversationId}::uuid, ${humanOwned[0]?.id ?? ""}::uuid)
          `,
        );
        const assigned = after.find((row) => row.id === fixture.conversationId);
        expect(assigned?.ai_agent_profile_version_id).toBe(v2);
        // The previous version's in-flight work is fenced by the new epoch.
        expect(assigned?.ownership_epoch).not.toBe(before[0]?.ownership_epoch);
        expect(
          after.find((row) => row.id === humanOwned[0]?.id)
            ?.ai_agent_profile_version_id,
        ).toBeNull();
        // The call admitted with v1 is unaffected by any of this.
        const running = await withTenant(database, fixture, async (sql) =>
          (await listAgentProfiles(sql)).find(
            (agent) => agent.id === profileId,
          ),
        );
        expect(running?.lifecycle).toMatchObject({
          staleConversations: 0,
          runningCalls: 1,
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "publication refuses a lead agent the runtime could not execute",
  () => {
    it("requires a reviewed field schema for any lead capability", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture);
            return createAgentProfileDraft(sql, fixture.userId, {
              name: `Fictional unpinned coordinator ${randomUUID()}`,
              systemPrompt: "Collect the caller's company and save it.",
              channels: ["voice", "whatsapp"],
              toolPermissions: ["lead.write"],
            });
          }),
        ).rejects.toThrow(/lead field schema/u);
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);

describe.skipIf(databaseUrl === undefined)(
  "one lead mutation boundary for every channel",
  () => {
    it("continues a WhatsApp lead on the callback it requested and back again", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const whatsAppLead = await openLead(database, fixture);
        const { sessionId, handoffId } = await startCallback(database, fixture);
        // The call carries the conversation that asked for it, which is how it
        // finds that conversation's lead — not by the caller's phone number.
        const call = voiceBinding(fixture, sessionId, {
          conversationId: fixture.conversationId,
          handoffId,
        });
        const continued = await database.begin(async (sql) => {
          await runtimeContext(sql, fixture, "platform_voice");
          const found = await findInteractionLead(sql, call);
          const opened = await ensureLeadForInteraction(sql, call, {
            operationKey: `voice-open-${sessionId}`,
            fieldSchemaId: fixture.schemaId,
            fieldSchemaVersion: fixture.schemaVersion,
          });
          const saved = await saveLeadFields(sql, call, {
            leadId: opened.lead.id,
            operationKey: `voice-save-${sessionId}-turn-3`,
            observations: [
              {
                key: "seats",
                state: "known",
                value: "25",
                sourceReferenceId: "turn-3",
              },
            ],
          });
          return { found, opened, saved };
        });
        expect(continued.found?.id).toBe(whatsAppLead);
        expect(continued.opened).toMatchObject({ created: false });
        expect(continued.opened.lead.id).toBe(whatsAppLead);
        expect(continued.saved.receipt).toMatchObject({
          leadId: whatsAppLead,
          status: "committed",
          changed: ["seats"],
        });
        // Back on WhatsApp the same lead carries what the call collected.
        const afterCall = await withTenant(database, fixture, async (sql) =>
          findInteractionLead(sql, binding(fixture)),
        );
        expect(afterCall?.id).toBe(whatsAppLead);
        expect(
          afterCall?.fields.find((field) => field.key === "seats"),
        ).toMatchObject({ normalizedValue: "25", sourceChannel: "voice" });
        const links = await withTenant(
          database,
          fixture,
          async (sql) => sql<{ channel: string; session_id: string | null }[]>`
            SELECT channel, session_id FROM crm.lead_interactions
            WHERE lead_id=${whatsAppLead}::uuid ORDER BY channel
          `,
        );
        expect(links).toEqual([
          { channel: "voice", session_id: sessionId },
          { channel: "whatsapp", session_id: null },
        ]);
        // The Leads workspace shows the callback beside the WhatsApp thread,
        // and says plainly that no recording was stored for it.
        const detail = await withTenant(database, fixture, async (sql) =>
          getLeadDetail(sql, whatsAppLead),
        );
        expect(detail?.interaction.conversationId).toBe(fixture.conversationId);
        expect(detail?.calls).toEqual([
          expect.objectContaining({ sessionId, recording: "missing" }),
        ]);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("does not adopt a customer's open lead from a call it was never linked to", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        await openLead(database, fixture);
        const unrelated = voiceBinding(
          fixture,
          await startCall(database, fixture),
        );
        const found = await database.begin(async (sql) => {
          await runtimeContext(sql, fixture, "platform_voice");
          return findInteractionLead(sql, unrelated);
        });
        expect(found).toBeNull();
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("rechecks the pinned agent's capability in the database", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const readOnly = await publishAgent(database, fixture, ["lead.read"]);
        // The runtime believes it may write; the published version says no.
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture, "platform_messaging");
            return ensureLeadForInteraction(
              sql,
              binding(fixture, { agentProfileVersionId: readOnly }),
              {
                operationKey: `lead-overreach-${randomUUID()}`,
                fieldSchemaId: fixture.schemaId,
                fieldSchemaVersion: fixture.schemaVersion,
              },
            );
          }),
        ).rejects.toBeInstanceOf(LeadAuthorizationError);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("stops writes once the authorising operator loses access", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        // The operator who switched the agent on, not the tenant's owner.
        const operatorId = randomUUID();
        await database`
          INSERT INTO users(id,email,display_name,status)
          VALUES(${operatorId}::uuid,${`operator-${operatorId}@example.invalid`},
                 'Fictional operator','active')
        `;
        await database`
          INSERT INTO memberships(tenant_id,user_id,role)
          VALUES(${fixture.tenantId}::uuid,${operatorId}::uuid,'agent')
        `;
        await database`
          UPDATE memberships SET role='viewer'
          WHERE tenant_id=${fixture.tenantId}::uuid AND user_id=${operatorId}::uuid
        `;
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture, "platform_messaging");
            return saveLeadFields(
              sql,
              binding(fixture, { actorUserId: operatorId }),
              {
                leadId,
                operationKey: `lead-revoked-${randomUUID()}`,
                observations: [
                  { key: "company", state: "known", value: "Late Ltd" },
                ],
              },
            );
          }),
        ).rejects.toBeInstanceOf(LeadAuthorizationError);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("fences a voice worker after the call ends or a person pauses it", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const paused = await startCall(database, fixture);
        const ended = await startCall(database, fixture);
        const leadId = await database.begin(async (sql) => {
          await runtimeContext(sql, fixture, "platform_voice");
          return (
            await ensureLeadForInteraction(sql, voiceBinding(fixture, paused), {
              operationKey: `voice-open-${paused}`,
              fieldSchemaId: fixture.schemaId,
              fieldSchemaVersion: fixture.schemaVersion,
            })
          ).lead.id;
        });
        await database`
          INSERT INTO public.voice_session_controls (tenant_id, session_id, desired_mode)
          VALUES (${fixture.tenantId}::uuid, ${paused}::uuid, 'paused')
        `;
        await database`
          UPDATE public.sessions SET status='ended', ended_at=CURRENT_TIMESTAMP
          WHERE session_id=${ended}::uuid
        `;
        for (const sessionId of [paused, ended])
          await expect(
            database.begin(async (sql) => {
              await runtimeContext(sql, fixture, "platform_voice");
              return saveLeadFields(sql, voiceBinding(fixture, sessionId), {
                leadId,
                operationKey: `voice-late-${sessionId}`,
                observations: [
                  { key: "company", state: "known", value: "Late Ltd" },
                ],
              });
            }),
          ).rejects.toBeInstanceOf(LeadOwnershipError);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("lets only the operator workspace record a person's correction", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        const sessionId = await startCall(database, fixture);
        const impersonation = voiceBinding(fixture, sessionId, {
          recordedBy: "human",
          sourceChannel: "manual",
          actorUserId: fixture.userId,
        });
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture, "platform_voice");
            return saveLeadFields(sql, impersonation, {
              leadId,
              operationKey: `voice-human-${randomUUID()}`,
              observations: [
                {
                  key: "company",
                  state: "known",
                  value: "Forged Ltd",
                  confirmation: "human_verified",
                },
              ],
            });
          }),
        ).rejects.toThrow(/permission denied/u);
        // Nor can it smuggle the claim through the entry point it may call.
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture, "platform_voice");
            await sql`
              SELECT platform.lead_save_fields(
                ${sql.json({
                  contactId: fixture.contactId,
                  sourceChannel: "manual",
                  recordedBy: "human",
                  actorUserId: fixture.userId,
                })},
                ${leadId}::uuid, ${`voice-human-raw-${randomUUID()}`}, NULL,
                ${sql.json([
                  {
                    key: "company",
                    type: "text",
                    state: "known",
                    rawValue: "Forged Ltd",
                    normalizedValue: "Forged Ltd",
                    currency: null,
                    confirmation: "human_verified",
                    observedAt: new Date().toISOString(),
                  },
                ])}
              )
            `;
          }),
        ).rejects.toMatchObject({ code: "LD403" });
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("leaves runtime roles no direct write path around the functions", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        for (const role of ["platform_messaging", "platform_voice"] as const)
          await expect(
            database.begin(async (sql) => {
              await runtimeContext(sql, fixture, role);
              await sql`
                INSERT INTO crm.lead_field_values
                  (tenant_id, lead_id, field_key, value_state, source_channel,
                   source_reference_kind, observed_at, recorded_by)
                VALUES (platform.current_tenant_id(), ${leadId}::uuid, 'company',
                        'unknown', 'voice', 'voice_turn', CURRENT_TIMESTAMP, 'agent')
              `;
            }),
          ).rejects.toThrow(/permission denied/u);
      } finally {
        await database.end({ timeout: 2 });
      }
    });

    it("refuses a WhatsApp citation of a message outside the conversation", async () => {
      const database = ownedDatabase();
      try {
        const fixture = await createFixture(database);
        const leadId = await openLead(database, fixture);
        await expect(
          database.begin(async (sql) => {
            await runtimeContext(sql, fixture, "platform_messaging");
            return saveLeadFields(sql, binding(fixture), {
              leadId,
              operationKey: `lead-cite-${randomUUID()}`,
              observations: [
                {
                  key: "company",
                  state: "known",
                  value: "Cited Ltd",
                  sourceReferenceId: randomUUID(),
                },
              ],
            });
          }),
        ).rejects.toMatchObject({
          message: "source reference is not part of this interaction",
        });
      } finally {
        await database.end({ timeout: 2 });
      }
    });
  },
);
