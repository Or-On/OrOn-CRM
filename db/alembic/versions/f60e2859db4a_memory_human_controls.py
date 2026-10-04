"""Immutable human corrections and independently attested memory review activation."""

from alembic import op
from sqlalchemy.schema import DDL

revision = "f60e2859db4a"
down_revision = "f5fd1748ca3f"
branch_labels = None
depends_on = None


def _execute(script):
    pending = ""
    for index, part in enumerate(script.split("$$")):
        if index % 2:
            pending += "$$" + part + "$$"
            continue
        pieces = part.split(";")
        pending += pieces[0]
        for piece in pieces[1:]:
            if pending.strip():
                op.execute(DDL(pending.replace("%", "%%")))
            pending = piece
    if pending.strip():
        op.execute(DDL(pending.replace("%", "%%")))


def upgrade():
    _execute(r"""
CREATE TABLE agents.memory_fact_corrections (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 contact_id uuid NOT NULL REFERENCES crm.contacts(id) ON DELETE RESTRICT,
 source_fact_id uuid NOT NULL REFERENCES agents.customer_memory_facts(id) ON DELETE RESTRICT,
 fact_key text NOT NULL CHECK(fact_key
IN('name','city','business_need','contact_preference','appointment_preference')),
 fact_value text CHECK(length(fact_value) BETWEEN 1 AND 1000),
 operation text NOT NULL CHECK(operation IN('correct','delete')),
 author_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((operation='delete' AND fact_value IS NULL) OR (operation='correct' AND fact_value IS NOT
NULL)));
ALTER TABLE agents.memory_fact_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.memory_fact_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY no_direct_corrections ON agents.memory_fact_corrections USING(false);

CREATE FUNCTION agents.correct_customer_memory_fact(p_fact uuid,p_value text,p_reason text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=platform.current_tenant_id(); actor uuid:=platform.current_user_id();
 source agents.customer_memory_facts%ROWTYPE; contact uuid; result uuid;
BEGIN
 IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 1 AND 1000
 OR (p_value IS NOT NULL AND length(trim(p_value)) NOT BETWEEN 1 AND 1000) THEN
 RAISE EXCEPTION 'invalid correction' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id
 JOIN public.tenants t ON t.id=m.tenant_id
 WHERE u.id=actor AND u.status='active' AND m.tenant_id=tenant AND t.status='active'
 AND m.role IN('owner','admin','service_manager') FOR SHARE OF u,m,t;
 IF NOT FOUND THEN RAISE EXCEPTION 'memory correction denied' USING ERRCODE='42501'; END IF;
 SELECT f.* INTO source FROM agents.customer_memory_facts f
 WHERE f.id=p_fact AND f.tenant_id=tenant FOR SHARE;
 SELECT c.contact_id INTO contact FROM agents.messaging_memory_sessions s
 JOIN messaging.conversations c ON c.id=s.conversation_id AND c.tenant_id=s.tenant_id
 WHERE s.id=source.session_id AND s.tenant_id=tenant AND c.removed_from_inbox_at IS NULL FOR SHARE
OF c;
 IF contact IS NULL THEN RAISE EXCEPTION 'memory correction denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM crm.contacts c WHERE c.id=contact AND c.tenant_id=tenant FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'memory correction denied' USING ERRCODE='42501'; END IF;
 INSERT INTO
agents.memory_fact_corrections(tenant_id,contact_id,source_fact_id,fact_key,fact_value,operation,author_user_id,reason)
 VALUES(tenant,contact,p_fact,source.fact_key,CASE WHEN p_value IS NULL THEN NULL ELSE
trim(p_value) END,
 CASE WHEN p_value IS NULL THEN 'delete' ELSE 'correct' END,actor,trim(p_reason)) RETURNING id
INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION agents.correct_customer_memory_fact(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.correct_customer_memory_fact(uuid,text,text) TO platform_web;

CREATE FUNCTION agents.read_session_memory_corrections(p_session uuid,p_agent uuid)
RETURNS TABLE(id uuid,fact_key text,fact_value text,operation text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT DISTINCT ON(correction.fact_key)
correction.id,correction.fact_key,correction.fact_value,correction.operation
 FROM agents.messaging_memory_sessions session
 JOIN messaging.conversations conversation ON conversation.id=session.conversation_id
 AND conversation.tenant_id=session.tenant_id
 JOIN agents.agent_profile_versions agent ON agent.id=conversation.ai_agent_profile_version_id AND
agent.tenant_id=session.tenant_id
 JOIN agents.agent_profiles profile ON profile.id=agent.agent_profile_id AND
profile.tenant_id=agent.tenant_id
 JOIN agents.memory_fact_corrections correction ON correction.contact_id=conversation.contact_id
AND correction.tenant_id=conversation.tenant_id
 WHERE session.id=p_session AND session.tenant_id=platform.current_tenant_id()
 AND session.agent_version_id=p_agent AND agent.id=p_agent
 AND agent.published_at IS NOT NULL AND agent.validation_status='valid' AND profile.archived_at IS
NULL
 AND conversation.ownership_mode='ai' AND conversation.removed_from_inbox_at IS NULL
 AND platform.messaging_ai_actor_authorized(conversation.ai_enabled_by_user_id)
 ORDER BY correction.fact_key,correction.created_at DESC,correction.id DESC
$$;
REVOKE ALL ON FUNCTION agents.read_session_memory_corrections(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.read_session_memory_corrections(uuid,uuid) TO platform_messaging;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE
rolname='platform_memory_review_controller') THEN
 CREATE ROLE platform_memory_review_controller NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT
NOCREATEROLE NOCREATEDB NOREPLICATION;
 ELSIF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='platform_memory_review_controller'
 AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR
rolreplication))
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE roleid=(SELECT oid FROM
pg_catalog.pg_roles WHERE rolname='platform_memory_review_controller')
 OR member=(SELECT oid FROM pg_catalog.pg_roles WHERE
rolname='platform_memory_review_controller')) THEN
 RAISE EXCEPTION 'hostile memory review capability role';
 END IF;
END $$;
CREATE TABLE agents.memory_real_source_attestations(
 request_id uuid PRIMARY KEY REFERENCES agents.memory_summary_requests(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 acquisition_digest text NOT NULL CHECK(acquisition_digest ~ '^[a-f0-9]{64}$'),
 attested_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE agents.memory_human_reviews(
 request_id uuid PRIMARY KEY REFERENCES agents.memory_summary_requests(id) ON DELETE RESTRICT,
 tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE RESTRICT,
 reviewer_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 rubric text NOT NULL CHECK(rubric='memory.v1'),
 approved boolean NOT NULL,reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE agents.memory_reviewed_activations(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE RESTRICT,
 activated_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
 rubric text NOT NULL CHECK(rubric='memory.v1'),activated_at timestamptz NOT NULL DEFAULT
clock_timestamp());
ALTER TABLE agents.memory_real_source_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.memory_real_source_attestations FORCE ROW LEVEL SECURITY;
CREATE POLICY no_direct_attestations ON agents.memory_real_source_attestations USING(false);
ALTER TABLE agents.memory_human_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.memory_human_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY review_tenant ON agents.memory_human_reviews
USING(tenant_id=platform.current_tenant_id());
ALTER TABLE agents.memory_reviewed_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.memory_reviewed_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY activation_tenant ON agents.memory_reviewed_activations
USING(tenant_id=platform.current_tenant_id());
CREATE FUNCTION agents.attest_real_memory_source(p_request uuid,p_acquisition_digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF p_acquisition_digest IS NULL OR p_acquisition_digest !~ '^[a-f0-9]{64}$' THEN
 RAISE EXCEPTION 'invalid acquisition evidence' USING ERRCODE='22023'; END IF;
 INSERT INTO agents.memory_real_source_attestations(request_id,tenant_id,acquisition_digest)
 SELECT id,tenant_id,p_acquisition_digest FROM agents.memory_summary_requests
 WHERE id=p_request AND tenant_id=platform.current_tenant_id() AND state='complete'
 AND summary_text IS NOT NULL ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'completed real source required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION agents.attest_real_memory_source(uuid,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA agents,platform TO platform_memory_review_controller;
GRANT EXECUTE ON FUNCTION platform.current_tenant_id() TO platform_memory_review_controller;
GRANT EXECUTE ON FUNCTION agents.attest_real_memory_source(uuid,text) TO
platform_memory_review_controller;
CREATE FUNCTION agents.review_memory_summary(p_request uuid,p_approved boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=platform.current_tenant_id();actor uuid:=platform.current_user_id();
BEGIN
 PERFORM 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id
 JOIN public.tenants t ON t.id=m.tenant_id WHERE u.id=actor AND u.status='active'
 AND m.tenant_id=tenant AND t.status='active' AND m.role IN('owner','admin','service_manager')
 FOR SHARE OF u,m,t;
 IF NOT FOUND OR p_approved IS NULL THEN RAISE EXCEPTION 'review denied' USING ERRCODE='42501';
END IF;
 INSERT INTO agents.memory_human_reviews(request_id,tenant_id,reviewer_id,rubric,approved)
 SELECT id,tenant_id,actor,'memory.v1',p_approved FROM agents.memory_summary_requests
 WHERE id=p_request AND tenant_id=tenant AND state='complete' AND summary_text IS NOT NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'completed summary required' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION agents.review_memory_summary(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.review_memory_summary(uuid,boolean) TO platform_web;
CREATE FUNCTION agents.memory_review_threshold_met(p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT count(*)>=50 FROM agents.memory_human_reviews review
 JOIN agents.memory_real_source_attestations real_source ON real_source.request_id=review.request_id
 AND real_source.tenant_id=review.tenant_id
 JOIN agents.memory_summary_requests request ON request.id=review.request_id AND
request.tenant_id=review.tenant_id
 WHERE review.tenant_id=p_tenant AND review.approved AND review.rubric='memory.v1'
 AND request.state='complete' AND request.summary_text IS NOT NULL
$$;
REVOKE ALL ON FUNCTION agents.memory_review_threshold_met(uuid) FROM PUBLIC;
CREATE FUNCTION agents.activate_reviewed_memory()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=platform.current_tenant_id();actor uuid:=platform.current_user_id();
BEGIN
 PERFORM 1 FROM public.users u JOIN public.memberships m ON m.user_id=u.id
 JOIN public.tenants t ON t.id=m.tenant_id WHERE u.id=actor AND u.status='active'
 AND m.tenant_id=tenant AND t.status='active' AND m.role IN('owner','admin','service_manager')
 FOR SHARE OF u,m,t;
 IF NOT FOUND OR NOT agents.memory_review_threshold_met(tenant) THEN
 RAISE EXCEPTION 'fifty real human-reviewed summaries required' USING ERRCODE='42501'; END IF;
 INSERT INTO agents.memory_reviewed_activations(tenant_id,activated_by,rubric)
 VALUES(tenant,actor,'memory.v1') ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION agents.activate_reviewed_memory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.activate_reviewed_memory() TO platform_web;
CREATE FUNCTION agents.reviewed_memory_active()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT platform.current_tenant_active() AND
agents.memory_review_threshold_met(platform.current_tenant_id())
 AND EXISTS(SELECT 1 FROM agents.memory_reviewed_activations WHERE
tenant_id=platform.current_tenant_id())
$$;
REVOKE ALL ON FUNCTION agents.reviewed_memory_active() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agents.reviewed_memory_active() TO
platform_messaging,platform_voice,platform_web;
""")


def downgrade():
    raise RuntimeError(
        "Memory correction audit removal requires a reviewed data retention procedure"
    )
