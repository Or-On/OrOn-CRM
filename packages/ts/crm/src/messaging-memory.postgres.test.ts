import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  readMemorySummaries,
  readCustomerMemoryFacts,
  resolveMemorySession,
} from "./messaging-memory.js";

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("required synthetic fixture value missing");
  return value;
}

const url = process.env.CRM_TEST_DATABASE_URL;
class RollbackFixture extends Error {}
describe.skipIf(!url)("memory provenance PostgreSQL boundaries", () => {
  it("serializes sessions, keeps immutable stated facts, rejects foreign and AI provenance", async () => {
    const target = new URL(required(url));
    if (
      target.hostname !== "127.0.0.1" ||
      target.port !== "55480" ||
      !/^\/oron_(?:ui_preview|crm|knowledge)_[a-f0-9]+$/u.test(target.pathname)
    )
      throw new Error("owned local fictional database required");
    const db = postgres(required(url), { max: 1, prepare: false });
    try {
      await expect(
        db.begin(async (sql) => {
          const tenant = randomUUID(),
            owner = randomUUID(),
            profile = randomUUID(),
            agent = randomUUID();
          await sql`INSERT INTO public.tenants(id,name,slug,status)
            VALUES(${tenant}::uuid,'Fictional memory provenance',${tenant},'active')`;
          await sql`INSERT INTO public.users(id,email,display_name,status)
            VALUES(${owner}::uuid,${`${owner}@example.invalid`},'Fictional memory owner','active')`;
          await sql`INSERT INTO public.memberships(tenant_id,user_id,role)
            VALUES(${tenant}::uuid,${owner}::uuid,'owner')`;
          await sql`SELECT set_config('app.current_tenant',${tenant},true)`;
          await sql`SELECT set_config('app.current_user',${owner},true)`;
          await sql`INSERT INTO agents.agent_profiles(id,tenant_id,name,created_by_user_id)
            VALUES(${profile}::uuid,${tenant}::uuid,'Fictional memory agent',${owner}::uuid)`;
          await sql`INSERT INTO agents.agent_profile_versions(id,tenant_id,agent_profile_id,version,
            system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,
            escalation_configuration,validation_status,created_by_user_id,published_at)
            VALUES(${agent}::uuid,${tenant}::uuid,${profile}::uuid,1,'Fictional memory agent','he',
              ARRAY['whatsapp'],'[]','{}','{}','valid',${owner}::uuid,clock_timestamp())`;
          const contact = randomUUID(),
            channel = randomUUID(),
            conversation = randomUUID();
          const customer = randomUUID(),
            artificial = randomUUID();
          await sql`INSERT INTO crm.contacts(id,tenant_id,name) VALUES(${contact}::uuid,${tenant}::uuid,'Fictional memory')`;
          await sql`INSERT INTO messaging.channels(id,tenant_id,kind,provider,display_address,provider_account_id,status)
          VALUES(${channel}::uuid,${tenant}::uuid,'whatsapp','simulator','Fictional memory',${channel},'active')`;
          await sql`INSERT INTO messaging.conversations(id,tenant_id,channel_id,contact_id,status)
          VALUES(${conversation}::uuid,${tenant}::uuid,${channel}::uuid,${contact}::uuid,'open')`;
          await sql`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,content_text,status)
          VALUES(${customer}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','text','My city is FictionalCity','received'),
          (${artificial}::uuid,${tenant}::uuid,${conversation}::uuid,'outbound','agent','text','InventedCity','sent')`;
          await sql`UPDATE messaging.conversations SET ownership_mode='ai',ai_agent_profile_version_id=${agent}::uuid,ai_enabled_by_user_id=${owner}::uuid,ai_enabled_at=clock_timestamp() WHERE id=${conversation}::uuid`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const session = await resolveMemorySession(sql, conversation, agent);
          expect(
            (await resolveMemorySession(sql, conversation, agent)).id,
          ).toBe(session.id);
          const first = await sql<
            { id: string }[]
          >`SELECT agents.write_customer_memory_fact(
          ${session.id}::uuid,${customer}::uuid,'city','FictionalCity') id`;
          expect(first[0]?.id).toBeTruthy();
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_web`;
          const correction = await sql<
            { id: string }[]
          >`SELECT agents.correct_customer_memory_fact(${required(first[0]).id}::uuid,'CorrectedCity','Human review') id`;
          expect(correction[0]?.id).toBeTruthy();
          await sql`SELECT agents.correct_customer_memory_fact(${required(first[0]).id}::uuid,NULL,'Human deletion')`;
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT agents.activate_reviewed_memory()`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await sql`RESET ROLE`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const projection = await sql<
            { operation: string; fact_value: string | null }[]
          >`SELECT * FROM agents.read_session_memory_corrections(${session.id}::uuid,${agent}::uuid)`;
          expect(projection).toEqual([
            expect.objectContaining({ operation: "delete", fact_value: null }),
          ]);
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT * FROM agents.memory_fact_corrections`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT agents.correct_customer_memory_fact(${required(first[0]).id}::uuid,'Denied','Model correction')`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          expect(
            (await readCustomerMemoryFacts(sql, session.id, agent))[0]?.value,
          ).toBe("FictionalCity");
          await sql`SELECT agents.write_messaging_memory_summary(${session.id}::uuid,
          ${customer}::uuid,${[customer]}::uuid[],'Customer stated FictionalCity')`;
          for (const source of [artificial, randomUUID()]) {
            await expect(
              sql.savepoint(async (nested) => {
                await nested`SELECT agents.write_customer_memory_fact(${session.id}::uuid,${source}::uuid,'city','InventedCity')`;
              }),
            ).rejects.toMatchObject({ code: "42501" });
          }
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT agents.write_messaging_memory_summary(${session.id}::uuid,
            ${artificial}::uuid,${[artificial]}::uuid[],'Fabrication')`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await sql`RESET ROLE`;
          await sql`UPDATE agents.messaging_memory_sessions SET last_activity_at=clock_timestamp()-interval '13 hours'
          WHERE id=${session.id}::uuid`;
          const returning = randomUUID();
          await sql`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,content_text,status,created_at)
          VALUES(${returning}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','text','Returning FictionalCity','received',clock_timestamp())`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const nextSession = await resolveMemorySession(
            sql,
            conversation,
            agent,
          );
          expect(nextSession.id).not.toBe(session.id);
          expect(
            (await readMemorySummaries(sql, nextSession.id, agent))[0]
              ?.sourceSessionId,
          ).toBe(session.id);
          await sql`RESET ROLE`;
          const newVersions = await sql<{ id: string }[]>`
          INSERT INTO agents.agent_profile_versions(tenant_id,agent_profile_id,version,
            system_prompt,locale,channel_capabilities,tool_permissions,channel_configuration,
            escalation_configuration,validation_status,created_by_user_id,published_at)
          SELECT tenant_id,agent_profile_id,version+1000,'Fictional changed agent','he',
            ARRAY['whatsapp'],'[]','{}','{}','valid',created_by_user_id,clock_timestamp()
          FROM agents.agent_profile_versions WHERE id=${agent}::uuid RETURNING id`;
          await sql`SET LOCAL ROLE platform_messaging`;
          const changedAgentSession = await resolveMemorySession(
            sql,
            conversation,
            required(newVersions[0]).id,
          );
          expect(changedAgentSession.id).not.toBe(nextSession.id);
          expect(
            await readMemorySummaries(
              sql,
              changedAgentSession.id,
              required(newVersions[0]).id,
            ),
          ).toEqual([expect.objectContaining({ sourceSessionId: session.id })]);
          expect(
            await readCustomerMemoryFacts(
              sql,
              changedAgentSession.id,
              required(newVersions[0]).id,
            ),
          ).toEqual([
            expect.objectContaining({
              value: "FictionalCity",
              confidence: "stated",
            }),
          ]);
          await sql`RESET ROLE`;
          await sql`UPDATE agents.agent_profiles SET archived_at=clock_timestamp() WHERE id=(SELECT agent_profile_id FROM agents.agent_profile_versions WHERE id=${agent}::uuid)`;
          await sql`SET LOCAL ROLE platform_messaging`;
          expect(
            await readMemorySummaries(
              sql,
              changedAgentSession.id,
              required(newVersions[0]).id,
            ),
          ).toEqual([]);
          expect(
            await readCustomerMemoryFacts(
              sql,
              changedAgentSession.id,
              required(newVersions[0]).id,
            ),
          ).toEqual([]);
          await sql`RESET ROLE`;
          await sql`UPDATE agents.agent_profiles SET archived_at=NULL WHERE id=(SELECT agent_profile_id FROM agents.agent_profile_versions WHERE id=${agent}::uuid)`;
          await sql`SET LOCAL ROLE platform_messaging`;
          await sql`RESET ROLE`;
          await sql`UPDATE agents.messaging_memory_sessions SET started_at=clock_timestamp()-interval '6 hours' WHERE id=${session.id}::uuid`;
          const priorSessions: string[] = [];
          for (let index = 0; index < 4; index++) {
            const prior = randomUUID();
            priorSessions.push(prior);
            await sql`INSERT INTO agents.messaging_memory_sessions(id,tenant_id,conversation_id,agent_version_id,started_at,last_activity_at)
              VALUES(${prior}::uuid,${tenant}::uuid,${conversation}::uuid,${agent}::uuid,
                clock_timestamp()-(${4 - index}::int * interval '1 hour'),clock_timestamp()-interval '30 minutes')`;
            for (let checkpoint = 0; checkpoint < 3; checkpoint++) {
              const message = randomUUID();
              await sql`INSERT INTO messaging.messages(id,tenant_id,conversation_id,direction,sender_type,content_type,content_text,status)
                VALUES(${message}::uuid,${tenant}::uuid,${conversation}::uuid,'inbound','contact','text','Fictional prior statement','received')`;
              await sql`INSERT INTO agents.messaging_memory_summaries(tenant_id,session_id,covered_until_message_id,source_message_ids,text,created_at)
                VALUES(${tenant}::uuid,${prior}::uuid,${message}::uuid,${[message]}::uuid[],${`session-${String(index)}-checkpoint-${String(checkpoint)}`},
                  clock_timestamp()+(${checkpoint}::int * interval '1 second'))`;
            }
          }
          await sql`SET LOCAL ROLE platform_messaging`;
          const distinct = await readMemorySummaries(
            sql,
            changedAgentSession.id,
            required(newVersions[0]).id,
          );
          expect(distinct.map((row) => row.sourceSessionId)).toEqual(
            priorSessions.slice(1),
          );
          expect(distinct.map((row) => row.text)).toEqual([
            "session-1-checkpoint-2",
            "session-2-checkpoint-2",
            "session-3-checkpoint-2",
          ]);
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT agents.write_customer_memory_fact(${nextSession.id}::uuid,
            ${customer}::uuid,'city','FictionalCity')`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            sql.savepoint(async (nested) => {
              await nested`SELECT agents.write_messaging_memory_summary(${nextSession.id}::uuid,
            ${customer}::uuid,${[customer]}::uuid[],'Wrong session source')`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await sql`SELECT set_config('app.current_tenant',${randomUUID()},true)`;
          expect(
            await sql`SELECT * FROM agents.customer_memory_facts`,
          ).toHaveLength(0);
          await expect(
            sql.savepoint(async (nested) => {
              await resolveMemorySession(nested, conversation, agent);
            }),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            sql.savepoint(async (nested) => {
              await nested`INSERT INTO agents.customer_memory_facts(tenant_id,session_id,source_message_id,fact_key,fact_value,confidence)
            VALUES(${tenant}::uuid,${session.id}::uuid,${customer}::uuid,'city','InventedCity','verified')`;
            }),
          ).rejects.toMatchObject({ code: "42501" });
          throw new RollbackFixture();
        }),
      ).rejects.toBeInstanceOf(RollbackFixture);
    } finally {
      await db.end();
    }
  });
});
