"""Tenant-bound, claim-guarded audio transcription checkpoints.

Revision ID: b9c581d2047e
Revises: a8e340b9c206
"""

from alembic import op

revision = "b9c581d2047e"
down_revision = "a8e340b9c206"
branch_labels = None
depends_on = None


def _execute_statements(script: str) -> None:
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(pending)
            pending = piece
    if pending.strip():
        op.execute(pending)


def upgrade():
    _execute_statements("""
      CREATE TABLE messaging.audio_transcription_work(
        operation_id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.tenants(id)
        ON DELETE RESTRICT,
        message_id uuid NOT NULL,  object_id uuid NOT NULL,  job_id uuid NOT NULL REFERENCES
        ops.jobs(id)
        ON DELETE RESTRICT,
        sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
        phase text NOT NULL DEFAULT 'new' CHECK(phase IN ('new','upload_inflight','uploaded',
          'submit_inflight','submitted','completed','failed','unknown')),
        version integer NOT NULL DEFAULT 0 CHECK(version>=0),
        attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
        cleanup_attempts integer NOT NULL DEFAULT 0 CHECK(cleanup_attempts BETWEEN 0 AND 3),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        file_id uuid, provider_job_id uuid, transcript text,
        terminal_handled boolean NOT NULL DEFAULT false,
        cleanup text NOT NULL DEFAULT 'none' CHECK(cleanup IN ('none', 'pending', 'complete',
        'blocked')),
        UNIQUE(tenant_id,message_id), UNIQUE(tenant_id,operation_id),
        FOREIGN KEY(tenant_id, message_id) REFERENCES messaging.messages(tenant_id, id)
        ON DELETE RESTRICT,
        FOREIGN KEY(tenant_id,object_id) REFERENCES objects.object_metadata(tenant_id,id)
        ON DELETE RESTRICT,
        CHECK(transcript IS NULL OR length(transcript) BETWEEN 1 AND 65536),
        CHECK(phase<>'completed' OR transcript IS NOT NULL),
        CHECK(phase NOT IN ('submitted', 'completed') OR (file_id IS NOT NULL AND provider_job_id IS
        NOT NULL))
      );
      CREATE INDEX audio_transcription_retry ON messaging.audio_transcription_work
        (tenant_id,next_attempt_at) WHERE phase NOT IN ('completed','failed','unknown');
      ALTER TABLE messaging.audio_transcription_work ENABLE ROW LEVEL SECURITY;
      ALTER TABLE messaging.audio_transcription_work FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON messaging.audio_transcription_work
        USING(tenant_id=platform.current_tenant_id()) WITH
        CHECK(tenant_id=platform.current_tenant_id());
      GRANT SELECT ON messaging.audio_transcription_work TO platform_messaging;
      CREATE FUNCTION messaging.protect_audio_work_identity() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog AS $$
      BEGIN
        IF (NEW.operation_id, NEW.tenant_id, NEW.message_id, NEW.object_id, NEW.job_id, NEW.sha256,
        NEW.created_at)
          IS DISTINCT FROM (OLD.operation_id, OLD.tenant_id, OLD.message_id, OLD.object_id,
          OLD.job_id, OLD.sha256, OLD.created_at)
          OR (OLD.file_id IS NOT NULL AND NEW.file_id IS DISTINCT FROM OLD.file_id)
          OR (OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM
          OLD.provider_job_id)
          OR (OLD.transcript IS NOT NULL AND NEW.transcript IS DISTINCT FROM OLD.transcript)
          OR (OLD.terminal_handled AND NOT NEW.terminal_handled) THEN
          RAISE EXCEPTION 'audio work identity is immutable' USING ERRCODE='22023';
        END IF;
        RETURN NEW;
      END $$;
      REVOKE ALL ON FUNCTION messaging.protect_audio_work_identity() FROM PUBLIC;
      CREATE TRIGGER audio_work_identity BEFORE UPDATE ON messaging.audio_transcription_work
        FOR EACH ROW EXECUTE FUNCTION messaging.protect_audio_work_identity();
      CREATE FUNCTION messaging.assert_audio_work_claim(p_job uuid,p_token uuid,p_message uuid)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
      BEGIN
        PERFORM 1 FROM ops.jobs j JOIN messaging.messages m
          ON m.tenant_id=j.tenant_id AND m.id=p_message
          JOIN public.tenants t ON t.id=j.tenant_id
          WHERE j.id=p_job AND j.tenant_id=platform.current_tenant_id() AND t.status='active'
            AND j.status='running' AND j.claim_token=p_token AND
            j.lease_expires_at>clock_timestamp()
            AND j.queue='messaging' AND j.job_type='whatsapp.audio.transcribe'
            AND j.payload->>'messageId'=p_message::text
            AND m.direction='inbound' AND m.provider='meta' AND m.content_type='audio'
          FOR UPDATE OF j;
        IF NOT FOUND THEN RAISE EXCEPTION 'audio work claim denied' USING ERRCODE='42501'; END IF;
      END $$;
      REVOKE ALL ON FUNCTION messaging.assert_audio_work_claim(uuid,uuid,uuid) FROM PUBLIC;
      CREATE FUNCTION messaging.begin_audio_transcription(
        p_operation uuid,p_message uuid,p_object uuid,p_sha text,p_job uuid,p_token uuid)
      RETURNS messaging.audio_transcription_work LANGUAGE plpgsql SECURITY DEFINER SET
      search_path=pg_catalog AS $$
      DECLARE v messaging.audio_transcription_work%ROWTYPE;
      BEGIN
        PERFORM messaging.assert_audio_work_claim(p_job,p_token,p_message);
        IF p_operation IS NULL OR p_sha IS NULL OR p_sha !~ '^[a-f0-9]{64}$'
          OR NOT EXISTS(SELECT 1 FROM messaging.messages m JOIN objects.object_metadata o
            ON o.tenant_id=m.tenant_id AND o.id=m.object_id
            WHERE m.id=p_message AND m.tenant_id=platform.current_tenant_id() AND
            m.object_id=p_object
              AND o.owner_type='message' AND o.owner_id=m.id AND o.status='available'
              AND o.deleted_at IS NULL AND o.checksum=p_sha AND o.content_type LIKE 'audio/%') THEN
          RAISE EXCEPTION 'audio object scope denied' USING ERRCODE='42501';
        END IF;
        INSERT INTO messaging.audio_transcription_work(operation_id, tenant_id, message_id,
        object_id, job_id, sha256)
          VALUES(p_operation,platform.current_tenant_id(),p_message,p_object,p_job,p_sha)
          ON CONFLICT(tenant_id,message_id) DO NOTHING;
        SELECT * INTO v FROM messaging.audio_transcription_work
          WHERE tenant_id=platform.current_tenant_id() AND message_id=p_message FOR UPDATE;
        IF (v.operation_id, v.object_id, v.job_id, v.sha256) IS DISTINCT FROM (p_operation,
        p_object, p_job, p_sha) THEN
          RAISE EXCEPTION 'audio work binding conflict' USING ERRCODE='22023';
        END IF;
        RETURN v;
      END $$;
      REVOKE ALL ON FUNCTION messaging.begin_audio_transcription(uuid, uuid, uuid, text, uuid, uuid)
      FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION messaging.begin_audio_transcription(uuid, uuid, uuid, text, uuid,
      uuid) TO platform_messaging;
      CREATE FUNCTION messaging.advance_audio_transcription(p_operation uuid, p_job uuid, p_token
      uuid, p_version integer, p_patch jsonb)
      RETURNS messaging.audio_transcription_work LANGUAGE plpgsql SECURITY DEFINER SET
      search_path=pg_catalog AS $$
      DECLARE v messaging.audio_transcription_work%ROWTYPE; next_phase text;
      BEGIN
        SELECT * INTO v FROM messaging.audio_transcription_work
          WHERE operation_id=p_operation AND tenant_id=platform.current_tenant_id();
        IF v.operation_id IS NULL OR v.job_id IS DISTINCT FROM p_job THEN
          RAISE EXCEPTION 'audio work scope denied' USING ERRCODE='42501'; END IF;
        PERFORM messaging.assert_audio_work_claim(p_job,p_token,v.message_id);
        SELECT * INTO v FROM messaging.audio_transcription_work
          WHERE operation_id=p_operation AND tenant_id=platform.current_tenant_id() FOR UPDATE;
        IF v.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'audio work CAS lost' USING
        ERRCODE='40001'; END IF;
        IF p_patch IS NULL OR jsonb_typeof(p_patch)<>'object' OR EXISTS(
          SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN ('phase', 'attempts',
          'nextAttemptAt',
          'fileId','providerJobId','transcript','terminalHandled','cleanup','cleanupAttempts')) THEN
          RAISE EXCEPTION 'invalid audio work patch' USING ERRCODE='22023'; END IF;
        next_phase:=coalesce(p_patch->>'phase',v.phase);
        IF next_phase<>v.phase AND NOT (
          (v.phase='new' AND next_phase IN ('upload_inflight','failed','unknown')) OR
          (v.phase='upload_inflight' AND next_phase IN ('uploaded','new','failed','unknown')) OR
          (v.phase='uploaded' AND next_phase IN ('submit_inflight','failed','unknown')) OR
          (v.phase='submit_inflight' AND next_phase IN ('submitted', 'uploaded', 'failed',
          'unknown')) OR
          (v.phase='submitted' AND next_phase IN ('completed','failed','unknown'))) THEN
          RAISE EXCEPTION 'audio work transition denied' USING ERRCODE='22023'; END IF;
        IF (p_patch ? 'attempts' AND (p_patch->>'attempts')::integer NOT BETWEEN v.attempts AND
        v.attempts+1)
          OR (p_patch ? 'cleanupAttempts' AND (p_patch->>'cleanupAttempts')::integer NOT BETWEEN
          v.cleanup_attempts AND v.cleanup_attempts+1) THEN
          RAISE EXCEPTION 'audio attempt counter denied' USING ERRCODE='22023'; END IF;
        UPDATE messaging.audio_transcription_work SET phase=next_phase,version=version+1,
          attempts=coalesce((p_patch->>'attempts')::integer,attempts),
          cleanup_attempts=coalesce((p_patch->>'cleanupAttempts')::integer,cleanup_attempts),
          next_attempt_at=coalesce(to_timestamp((p_patch->>'nextAttemptAt')::double precision/1000),
          next_attempt_at),
          file_id=coalesce((p_patch->>'fileId')::uuid, file_id),
          provider_job_id=coalesce((p_patch->>'providerJobId')::uuid, provider_job_id),
          transcript=coalesce(p_patch->>'transcript', transcript),
          terminal_handled=coalesce((p_patch->>'terminalHandled')::boolean, terminal_handled),
          cleanup=coalesce(p_patch->>'cleanup',cleanup),updated_at=clock_timestamp()
          WHERE operation_id=p_operation RETURNING * INTO v;
        RETURN v;
      END $$;
      REVOKE ALL ON FUNCTION messaging.advance_audio_transcription(uuid, uuid, uuid, integer, jsonb)
      FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION messaging.advance_audio_transcription(uuid, uuid, uuid, integer,
      jsonb) TO platform_messaging;
    """)


def downgrade():
    _execute_statements("""
      DROP FUNCTION messaging.advance_audio_transcription(uuid,uuid,uuid,integer,jsonb);
      DROP FUNCTION messaging.begin_audio_transcription(uuid,uuid,uuid,text,uuid,uuid);
      DROP FUNCTION messaging.assert_audio_work_claim(uuid,uuid,uuid);
      DROP TABLE messaging.audio_transcription_work;
      DROP FUNCTION messaging.protect_audio_work_identity();
    """)
