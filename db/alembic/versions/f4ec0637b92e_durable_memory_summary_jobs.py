"""Durable shadow summary checkpoints with fresh claimed-job authority."""

from alembic import op
from sqlalchemy.schema import DDL

revision = "f4ec0637b92e"
down_revision = "f3db9526a81d"
branch_labels = None
depends_on = None


def execute(sql):
    op.execute(DDL(sql.replace("%", "%%")))


def upgrade():
    execute("""
    CREATE TABLE agents.memory_summary_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      channel text NOT NULL CHECK(channel IN('whatsapp','voice')),
      session_id uuid NOT NULL,
      agent_version_id uuid NOT NULL REFERENCES agents.agent_profile_versions(id) ON DELETE
      RESTRICT,
      conversation_id uuid REFERENCES messaging.conversations(id) ON DELETE RESTRICT,
      actor_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
      ownership_epoch bigint,
      ended_by_handoff boolean NOT NULL DEFAULT false,
      watermark uuid NOT NULL,
      covered_turn_count integer CHECK(covered_turn_count>0),
      source_ids uuid[] NOT NULL CHECK(cardinality(source_ids) BETWEEN 1 AND 20),
      privacy_scope text NOT NULL DEFAULT 'session_only' CHECK(privacy_scope='session_only'),
      summary_text text CHECK(length(summary_text) BETWEEN 1 AND 4000),
      state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','complete')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(tenant_id,channel,session_id,watermark))
    """)
    execute("ALTER TABLE agents.memory_summary_requests ENABLE ROW LEVEL SECURITY")
    execute("ALTER TABLE agents.memory_summary_requests FORCE ROW LEVEL SECURITY")
    execute("""CREATE POLICY tenant_isolation ON agents.memory_summary_requests
      USING(tenant_id=platform.current_tenant_id())
      WITH CHECK(tenant_id=platform.current_tenant_id())""")
    execute("""
    CREATE TABLE agents.messaging_memory_turns(
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      session_id uuid NOT NULL REFERENCES agents.messaging_memory_sessions(id) ON DELETE RESTRICT,
      conversation_id uuid NOT NULL REFERENCES messaging.conversations(id) ON DELETE RESTRICT,
      message_id uuid NOT NULL REFERENCES messaging.messages(id) ON DELETE RESTRICT,
      ordinal bigint NOT NULL CHECK(ordinal>0),
      PRIMARY KEY(tenant_id,conversation_id,message_id),UNIQUE(tenant_id,session_id,ordinal))
    """)
    execute("ALTER TABLE agents.messaging_memory_turns ENABLE ROW LEVEL SECURITY")
    execute("ALTER TABLE agents.messaging_memory_turns FORCE ROW LEVEL SECURITY")
    execute("CREATE POLICY deny_direct_memory_turns ON agents.messaging_memory_turns USING(false)")
    execute("""
    CREATE FUNCTION agents.queue_messaging_memory_summary(
      p_session uuid,p_end boolean,p_actor uuid DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE s agents.messaging_memory_sessions%ROWTYPE;
      c messaging.conversations%ROWTYPE; sources uuid[]; newest uuid; total integer; request uuid;
      checkpoint integer;
    BEGIN
      SELECT * INTO s FROM agents.messaging_memory_sessions WHERE id=p_session;
      SELECT * INTO c FROM messaging.conversations WHERE id=s.conversation_id AND
      tenant_id=s.tenant_id;
      IF c.id IS NULL OR (c.ownership_mode<>'ai' AND NOT p_end)
        OR c.removed_from_inbox_at IS NOT NULL
        OR NOT EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
          WHERE tenant_id=s.tenant_id AND flag_key='session_memory' AND enabled) THEN RETURN
      NULL; END IF;
      -- Assign each immutable customer message once, using server session
      -- continuity and activation, independent of when inference begins.
      INSERT INTO agents.messaging_memory_turns(
        tenant_id,session_id,conversation_id,message_id,ordinal)
      SELECT s.tenant_id,s.id,c.id,m.id,
        COALESCE((SELECT max(ordinal) FROM agents.messaging_memory_turns
          WHERE tenant_id=s.tenant_id AND session_id=s.id),0)+row_number() OVER(ORDER BY
      m.created_at,m.id)
      FROM messaging.messages m WHERE m.tenant_id=s.tenant_id AND m.conversation_id=c.id
        AND m.direction='inbound' AND m.sender_type='contact' AND m.content_text IS NOT NULL
        AND length(m.content_text)>0 AND m.created_at<=s.last_activity_at
        AND m.created_at>=COALESCE((SELECT max(previous.last_activity_at)
          FROM agents.messaging_memory_sessions previous WHERE previous.tenant_id=s.tenant_id
            AND previous.conversation_id=c.id AND previous.id<>s.id
            AND previous.started_at<s.started_at),c.ai_enabled_at,s.started_at)
        AND NOT EXISTS(SELECT 1 FROM agents.messaging_memory_turns assigned
          WHERE assigned.tenant_id=s.tenant_id AND assigned.conversation_id=c.id AND
      assigned.message_id=m.id)
      ON CONFLICT DO NOTHING;
      UPDATE agents.messaging_memory_sessions session SET started_at=LEAST(session.started_at,
        COALESCE((SELECT min(m.created_at) FROM agents.messaging_memory_turns turn
          JOIN messaging.messages m ON m.id=turn.message_id AND m.tenant_id=turn.tenant_id
          WHERE turn.tenant_id=s.tenant_id AND turn.session_id=s.id),session.started_at))
        WHERE session.id=s.id;
      SELECT count(*) INTO total FROM agents.messaging_memory_turns
        WHERE tenant_id=s.tenant_id AND session_id=s.id;
      IF total=0 THEN RETURN NULL; END IF;
      FOR checkpoint IN
        SELECT threshold FROM generate_series(
          (COALESCE((SELECT max(covered_turn_count) FROM agents.memory_summary_requests
            WHERE tenant_id=s.tenant_id AND session_id=s.id AND channel='whatsapp'),0)/10+1)*10,
          total,10) threshold
        UNION SELECT total WHERE p_end
      LOOP
        SELECT array_agg(source.message_id ORDER BY source.ordinal) INTO sources FROM
          (SELECT message_id,ordinal FROM agents.messaging_memory_turns
            WHERE tenant_id=s.tenant_id AND session_id=s.id AND ordinal<=checkpoint
            ORDER BY ordinal DESC LIMIT 20) source;
        newest:=sources[cardinality(sources)];
        INSERT INTO agents.memory_summary_requests(tenant_id,channel,session_id,agent_version_id,
          conversation_id,actor_id,ownership_epoch,watermark,source_ids,covered_turn_count,ended_by_handoff)
        VALUES(s.tenant_id,'whatsapp',s.id,s.agent_version_id,c.id,COALESCE(p_actor,c.ai_enabled_by_user_id),
          c.ownership_epoch,newest,sources,checkpoint,p_end AND c.ownership_mode='human')
        ON CONFLICT(tenant_id,channel,session_id,watermark) DO NOTHING RETURNING id INTO request;
        IF request IS NOT NULL THEN
          INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload)
          VALUES(s.tenant_id,'messaging','memory.summary','memory_request',request,'{}'::jsonb);
        END IF;
      END LOOP;
      RETURN request;
    END $$
    """)
    execute("""
      REVOKE ALL ON FUNCTION agents.queue_messaging_memory_summary(uuid,boolean,uuid) FROM PUBLIC
    """)
    execute("""
    CREATE FUNCTION agents.schedule_messaging_memory_summary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    DECLARE old_session uuid;
    BEGIN
      IF TG_TABLE_NAME='messaging_memory_sessions' THEN
        PERFORM agents.queue_messaging_memory_summary(NEW.id,false);
        IF TG_OP='INSERT' THEN
          FOR old_session IN SELECT id FROM agents.messaging_memory_sessions
            WHERE tenant_id=NEW.tenant_id AND conversation_id=NEW.conversation_id AND id<>NEW.id
          LOOP PERFORM agents.queue_messaging_memory_summary(old_session,true); END LOOP;
        END IF;
      ELSIF (NEW.status='closed' AND OLD.status IS DISTINCT FROM NEW.status)
        OR (OLD.ownership_mode='ai' AND NEW.ownership_mode='human') THEN
        FOR old_session IN SELECT id FROM agents.messaging_memory_sessions
          WHERE tenant_id=NEW.tenant_id AND conversation_id=NEW.id
        LOOP
          PERFORM agents.queue_messaging_memory_summary(old_session,true,OLD.ai_enabled_by_user_id);
        END LOOP;
      END IF;
      RETURN NEW;
    END $$
    """)
    execute("REVOKE ALL ON FUNCTION agents.schedule_messaging_memory_summary() FROM PUBLIC")
    execute("""CREATE TRIGGER schedule_memory_summary AFTER INSERT OR UPDATE OF last_activity_at
      ON agents.messaging_memory_sessions FOR EACH ROW
      EXECUTE FUNCTION agents.schedule_messaging_memory_summary()""")
    execute("""CREATE TRIGGER finish_memory_summary AFTER UPDATE OF status,ownership_mode
      ON messaging.conversations FOR EACH ROW
      EXECUTE FUNCTION agents.schedule_messaging_memory_summary()""")
    execute_extra()
    execute_script("""
    CREATE TABLE agents.memory_summary_alerts(
      tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
      request_id uuid NOT NULL REFERENCES agents.memory_summary_requests(id) ON DELETE RESTRICT,
      reason text NOT NULL CHECK(reason IN('memory_summary_unavailable','memory_summary_failed')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,request_id)) ;
    ALTER TABLE agents.memory_summary_alerts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE agents.memory_summary_alerts FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON agents.memory_summary_alerts
      USING(tenant_id=platform.current_tenant_id());
    CREATE FUNCTION agents.alert_exhausted_memory_summary() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
    BEGIN
      IF NEW.job_type='memory.summary' AND NEW.reference_type='memory_request'
        AND NEW.status='dead' AND OLD.status='running'
        AND NEW.last_error_safe IN('memory_summary_unavailable','memory_summary_failed') THEN
        INSERT INTO agents.memory_summary_alerts(tenant_id,request_id,reason)
          SELECT NEW.tenant_id,request.id,NEW.last_error_safe
          FROM agents.memory_summary_requests request WHERE request.id=NEW.reference_id
            AND request.tenant_id=NEW.tenant_id AND request.state='pending'
          ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END $$;
    REVOKE ALL ON FUNCTION agents.alert_exhausted_memory_summary() FROM PUBLIC;
    CREATE TRIGGER alert_exhausted_memory_summary AFTER UPDATE OF status ON ops.jobs
      FOR EACH ROW EXECUTE FUNCTION agents.alert_exhausted_memory_summary();
    """)


