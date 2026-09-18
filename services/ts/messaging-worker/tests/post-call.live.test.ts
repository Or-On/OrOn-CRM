import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  applyCustomerConfirmation,
  applyPostCallOutcome,
  awaitingCustomerTicket,
  beginPostCallAnalysis,
  bindTicketCallAttemptSession,
  callOutcomeFromSession,
  classifyCustomerReply,
  failPostCallAnalysis,
  followupMessage,
  getTicketDetail,
  loadFollowupPlan,
  loadPostCallWork,
  openOrAttachTicket,
  openTicketCallAttempt,
  recordArtifactVerification,
  recordFollowupOutcome,
  recordPostCallAnalysis,
  schedulePostCallFollowup,
  skipPostCallAnalysis,
  summarizeTicketOutcomes,
  type PostCallAnalysis,
  type VerifiedArtifact,
  type VerifiedTranscript,
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

describe.skipIf(sourceUrl === undefined)("durable post-call pipeline", () => {
  const databaseName = `oron_postcall_test_${randomUUID().replaceAll("-", "")}`;
  let maintenance: postgres.Sql;
  let admin: postgres.Sql;
  let web: postgres.Sql;
  const cleanup: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    if (sourceUrl === undefined)
      throw new Error("explicit PostgreSQL test URL required");
    const url = new URL(sourceUrl);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new Error("isolated post-call tests require localhost PostgreSQL");
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
    web = postgres(url.toString(), { max: 3 });
    cleanup.push(() => web.end());
  }, 180_000);

  afterAll(async () => {
    for (const close of cleanup.reverse()) await close();
  });

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

  async function contact(name: string, tenant = tenantId): Promise<string> {
    const contactId = randomUUID();
    await admin`
      INSERT INTO crm.contacts (id, tenant_id, name, whatsapp_consent)
      VALUES (${contactId}::uuid, ${tenant}::uuid, ${name}, 'granted')
    `;
    return contactId;
  }

  /** A terminal session row, as the voice runtime would have left one. */
  async function session(
    options: {
      readonly status?: "started" | "ended" | "failed";
      readonly answered?: boolean | null;
      readonly outcome?: string | null;
      readonly tenant?: string;
    } = {},
  ): Promise<string> {
    const sessionId = randomUUID();
    await admin`
      INSERT INTO public.sessions
        (session_id, tenant_id, provider, direction, room, flow_id, status,
         answered, outcome)
      VALUES (${sessionId}::uuid, ${options.tenant ?? tenantId}::uuid,
              'simulator', 'outbound', ${`test:${sessionId}`},
              '00000000-0000-0000-0000-000000000000'::uuid,
              ${options.status ?? "started"}, ${options.answered ?? null},
              ${options.outcome ?? null})
    `;
    return sessionId;
  }

  async function endSession(
    sessionId: string,
    options: {
      readonly status?: "ended" | "failed";
      readonly answered?: boolean | null;
      readonly outcome?: string | null;
    } = {},
  ): Promise<void> {
    await admin`
      SELECT set_config('app.current_tenant', ${tenantId}, true)
    `;
    await admin`
      UPDATE public.sessions
      SET status = ${options.status ?? "ended"},
          answered = ${options.answered ?? true},
          outcome = ${options.outcome ?? null},
          ended_at = CURRENT_TIMESTAMP
      WHERE session_id = ${sessionId}::uuid
    `;
  }

  interface Issue {
    readonly ticketId: string;
    readonly attemptId: string;
    readonly contactId: string;
  }

  async function issueWithAttempt(subject: string): Promise<Issue> {
    const contactId = await contact(`Fictional ${subject}`);
    const jobId = randomUUID();
    return scoped(async (tx) => {
      const opened = await openOrAttachTicket(tx, userId, {
        contactId,
        subject,
        attachmentKey: `postcall-${randomUUID()}`,
      });
      const attempt = await openTicketCallAttempt(tx, {
        ticketId: opened.ticket.id,
        jobId,
      });
      return { ticketId: opened.ticket.id, attemptId: attempt.id, contactId };
    });
  }

  /**
   * An issue whose call has run and finished, admitted by the terminal-session
   * trigger exactly as a real one would be.
   */
  async function admittedIssue(
    subject: string,
    options: {
      readonly status?: "ended" | "failed";
      readonly answered?: boolean | null;
      readonly outcome?: string | null;
    } = {},
  ): Promise<Issue & { readonly sessionId: string }> {
    const issue = await issueWithAttempt(subject);
    const sessionId = await session();
    await scoped((tx) =>
      bindTicketCallAttemptSession(tx, issue.attemptId, sessionId),
    );
    await endSession(sessionId, options);
    return { ...issue, sessionId };
  }

  function recording(
    overrides: Partial<VerifiedArtifact> = {},
  ): VerifiedArtifact {
    const key = `conversations/${randomUUID()}/recordings/merged_audio.wav`;
    return {
      state: "ready",
      detail: "verified",
      byteSize: 320_044,
      durationSeconds: 10,
      contentType: "audio/wav",
      checksum: "a".repeat(64),
      storageBackend: "local",
      storageKey: key,
      ...overrides,
    };
  }

  function transcript(
    overrides: Partial<VerifiedTranscript> = {},
  ): VerifiedTranscript {
    const key = `conversations/${randomUUID()}/transcripts/transcript.txt`;
    return {
      state: "valid",
      detail: "verified",
      byteSize: 420,
      turnCount: 8,
      contentType: "text/plain; charset=utf-8",
      checksum: "b".repeat(64),
      storageBackend: "local",
      storageKey: key,
      ...overrides,
    };
  }

  function analysis(
    overrides: Partial<PostCallAnalysis> = {},
  ): PostCallAnalysis {
    return {
      schemaVersion: "1.0",
      issue: "Internet drops every evening.",
      customerFacts: [],
      priorContext: [],
      actionsAttempted: [],
      actionsCompleted: [],
      unresolvedItems: [],
      commitments: [],
      nextAction: null,
      recommendedOwner: null,
      sentiment: null,
      sentimentSources: [],
      resolution: "unresolved",
      resolutionConfirmationSource: "none",
      classificationConfidence: "medium",
      classificationSources: [],
      ...overrides,
    };
  }

  it("admits exactly one pipeline however many terminal webhooks arrive", async () => {
    const issue = await issueWithAttempt("Duplicate terminal webhook");
    const sessionId = await session();
    await scoped((tx) =>
      bindTicketCallAttemptSession(tx, issue.attemptId, sessionId),
    );

    await endSession(sessionId);
    // LiveKit's room-finished webhook and the transport's participant-left
    // event race by design; a status correction rewrites the row again.
    await endSession(sessionId, { status: "failed" });
    await endSession(sessionId, { status: "ended" });

    const jobs = await admin`
      SELECT count(*)::int AS total FROM ops.jobs
      WHERE tenant_id = ${tenantId}::uuid
        AND job_type = 'support.postcall.process'
        AND reference_id = ${issue.attemptId}::uuid
    `;
    expect(jobs[0]?.total).toBe(1);
    const attempt = await admin`
      SELECT post_call_stage FROM support.ticket_call_attempts
      WHERE id = ${issue.attemptId}::uuid
    `;
    expect(attempt[0]?.post_call_stage).toBe("artifacts_pending");
  });

  it("enqueues from the binding when the call ended before it was bound", async () => {
    const issue = await issueWithAttempt("Terminal before binding");
    // The dispatcher accepted the dial and the call was over before the
    // worker's acceptance transaction ran, so no trigger ever saw an attempt.
    const sessionId = await session({
      status: "ended",
      answered: false,
      outcome: "no_answer",
    });

    await scoped((tx) =>
      bindTicketCallAttemptSession(tx, issue.attemptId, sessionId),
    );

    const jobs = await admin`
      SELECT count(*)::int AS total FROM ops.jobs
      WHERE reference_id = ${issue.attemptId}::uuid
        AND job_type = 'support.postcall.process'
    `;
    expect(jobs[0]?.total).toBe(1);
  });

  it("numbers concurrent attempts on one issue without collision", async () => {
    const issue = await issueWithAttempt("Concurrent attempts");
    const jobs = [randomUUID(), randomUUID(), randomUUID()];

    const created = await Promise.all(
      jobs.map((jobId) =>
        scoped((tx) =>
          openTicketCallAttempt(tx, { ticketId: issue.ticketId, jobId }),
        ),
      ),
    );

    expect(created.map((attempt) => attempt.attemptNumber).toSorted()).toEqual([
      2, 3, 4,
    ]);
  });

  it("returns the same attempt for a redelivered call job", async () => {
    const issue = await issueWithAttempt("Redelivered call job");
    const jobId = randomUUID();

    const first = await scoped((tx) =>
      openTicketCallAttempt(tx, { ticketId: issue.ticketId, jobId }),
    );
    const repeat = await scoped((tx) =>
      openTicketCallAttempt(tx, { ticketId: issue.ticketId, jobId }),
    );

    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.id).toBe(first.id);
  });

  /**
   * Run the pipeline's artifact step, then either its analysis step or the
   * `not_applicable` skip, leaving the attempt where the ticket update expects
   * it. Every stage transition is conditional, so tests have to walk them.
   */
  async function verifyArtifacts(
    issue: Issue & { readonly sessionId: string },
    callOutcome: Parameters<
      typeof recordArtifactVerification
    >[2]["callOutcome"],
    artifacts: {
      readonly recording?: VerifiedArtifact;
      readonly transcript?: VerifiedTranscript;
    } = {},
  ) {
    return scoped((tx) =>
      recordArtifactVerification(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        sessionId: issue.sessionId,
        callOutcome,
        recording: artifacts.recording ?? recording(),
        transcript: artifacts.transcript ?? transcript(),
      }),
    );
  }

  async function readyForOutcome(
    subject: string,
    options: {
      readonly callOutcome?: Parameters<
        typeof recordArtifactVerification
      >[2]["callOutcome"];
      readonly analysis?: PostCallAnalysis;
    } = {},
  ): Promise<Issue & { readonly sessionId: string }> {
    const callOutcome = options.callOutcome ?? "answered";
    const issue = await admittedIssue(subject, {
      answered: callOutcome === "answered",
    });
    const verified = await verifyArtifacts(issue, callOutcome);
    const produced = options.analysis;
    if (verified.analysable && produced !== undefined) {
      await scoped((tx) => beginPostCallAnalysis(tx, issue.attemptId));
      await scoped((tx) =>
        recordPostCallAnalysis(tx, {
          attemptId: issue.attemptId,
          analysis: produced,
          modelSafe: "fixture-model",
        }),
      );
    } else await scoped((tx) => skipPostCallAnalysis(tx, issue.attemptId));
    return issue;
  }

  /** Walk an issue all the way to a queued wrap-up, as the pipeline does. */
  async function readyForFollowup(
    subject: string,
  ): Promise<Issue & { readonly sessionId: string }> {
    const proposed = analysis({
      resolution: "proposed_fix_awaiting_confirmation",
    });
    const issue = await readyForOutcome(subject, { analysis: proposed });
    await scoped(async (tx) => {
      const applied = await applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: proposed,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      });
      await schedulePostCallFollowup(tx, {
        attemptId: issue.attemptId,
        required: applied.followupRequired,
      });
    });
    return issue;
  }

  it("registers a verified recording so the ready state has an object behind it", async () => {
    const issue = await admittedIssue("Verified recording", { answered: true });

    const outcome = await verifyArtifacts(issue, "answered");

    expect(outcome.recordingState).toBe("ready");
    expect(outcome.analysable).toBe(true);
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    const attempt = detail?.attempts[0];
    expect(attempt?.recordingObjectId).not.toBeNull();
    expect(attempt?.transcriptObjectId).not.toBeNull();
    expect(attempt?.recordingDurationSeconds).toBe(10);
    expect(attempt?.transcriptTurnCount).toBe(8);
    const object = await admin`
      SELECT content_type, byte_size, status FROM objects.object_metadata
      WHERE id = ${attempt?.recordingObjectId ?? null}::uuid
    `;
    expect(object[0]?.content_type).toBe("audio/wav");
    expect(object[0]?.status).toBe("available");
  });

  it("labels a fragment partial instead of a complete call", async () => {
    const issue = await admittedIssue("Partial recording", {
      status: "failed",
      answered: true,
    });

    const outcome = await verifyArtifacts(issue, "disconnected", {
      recording: recording({
        state: "partial",
        detail: "short_but_present",
        durationSeconds: 0.4,
      }),
      transcript: transcript({ state: "partial", turnCount: 2 }),
    });

    expect(outcome.recordingState).toBe("partial");
    // A failed call may legitimately have a fragment, and the fragment must
    // never be presented as the recording of a conversation.
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.attempts[0]?.recordingState).toBe("partial");
    expect(detail?.attempts[0]?.recordingObjectId).not.toBeNull();
  });

  it("keeps a transcript usable when its recording never arrived", async () => {
    const issue = await admittedIssue("Transcript without recording", {
      answered: true,
    });

    const outcome = await verifyArtifacts(issue, "answered", {
      recording: recording({
        state: "unavailable",
        detail: "bytes_unavailable",
        byteSize: null,
        durationSeconds: null,
        contentType: null,
        checksum: null,
        storageBackend: null,
        storageKey: null,
      }),
    });

    // The summary is still owed: a missing recording is a fact about the call,
    // not a reason to stop processing it.
    expect(outcome.recordingState).toBe("unavailable");
    expect(outcome.analysable).toBe(true);
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.attempts[0]?.recordingObjectId).toBeNull();
    expect(detail?.attempts[0]?.summaryState).toBe("pending");
  });

  it("owes no summary when the recording arrived and nothing was said", async () => {
    const issue = await admittedIssue("Recording without transcript", {
      answered: true,
    });

    const outcome = await verifyArtifacts(issue, "answered", {
      transcript: transcript({
        state: "missing",
        detail: "bytes_unavailable",
        turnCount: 0,
        contentType: null,
        checksum: null,
        storageBackend: null,
        storageKey: null,
      }),
    });

    expect(outcome.analysable).toBe(false);
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    // Honest: there was nothing to summarise, which is not the same as a
    // summary that failed to be produced.
    expect(detail?.attempts[0]?.summaryState).toBe("not_applicable");
  });

  it("classifies busy, no answer and failure as distinct non-conversations", () => {
    expect(callOutcomeFromSession("ended", false, "busy")).toBe("busy");
    expect(callOutcomeFromSession("ended", false, "no_answer")).toBe(
      "no_answer",
    );
    expect(callOutcomeFromSession("failed", false, null)).toBe("failed");
    expect(callOutcomeFromSession("failed", true, null)).toBe("disconnected");
    expect(callOutcomeFromSession("ended", true, "completed")).toBe("answered");
    expect(callOutcomeFromSession("ended", false, "provider_timeout")).toBe(
      "provider_timeout",
    );
  });

  it("never resolves an issue from a call nobody answered", async () => {
    const issue = await admittedIssue("Nobody answered", {
      answered: false,
      outcome: "no_answer",
    });
    await verifyArtifacts(issue, "no_answer", {
      recording: recording({
        state: "unavailable",
        detail: "no_uri",
        byteSize: null,
        durationSeconds: null,
        contentType: null,
        checksum: null,
        storageBackend: null,
        storageKey: null,
      }),
      transcript: transcript({
        state: "missing",
        detail: "no_uri",
        turnCount: 0,
        contentType: null,
        checksum: null,
        storageBackend: null,
        storageKey: null,
      }),
    });
    await scoped((tx) => skipPostCallAnalysis(tx, issue.attemptId));

    const applied = await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: null,
        callOutcome: "no_answer",
        transcriptState: "missing",
        sessionId: issue.sessionId,
      }),
    );

    expect(applied.decision.resolution).toBe("unresolved");
    expect(applied.followupRequired).toBe(false);
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.resolutionClassification).toBe("unresolved");
    expect(detail?.ticket.resolutionConfirmedBy).toBe("none");
  });

  it("records a confirmed resolution and still asks the customer", async () => {
    const confirmed = analysis({
      resolution: "resolved",
      resolutionConfirmationSource: "customer_call",
      classificationConfidence: "high",
      classificationSources: [{ kind: "transcript_turn", reference: "9" }],
      nextAction: "Watch the line overnight.",
    });
    const issue = await readyForOutcome("Confirmed on the call", {
      analysis: confirmed,
    });

    const applied = await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: confirmed,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    expect(applied.decision.resolution).toBe("resolved");
    expect(applied.decision.confirmedBy).toBe("customer");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.status).toBe("open");
    expect(detail?.ticket.stage).toBe("awaiting_customer");
    expect(detail?.ticket.nextAction).toBe("Watch the line overnight.");
  });

  it("refuses to promote a model's unevidenced resolution claim", async () => {
    const claimed = analysis({
      resolution: "resolved",
      resolutionConfirmationSource: "customer_call",
      classificationConfidence: "high",
      classificationSources: [],
    });
    const issue = await readyForOutcome("Claimed without evidence", {
      analysis: claimed,
    });

    await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: claimed,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.resolutionClassification).toBe(
      "proposed_fix_awaiting_confirmation",
    );
    expect(detail?.ticket.resolutionConfirmedBy).toBe("none");
  });

  it("hands the issue to a person when the customer asked for one", async () => {
    const needsHuman = analysis({ resolution: "needs_human" });
    const issue = await readyForOutcome("Asked for a person", {
      analysis: needsHuman,
    });

    await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: needsHuman,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.handlingMode).toBe("human");
    expect(detail?.ticket.stage).toBe("awaiting_human");
  });

  it("produces one outcome however many times the job is redelivered", async () => {
    const issue = await readyForOutcome("Redelivered post-call job", {
      analysis: analysis(),
    });

    const apply = () =>
      scoped(async (tx) => {
        const applied = await applyPostCallOutcome(tx, userId, {
          attemptId: issue.attemptId,
          ticketId: issue.ticketId,
          analysis: analysis(),
          callOutcome: "answered",
          transcriptState: "valid",
          sessionId: issue.sessionId,
        });
        await schedulePostCallFollowup(tx, {
          attemptId: issue.attemptId,
          required: applied.followupRequired,
        });
        return applied;
      });
    await apply();
    // A worker restart between the update and the job completion delivers the
    // same job again.
    await apply();
    await apply();

    const summaries = await admin`
      SELECT count(*)::int AS total FROM support.ticket_events
      WHERE ticket_id = ${issue.ticketId}::uuid AND kind = 'summary'
    `;
    const followups = await admin`
      SELECT count(*)::int AS total FROM ops.jobs
      WHERE reference_id = ${issue.attemptId}::uuid
        AND job_type = 'support.postcall.followup'
    `;
    expect(summaries[0]?.total).toBe(1);
    expect(followups[0]?.total).toBe(1);
  });

  it("keeps the ticket and artifacts when the analysis provider fails", async () => {
    const issue = await admittedIssue("Provider timeout", { answered: true });
    await verifyArtifacts(issue, "answered");

    await scoped((tx) => beginPostCallAnalysis(tx, issue.attemptId));
    await scoped((tx) =>
      failPostCallAnalysis(tx, {
        attemptId: issue.attemptId,
        errorSafe: "analysis_timeout",
        permanent: false,
      }),
    );

    const retryable = await scoped((tx) =>
      loadPostCallWork(tx, issue.attemptId),
    );
    // Retryable: back to the stage before the analysis, with the artifacts and
    // the reason intact and nothing fabricated in between.
    expect(retryable?.stage).toBe("artifacts_verified");
    expect(retryable?.summaryState).toBe("pending");
    expect(retryable?.recordingState).toBe("ready");
    expect(retryable?.analysis).toBeNull();

    await scoped((tx) => beginPostCallAnalysis(tx, issue.attemptId));
    await scoped((tx) =>
      failPostCallAnalysis(tx, {
        attemptId: issue.attemptId,
        errorSafe: "analysis_invalid_output",
        permanent: true,
      }),
    );
    const exhausted = await scoped((tx) =>
      loadPostCallWork(tx, issue.attemptId),
    );
    expect(exhausted?.summaryState).toBe("failed");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.attempts[0]?.postCallErrorSafe).toBe(
      "analysis_invalid_output",
    );
  });

  it("still reaches a ticket outcome after the analysis permanently failed", async () => {
    const issue = await admittedIssue("Outcome without a summary", {
      answered: true,
    });
    await verifyArtifacts(issue, "answered");
    await scoped((tx) => beginPostCallAnalysis(tx, issue.attemptId));
    await scoped((tx) =>
      failPostCallAnalysis(tx, {
        attemptId: issue.attemptId,
        errorSafe: "analysis_provider_unavailable",
        permanent: true,
      }),
    );

    const applied = await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: null,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    // Without a summary the safest reading is the only honest one, and the
    // issue still moves rather than sitting in the queue forever.
    expect(applied.decision.resolution).toBe("unresolved");
    expect(applied.decision.reason).toBe("analysis_unavailable");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.attempts[0]?.postCallStage).toBe("ticket_updated");
    expect(detail?.attempts[0]?.summaryState).toBe("failed");
    expect(detail?.attempts[0]?.recordingState).toBe("ready");
  });

  it("refuses to call a summary ready without the analysis behind it", async () => {
    const issue = await issueWithAttempt("Summary without analysis");

    await expect(
      admin`
        UPDATE support.ticket_call_attempts SET summary_state = 'ready'
        WHERE id = ${issue.attemptId}::uuid
      `,
    ).rejects.toThrow(/ck_support_attempt_summary_ready_has_analysis/u);
  });

  it("refuses to call a transcript usable without the call it came from", async () => {
    const issue = await issueWithAttempt("Transcript without a session");

    await expect(
      admin`
        UPDATE support.ticket_call_attempts SET transcript_state = 'valid'
        WHERE id = ${issue.attemptId}::uuid
      `,
    ).rejects.toThrow(/ck_support_attempt_transcript_needs_session/u);
  });

  it("leaves a ticket an operator closed during processing closed", async () => {
    const issue = await readyForOutcome("Closed mid-processing", {
      analysis: analysis(),
    });
    await admin`
      UPDATE support.tickets
      SET status = 'closed', stage = 'closed', closure_reason = 'administrative',
          closed_at = CURRENT_TIMESTAMP
      WHERE id = ${issue.ticketId}::uuid
    `;

    const applied = await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: analysis({
          resolution: "resolved",
          resolutionConfirmationSource: "customer_call",
          classificationConfidence: "high",
          classificationSources: [{ kind: "transcript_turn", reference: "4" }],
        }),
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    // The operator saw the call and made a decision; a late pipeline run must
    // not reopen it or overwrite the closure reason.
    expect(applied.followupRequired).toBe(false);
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.status).toBe("closed");
    expect(detail?.ticket.closureReason).toBe("administrative");
    expect(detail?.ticket.resolutionClassification).not.toBe("resolved");
  });

  it("blocks the wrap-up when consent was withdrawn after the call", async () => {
    const issue = await readyForFollowup("Opted out before the follow-up");
    await admin`
      UPDATE crm.contacts
      SET whatsapp_consent = 'revoked', whatsapp_opted_out_at = CURRENT_TIMESTAMP
      WHERE id = ${issue.contactId}::uuid
    `;

    const plan = await scoped((tx) => loadFollowupPlan(tx, issue.attemptId));

    expect(plan).toBe("blocked_consent");
    await scoped((tx) =>
      recordFollowupOutcome(tx, {
        attemptId: issue.attemptId,
        state: "blocked_consent",
        errorSafe: "consent_withdrawn_before_sending",
      }),
    );
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.attempts[0]?.followupState).toBe("blocked_consent");
  });

  it("keeps the call summary when the wrap-up send fails", async () => {
    const issue = await readyForFollowup("Follow-up provider failure");

    await scoped((tx) =>
      recordFollowupOutcome(tx, {
        attemptId: issue.attemptId,
        state: "failed",
        errorSafe: "whatsapp_transport_error",
      }),
    );

    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    // A messaging failure is a messaging failure. The analysed call, its
    // verified artifacts and the ticket outcome all stand.
    expect(detail?.attempts[0]?.followupState).toBe("failed");
    expect(detail?.attempts[0]?.summaryState).toBe("ready");
    expect(detail?.attempts[0]?.recordingState).toBe("ready");
    expect(detail?.ticket.resolutionClassification).toBe(
      "proposed_fix_awaiting_confirmation",
    );
  });

  it("queues one wrap-up when two retries schedule it at once", async () => {
    const proposed = analysis({
      resolution: "proposed_fix_awaiting_confirmation",
    });
    const issue = await readyForOutcome("Concurrent wrap-up scheduling", {
      analysis: proposed,
    });
    await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: issue.attemptId,
        ticketId: issue.ticketId,
        analysis: proposed,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: issue.sessionId,
      }),
    );

    await Promise.all([
      scoped((tx) =>
        schedulePostCallFollowup(tx, {
          attemptId: issue.attemptId,
          required: true,
        }),
      ),
      scoped((tx) =>
        schedulePostCallFollowup(tx, {
          attemptId: issue.attemptId,
          required: true,
        }),
      ),
    ]);

    const jobs = await admin`
      SELECT count(*)::int AS total FROM ops.jobs
      WHERE reference_id = ${issue.attemptId}::uuid
        AND job_type = 'support.postcall.followup'
    `;
    expect(jobs[0]?.total).toBe(1);
  });

  it("refuses to claim a wrap-up was sent without the message that carried it", async () => {
    const issue = await issueWithAttempt("Sent without a message");

    await expect(
      admin`
        UPDATE support.ticket_call_attempts SET followup_state = 'sent'
        WHERE id = ${issue.attemptId}::uuid
      `,
    ).rejects.toThrow(/ck_support_attempt_followup_sent_has_message/u);
  });

  it("writes the wrap-up in the customer's language with the reply contract", () => {
    const hebrew = followupMessage({
      resolution: "resolved",
      ticketReference: "T-2026-ABCD1234",
      ticketSubject: "האינטרנט נופל",
      nextAction: null,
      locale: "he",
    });
    const english = followupMessage({
      resolution: "unresolved",
      ticketReference: "T-2026-ABCD1234",
      ticketSubject: "Internet drops",
      nextAction: "A technician will call back.",
      locale: "en",
    });

    expect(hebrew).toContain("הבעיה נפתרה");
    expect(hebrew).toContain("1 – נפתר");
    expect(hebrew).toContain("T-2026-ABCD1234");
    expect(english).toContain("still open");
    expect(english).toContain("A technician will call back.");
    expect(english).toContain("3 – Talk to a person");
    // Internal reasoning never reaches the customer.
    expect(hebrew).not.toMatch(/analysis|schema|confidence/iu);
  });

  it("closes the issue on an explicit WhatsApp confirmation", async () => {
    const issue = await issueWithAttempt("Confirmed by WhatsApp");
    const messageId = randomUUID();
    await admin`
      UPDATE support.tickets SET stage = 'awaiting_customer'
      WHERE id = ${issue.ticketId}::uuid
    `;

    const result = await scoped((tx) =>
      applyCustomerConfirmation(tx, userId, {
        ticketId: issue.ticketId,
        intent: classifyCustomerReply("כן, עכשיו עובד") as "confirmed_resolved",
        messageId,
      }),
    );

    expect(result).toBe("resolved");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.status).toBe("closed");
    expect(detail?.ticket.resolutionConfirmedBy).toBe("customer");
    expect(detail?.ticket.closureReason).toBe("resolved");
  });

  it("keeps the issue open when the customer says it is still broken", async () => {
    const issue = await issueWithAttempt("Still broken by WhatsApp");
    await admin`
      UPDATE support.tickets SET stage = 'awaiting_customer'
      WHERE id = ${issue.ticketId}::uuid
    `;

    const result = await scoped((tx) =>
      applyCustomerConfirmation(tx, userId, {
        ticketId: issue.ticketId,
        intent: "still_broken",
        messageId: randomUUID(),
      }),
    );

    expect(result).toBe("still_open");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.status).toBe("open");
    expect(detail?.ticket.resolutionClassification).toBe("unresolved");
  });

  it("escalates to a person on a WhatsApp request for one", async () => {
    const issue = await issueWithAttempt("Person by WhatsApp");
    await admin`
      UPDATE support.tickets SET stage = 'awaiting_customer'
      WHERE id = ${issue.ticketId}::uuid
    `;

    const result = await scoped((tx) =>
      applyCustomerConfirmation(tx, userId, {
        ticketId: issue.ticketId,
        intent: "wants_human",
        messageId: randomUUID(),
      }),
    );

    expect(result).toBe("escalated");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.handlingMode).toBe("human");
    expect(detail?.ticket.stage).toBe("awaiting_human");
  });

  it("ignores a second confirmation for an issue already closed by the first", async () => {
    const issue = await issueWithAttempt("Replayed confirmation");
    await admin`
      UPDATE support.tickets SET stage = 'awaiting_customer'
      WHERE id = ${issue.ticketId}::uuid
    `;
    const messageId = randomUUID();

    const first = await scoped((tx) =>
      applyCustomerConfirmation(tx, userId, {
        ticketId: issue.ticketId,
        intent: "confirmed_resolved",
        messageId,
      }),
    );
    const replay = await scoped((tx) =>
      applyCustomerConfirmation(tx, userId, {
        ticketId: issue.ticketId,
        intent: "confirmed_resolved",
        messageId,
      }),
    );

    expect(first).toBe("resolved");
    expect(replay).toBe("ignored");
    const events = await admin`
      SELECT count(*)::int AS total FROM support.ticket_events
      WHERE ticket_id = ${issue.ticketId}::uuid AND kind = 'customer_update'
    `;
    expect(events[0]?.total).toBe(1);
  });

  it("leaves the issue alone when the reply is a new problem", async () => {
    const issue = await issueWithAttempt("Unrelated new problem");
    await admin`
      UPDATE support.tickets SET stage = 'awaiting_customer'
      WHERE id = ${issue.ticketId}::uuid
    `;
    const intent = classifyCustomerReply(
      "אגב, גם החשבונית של החודש שעבר שגויה",
    );

    // The reply never reaches the ticket: an unclear answer is not an answer,
    // and a customer raising something else must not resolve the old issue.
    expect(intent).toBe("unclear");
    const detail = await scoped((tx) => getTicketDetail(tx, issue.ticketId));
    expect(detail?.ticket.status).toBe("open");
    expect(detail?.ticket.stage).toBe("awaiting_customer");
    expect(detail?.ticket.resolutionConfirmedBy).toBe("none");
  });

  it("finds no awaiting ticket when no wrap-up was ever delivered", async () => {
    const issue = await issueWithAttempt("Never asked");
    const conversationId = randomUUID();
    await admin`
      UPDATE support.tickets
      SET stage = 'awaiting_customer', source_conversation_id = NULL
      WHERE id = ${issue.ticketId}::uuid
    `;

    const found = await scoped((tx) =>
      awaitingCustomerTicket(tx, conversationId),
    );

    // Without a delivered follow-up there is no question for a reply to answer.
    expect(found).toBeUndefined();
  });

  it("never reads another tenant's attempt", async () => {
    const issue = await issueWithAttempt("Cross-tenant attempt");

    const mine = await scoped((tx) => loadPostCallWork(tx, issue.attemptId));
    const theirs = await scoped(
      (tx) => loadPostCallWork(tx, issue.attemptId),
      otherTenantId,
    );

    expect(mine?.ticketId).toBe(issue.ticketId);
    expect(theirs).toBeUndefined();
  });

  it("never binds a session that belongs to another tenant's call", async () => {
    const issue = await issueWithAttempt("Cross-tenant session");
    const foreign = await session({ tenant: otherTenantId });

    const bound = await scoped((tx) =>
      bindTicketCallAttemptSession(tx, issue.attemptId, foreign),
    );
    const work = await scoped((tx) => loadPostCallWork(tx, issue.attemptId));

    // The attempt row accepts the id, and the join that drives the pipeline is
    // tenant-scoped, so the foreign session contributes nothing.
    expect(bound).toBe(true);
    expect(work?.sessionStatus).toBeNull();
    const jobs = await admin`
      SELECT count(*)::int AS total FROM ops.jobs
      WHERE reference_id = ${issue.attemptId}::uuid
        AND job_type = 'support.postcall.process'
    `;
    expect(jobs[0]?.total).toBe(0);
  });

  it("counts an AI-only resolution only when no person took over", async () => {
    const window = {
      since: new Date(Date.now() - 3_600_000).toISOString(),
      until: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const before = await scoped((tx) => summarizeTicketOutcomes(tx, window));

    const resolved = analysis({
      resolution: "resolved",
      resolutionConfirmationSource: "customer_call",
      classificationConfidence: "high",
      classificationSources: [{ kind: "transcript_turn", reference: "3" }],
    });
    const solo = await readyForOutcome("Metric AI only", {
      analysis: resolved,
    });
    await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: solo.attemptId,
        ticketId: solo.ticketId,
        analysis: resolved,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: solo.sessionId,
      }),
    );
    const needsHuman = analysis({ resolution: "needs_human" });
    const escalated = await readyForOutcome("Metric escalated", {
      analysis: needsHuman,
    });
    await scoped((tx) =>
      applyPostCallOutcome(tx, userId, {
        attemptId: escalated.attemptId,
        ticketId: escalated.ticketId,
        analysis: needsHuman,
        callOutcome: "answered",
        transcriptState: "valid",
        sessionId: escalated.sessionId,
      }),
    );

    const after = await scoped((tx) => summarizeTicketOutcomes(tx, window));

    expect(after.eligible).toBeGreaterThan(before.eligible);
    expect(after.aiOnlyResolved).toBe(before.aiOnlyResolved + 1);
    expect(after.humanEscalated).toBe(before.humanEscalated + 1);
    // The hard case stays in the denominator. Removing it is the one change
    // that would make the rate go up without anything improving.
    expect(after.eligible).toBe(before.eligible + 2);
  });

  it("states the window and the policy version it was computed under", async () => {
    const metrics = await scoped((tx) =>
      summarizeTicketOutcomes(tx, {
        since: new Date(Date.now() - 86_400_000).toISOString(),
        until: new Date().toISOString(),
      }),
    );

    expect(metrics.policyVersion).toBe("1.0");
    expect(Date.parse(metrics.window.since)).toBeLessThan(
      Date.parse(metrics.window.until),
    );
    expect(metrics.window.reopenWindowDays).toBe(7);
  });

  it("rejects a metric window that runs backwards", async () => {
    await expect(
      scoped((tx) =>
        summarizeTicketOutcomes(tx, {
          since: new Date().toISOString(),
          until: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).rejects.toThrow(/must precede/u);
  });
});