def downgrade():
    execute("""DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM agents.memory_summary_requests)
        OR EXISTS(SELECT 1 FROM agents.voice_memory_turns) THEN
        RAISE EXCEPTION 'summary evidence retention requires archival review';
      END IF;
    END $$""")
    execute("DROP TRIGGER alert_exhausted_memory_summary ON ops.jobs")
    execute("DROP FUNCTION agents.alert_exhausted_memory_summary()")
    execute("DROP TABLE agents.memory_summary_alerts")
    execute("DROP FUNCTION platform.persist_memory_summary_job(uuid,text,uuid,text)")
    execute("DROP FUNCTION platform.load_memory_summary_job(uuid,text,uuid)")
    execute("DROP FUNCTION platform.finish_voice_memory(uuid)")
    execute("DROP FUNCTION platform.append_voice_memory_turn(uuid,integer,text)")
    execute("DROP FUNCTION agents.enqueue_voice_memory_checkpoint(uuid,uuid,boolean)")
    execute("DROP FUNCTION agents.voice_memory_authority(uuid)")
    execute("DROP TABLE agents.voice_memory_turns")
    execute("DROP TRIGGER finish_memory_summary ON messaging.conversations")
    execute("DROP TRIGGER schedule_memory_summary ON agents.messaging_memory_sessions")
    execute("DROP FUNCTION agents.schedule_messaging_memory_summary()")
    execute("DROP FUNCTION agents.queue_messaging_memory_summary(uuid,boolean,uuid)")
    execute("DROP TABLE agents.memory_summary_requests")
    execute("DROP TABLE agents.messaging_memory_turns")


def execute_script(script):
    script = "\n".join(line for line in script.splitlines() if not line.lstrip().startswith("--"))
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                execute(pending)
            pending = piece
    if pending.strip():
        execute(pending)


def execute_extra():
    execute_script(VOICE_SQL)
    execute_script(EXTRA_SQL)


VOICE_SQL = """
-- Merge into canonical f4 migration; never apply this scratch file to runtime.
CREATE TABLE agents.voice_memory_turns (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 session_id uuid NOT NULL,
 agent_version_id uuid NOT NULL,
 identity_verified boolean NOT NULL,
 verified_contact_id uuid,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 1 AND 10000),
 text text NOT NULL CHECK(length(text) BETWEEN 1 AND 4000),
 CHECK(identity_verified=(verified_contact_id IS NOT NULL)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,session_id,ordinal),
 FOREIGN KEY(tenant_id,session_id) REFERENCES public.sessions(tenant_id,session_id) ON DELETE
      RESTRICT,
 FOREIGN KEY(tenant_id,verified_contact_id) REFERENCES crm.contacts(tenant_id,id) ON DELETE
      RESTRICT,
 FOREIGN KEY(tenant_id,agent_version_id) REFERENCES agents.agent_profile_versions(tenant_id,id)
      ON DELETE RESTRICT
);
ALTER TABLE agents.voice_memory_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.voice_memory_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY deny_direct_voice_memory ON agents.voice_memory_turns USING(false) WITH CHECK(false);
REVOKE ALL ON agents.voice_memory_turns FROM PUBLIC,platform_voice,platform_messaging,platform_web;
-- Internal helper has no runtime grants. It never trusts caller text or a requested
-- customer identity. Eligibility is freshly derived again by the claimed consumer.
CREATE FUNCTION agents.voice_memory_authority(p_session uuid)
RETURNS TABLE(tenant_id uuid,agent_version_id uuid,contact_id uuid,identity_verified boolean)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT s.tenant_id,a.id,s.contact_id,
   EXISTS(SELECT 1 FROM automation.voice_identity_verifications proof
     WHERE proof.tenant_id=s.tenant_id AND proof.session_id=s.session_id
       AND proof.contact_id=s.contact_id AND proof.state='context_unlocked'
       AND proof.verified_at IS NOT NULL AND proof.context_unlocked_at IS NOT NULL)
   AND service.voice_session_caller_identity(s.tenant_id,s.session_id) IS NOT NULL
 FROM public.sessions s
 JOIN public.tenants tenant ON tenant.id=s.tenant_id AND tenant.status='active'
 JOIN public.session_events binding ON binding.tenant_id=s.tenant_id
   AND binding.session_id=s.session_id AND binding.event_type='voice.agent.binding.v1'
 JOIN agents.agent_profile_versions a ON a.tenant_id=s.tenant_id
   AND a.id=(binding.payload->>'agent_version_id')::uuid
 JOIN agents.agent_profiles profile ON profile.tenant_id=a.tenant_id
   AND profile.id=a.agent_profile_id AND profile.archived_at IS NULL
 WHERE s.tenant_id=platform.current_tenant_id() AND s.session_id=p_session
   AND a.published_at IS NOT NULL AND a.validation_status='valid'
   AND platform.current_tenant_feature_enabled('voice')
   AND EXISTS(SELECT 1 FROM platform.tenant_remediation_flags flag
     WHERE flag.tenant_id=s.tenant_id AND flag.flag_key='session_memory' AND flag.enabled)
   AND NOT EXISTS(SELECT 1 FROM public.voice_session_controls control
     WHERE control.tenant_id=s.tenant_id AND control.session_id=s.session_id
       AND (control.desired_mode<>'ai' OR (control.requested_by_user_id IS NOT NULL
         AND NOT platform.voice_control_actor_allowed(control.requested_by_user_id,true))))
 ORDER BY binding.created_at LIMIT 1
$$;
REVOKE ALL ON FUNCTION agents.voice_memory_authority(uuid) FROM PUBLIC;
CREATE FUNCTION platform.append_voice_memory_turn(p_session uuid,p_ordinal integer,p_text text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authority record; result uuid; original_text text; original_agent uuid;
BEGIN
 IF p_ordinal IS NULL OR p_ordinal NOT BETWEEN 1 AND 10000
   OR p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 4000 THEN
   RAISE EXCEPTION 'invalid_voice_memory_source' USING ERRCODE='22023';
 END IF;
 -- Serialize with session closure and identity changes under the canonical row.
 PERFORM 1 FROM public.sessions s WHERE s.tenant_id=platform.current_tenant_id()
   AND s.session_id=p_session AND s.status='started' AND s.ended_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'voice_memory_session_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.voice_session_controls control
   WHERE control.tenant_id=platform.current_tenant_id() AND control.session_id=p_session FOR SHARE;
 PERFORM 1 FROM automation.voice_identity_verifications proof
   WHERE proof.tenant_id=platform.current_tenant_id() AND proof.session_id=p_session FOR SHARE;
 SELECT * INTO authority FROM agents.voice_memory_authority(p_session);
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO agents.voice_memory_turns(
   tenant_id,session_id,agent_version_id,identity_verified,verified_contact_id,ordinal,text)
 VALUES(authority.tenant_id,p_session,authority.agent_version_id,authority.identity_verified,
   CASE WHEN authority.identity_verified THEN authority.contact_id ELSE NULL END,p_ordinal,p_text)
 ON CONFLICT(tenant_id,session_id,ordinal) DO NOTHING RETURNING id INTO result;
 IF result IS NULL THEN
   SELECT id,text,agent_version_id INTO result,original_text,original_agent
   FROM agents.voice_memory_turns WHERE tenant_id=authority.tenant_id
     AND session_id=p_session AND ordinal=p_ordinal;
   IF original_text IS DISTINCT FROM p_text OR original_agent IS DISTINCT FROM
      authority.agent_version_id THEN
     RAISE EXCEPTION 'voice_memory_source_conflict' USING ERRCODE='42501';
   END IF;
 END IF;
 IF p_ordinal%10=0 THEN
   PERFORM agents.enqueue_voice_memory_checkpoint(p_session,result,false);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION platform.append_voice_memory_turn(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.append_voice_memory_turn(uuid,integer,text) TO platform_voice;
CREATE FUNCTION platform.finish_voice_memory(p_session uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authority record; watermark uuid;
BEGIN
 PERFORM 1 FROM public.sessions s WHERE s.tenant_id=platform.current_tenant_id()
   AND s.session_id=p_session AND s.ended_at IS NOT NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'voice_memory_session_unavailable' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.voice_session_controls control
   WHERE control.tenant_id=platform.current_tenant_id() AND control.session_id=p_session FOR SHARE;
 PERFORM 1 FROM automation.voice_identity_verifications proof
   WHERE proof.tenant_id=platform.current_tenant_id() AND proof.session_id=p_session FOR SHARE;
 SELECT * INTO authority FROM agents.voice_memory_authority(p_session);
 IF NOT FOUND THEN RETURN; END IF;
 SELECT id INTO watermark FROM agents.voice_memory_turns
 WHERE tenant_id=authority.tenant_id AND session_id=p_session ORDER BY ordinal DESC LIMIT 1;
 IF watermark IS NOT NULL THEN
   PERFORM agents.enqueue_voice_memory_checkpoint(p_session,watermark,true);
 END IF;
END $$;
REVOKE ALL ON FUNCTION platform.finish_voice_memory(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.finish_voice_memory(uuid) TO platform_voice;
"""
EXTRA_SQL = """
CREATE FUNCTION agents.enqueue_voice_memory_checkpoint(p_session uuid,p_watermark uuid,p_end
      boolean)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE authority record; sources uuid[]; request uuid;
BEGIN
 SELECT * INTO authority FROM agents.voice_memory_authority(p_session);
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT array_agg(source.id ORDER BY source.ordinal) INTO sources FROM
   (SELECT id,ordinal FROM agents.voice_memory_turns WHERE tenant_id=authority.tenant_id
     AND session_id=p_session AND ordinal<=(SELECT ordinal FROM agents.voice_memory_turns
       WHERE id=p_watermark AND tenant_id=authority.tenant_id AND session_id=p_session)
     ORDER BY ordinal DESC LIMIT 20) source;
 IF sources IS NULL OR p_watermark IS DISTINCT FROM sources[cardinality(sources)] THEN
   RAISE EXCEPTION 'voice summary watermark unavailable' USING ERRCODE='42501';
 END IF;
 INSERT INTO agents.memory_summary_requests(tenant_id,channel,session_id,agent_version_id,
   watermark,source_ids,ownership_epoch)
 VALUES(authority.tenant_id,'voice',p_session,authority.agent_version_id,p_watermark,sources,
   COALESCE((SELECT epoch FROM public.voice_session_controls
     WHERE tenant_id=authority.tenant_id AND session_id=p_session),0))
 ON CONFLICT(tenant_id,channel,session_id,watermark) DO NOTHING RETURNING id INTO request;
 IF request IS NOT NULL THEN
   INSERT INTO ops.jobs(tenant_id,queue,job_type,reference_type,reference_id,payload)
   VALUES(authority.tenant_id,'messaging','memory.summary','memory_request',request,'{}'::jsonb);
 END IF;
 RETURN request;
END $$;
REVOKE ALL ON FUNCTION agents.enqueue_voice_memory_checkpoint(uuid,uuid,boolean) FROM PUBLIC;
CREATE FUNCTION platform.load_memory_summary_job(p_job uuid,p_worker text,p_claim uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE j ops.jobs%ROWTYPE; r agents.memory_summary_requests%ROWTYPE;
  authority record; turns jsonb; source_count integer;
BEGIN
 SELECT * INTO j FROM ops.jobs WHERE id=p_job AND tenant_id=platform.current_tenant_id()
   AND queue='messaging' AND job_type='memory.summary' AND reference_type='memory_request'
   AND status='running' AND locked_by=p_worker AND claim_token=p_claim
   AND lease_expires_at>clock_timestamp() FOR UPDATE;
 IF j.id IS NULL THEN RAISE EXCEPTION 'summary claim denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM agents.memory_summary_requests WHERE id=j.reference_id
   AND tenant_id=j.tenant_id AND state='pending' FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'summary request denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.tenants WHERE id=r.tenant_id FOR SHARE;
 PERFORM 1 FROM platform.tenant_remediation_flags WHERE tenant_id=r.tenant_id FOR SHARE;
 PERFORM 1 FROM agents.agent_profile_versions WHERE id=r.agent_version_id FOR SHARE;
 PERFORM 1 FROM agents.agent_profiles profile JOIN agents.agent_profile_versions version
   ON version.agent_profile_id=profile.id AND version.tenant_id=profile.tenant_id
   WHERE version.id=r.agent_version_id FOR SHARE OF profile;
 IF r.channel='voice' THEN
   PERFORM 1 FROM public.sessions WHERE session_id=r.session_id AND tenant_id=r.tenant_id FOR
      UPDATE;
   PERFORM 1 FROM public.voice_session_controls control
     WHERE control.tenant_id=r.tenant_id AND control.session_id=r.session_id FOR SHARE;
   PERFORM 1 FROM automation.voice_identity_verifications proof
     WHERE proof.tenant_id=r.tenant_id AND proof.session_id=r.session_id FOR SHARE;
   IF r.ownership_epoch IS DISTINCT FROM COALESCE((SELECT epoch FROM public.voice_session_controls
     WHERE tenant_id=r.tenant_id AND session_id=r.session_id),0) THEN
     RAISE EXCEPTION 'voice summary ownership epoch changed' USING ERRCODE='42501'; END IF;
   SELECT * INTO authority FROM agents.voice_memory_authority(r.session_id);
   IF NOT FOUND OR authority.agent_version_id IS DISTINCT FROM r.agent_version_id THEN
     RAISE EXCEPTION 'voice summary authority revoked' USING ERRCODE='42501'; END IF;
   SELECT jsonb_agg(jsonb_build_object('id',id,'text',text,'source','customer') ORDER BY
      ordinal),count(*)
     INTO turns,source_count FROM agents.voice_memory_turns
     WHERE tenant_id=r.tenant_id AND session_id=r.session_id
       AND agent_version_id=r.agent_version_id AND id=ANY(r.source_ids);
 ELSE
   PERFORM 1 FROM public.users WHERE id=r.actor_id FOR SHARE;
   PERFORM 1 FROM public.memberships WHERE tenant_id=r.tenant_id AND user_id=r.actor_id FOR SHARE;
   PERFORM 1 FROM messaging.channels channel JOIN messaging.conversations conversation
     ON conversation.channel_id=channel.id AND conversation.tenant_id=channel.tenant_id
     WHERE conversation.id=r.conversation_id FOR SHARE OF channel;
   PERFORM 1 FROM messaging.conversations c
     JOIN public.tenants t ON t.id=c.tenant_id AND t.status='active'
     JOIN messaging.channels channel ON channel.id=c.channel_id AND channel.tenant_id=c.tenant_id
       AND channel.kind='whatsapp' AND channel.status='active'
     JOIN agents.agent_profile_versions version ON version.id=r.agent_version_id
       AND version.tenant_id=c.tenant_id AND version.published_at IS NOT NULL
       AND version.validation_status='valid'
     JOIN agents.agent_profiles profile ON profile.id=version.agent_profile_id
       AND profile.tenant_id=version.tenant_id AND profile.archived_at IS NULL
     WHERE c.id=r.conversation_id AND c.tenant_id=r.tenant_id
       AND (c.ownership_mode='ai' OR (c.ownership_mode='human' AND r.ended_by_handoff))
       AND c.removed_from_inbox_at IS NULL
       AND (c.ai_enabled_by_user_id=r.actor_id
         OR (r.ended_by_handoff AND c.ai_enabled_by_user_id IS NULL))
       AND c.ownership_epoch=r.ownership_epoch
       AND platform.messaging_ai_actor_authorized(r.actor_id)
       AND EXISTS(SELECT 1 FROM platform.tenant_remediation_flags
         WHERE tenant_id=r.tenant_id AND flag_key='session_memory' AND enabled)
     FOR UPDATE OF c;
   IF NOT FOUND THEN RAISE EXCEPTION 'messaging summary authority revoked' USING
      ERRCODE='42501'; END IF;
   SELECT jsonb_agg(jsonb_build_object('id',m.id,'text',left(m.content_text,4000),
       'source','customer')
       ORDER BY m.created_at,m.id),count(*) INTO turns,source_count
     FROM messaging.messages m JOIN agents.messaging_memory_sessions session
       ON session.id=r.session_id AND session.tenant_id=m.tenant_id
       AND session.conversation_id=m.conversation_id AND session.agent_version_id=r.agent_version_id
     WHERE m.tenant_id=r.tenant_id AND m.conversation_id=r.conversation_id AND
      m.id=ANY(r.source_ids)
       AND m.direction='inbound' AND m.sender_type='contact' AND m.content_text IS NOT NULL
       AND EXISTS(SELECT 1 FROM agents.messaging_memory_turns membership
         WHERE membership.tenant_id=r.tenant_id AND membership.session_id=r.session_id
           AND membership.message_id=m.id);
 END IF;
 IF source_count IS DISTINCT FROM cardinality(r.source_ids) THEN
   RAISE EXCEPTION 'summary source revoked' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('requestId',r.id,'channel',r.channel,'sessionId',r.session_id,
   'turns',turns,'watermark',r.watermark);
END $$;
REVOKE ALL ON FUNCTION platform.load_memory_summary_job(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.load_memory_summary_job(uuid,text,uuid) TO platform_messaging;
CREATE FUNCTION platform.persist_memory_summary_job(p_job uuid,p_worker text,p_claim
      uuid,p_text text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope jsonb; r agents.memory_summary_requests%ROWTYPE;
BEGIN
 scope:=platform.load_memory_summary_job(p_job,p_worker,p_claim);
 IF p_text IS NULL OR length(p_text) NOT BETWEEN 1 AND 4000 OR length(trim(p_text))=0 THEN
   RAISE EXCEPTION 'invalid summary output' USING ERRCODE='22023'; END IF;
 SELECT * INTO r FROM agents.memory_summary_requests WHERE id=(scope->>'requestId')::uuid;
 IF r.channel='whatsapp' THEN
   PERFORM agents.write_messaging_memory_summary(r.session_id,r.watermark,r.source_ids,p_text);
 END IF;
 UPDATE agents.memory_summary_requests SET summary_text=p_text,state='complete' WHERE id=r.id;
 UPDATE ops.jobs SET status='succeeded',completed_at=clock_timestamp(),locked_at=NULL,
   locked_by=NULL,lease_expires_at=NULL,last_error_safe=NULL,updated_at=clock_timestamp()
 WHERE id=p_job AND status='running' AND locked_by=p_worker AND claim_token=p_claim
   AND lease_expires_at>clock_timestamp();
 IF NOT FOUND THEN RAISE EXCEPTION 'summary claim expired' USING ERRCODE='42501'; END IF;
 RETURN r.id;
END $$;
REVOKE ALL ON FUNCTION platform.persist_memory_summary_job(uuid,text,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.persist_memory_summary_job(uuid,text,uuid,text) TO
      platform_messaging;
"""
