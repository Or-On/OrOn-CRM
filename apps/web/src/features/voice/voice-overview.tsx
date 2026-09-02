"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SyntheticEvent } from "react";

import type {
  FlowSummary,
  PhoneNumberSummary,
  ReconciliationReport,
  VoiceSessionSummary,
} from "@or-on/api-client";
import { Badge, Button, Input, Surface } from "@or-on/ui";

import { voiceMutation } from "./mutation";

export function VoiceOverview({
  flows,
  numbers,
  reconciliation,
  sessions,
}: {
  readonly flows: readonly FlowSummary[];
  readonly numbers: readonly PhoneNumberSummary[];
  readonly reconciliation: ReconciliationReport;
  readonly sessions: readonly VoiceSessionSummary[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const completed = sessions.filter((item) => item.status === "ended").length;
  const answered = sessions.filter((item) => item.answered === true).length;

  async function register(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const allowedAddress = data.get("allowedAddress");
    if (typeof allowedAddress !== "string") {
      setError("Restricted carrier CIDR is required");
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      await voiceMutation("/api/voice/phone-numbers", {
        e164: data.get("e164"),
        flow_id: data.get("flowId"),
        allowed_addresses: [allowedAddress],
        mode: "simulator",
      });
      form.reset();
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Registration failed",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="voice-grid">
      <Surface level="raised">
        <div className="feature-heading">
          <div>
            <p className="eyebrow">Simulator-first</p>
            <h2>Call operations</h2>
          </div>
          <Badge label="Real calls disabled" tone="neutral" />
        </div>
        <dl className="metric-grid">
          <div>
            <dt>Calls</dt>
            <dd>{sessions.length}</dd>
          </div>
          <div>
            <dt>Completed</dt>
            <dd>{completed}</dd>
          </div>
          <div>
            <dt>Answered</dt>
            <dd>{answered}</dd>
          </div>
          <div>
            <dt>DIDs</dt>
            <dd>{numbers.length}</dd>
          </div>
        </dl>
        <div className="operation-list" aria-label="Recent calls">
          {sessions.length === 0 ? (
            <p>No calls yet.</p>
          ) : (
            sessions.map((session) => (
              <article key={session.session_id}>
                <div>
                  <strong>{session.session_id.slice(0, 8)}</strong>
                  <p>
                    {new Date(session.created_at).toLocaleString()} ·{" "}
                    {session.provider}
                  </p>
                </div>
                <Badge
                  label={session.status}
                  tone={session.status === "ended" ? "positive" : "info"}
                />
                <Link
                  className="text-link"
                  href={`/voice/calls/${session.session_id}`}
                >
                  Inspect
                </Link>
              </article>
            ))
          )}
        </div>
      </Surface>

      <Surface>
        <div className="feature-heading">
          <div>
            <p className="eyebrow">SIP admission</p>
            <h2>Phone numbers</h2>
          </div>
          <Badge
            label={
              reconciliation.ok ? "Canonical state coherent" : "Drift detected"
            }
            tone={reconciliation.ok ? "positive" : "warning"}
          />
        </div>
        <form
          className="feature-form"
          onSubmit={(event) => void register(event)}
        >
          <Input
            id="did-e164"
            label="DID in E.164"
            name="e164"
            placeholder="+15550101010"
            required
          />
          <label htmlFor="did-flow">Published voice flow</label>
          <select id="did-flow" name="flowId" required>
            <option value="">Select flow</option>
            {flows.map((flow) => (
              <option key={flow.flow_id} value={flow.flow_id}>
                {flow.name} · v{flow.latest_version}
              </option>
            ))}
          </select>
          <Input
            id="did-acl"
            label="Restricted carrier CIDR"
            name="allowedAddress"
            placeholder="203.0.113.0/24"
            required
          />
          <Button disabled={pending || flows.length === 0} type="submit">
            Register simulator DID
          </Button>
        </form>
        <div className="operation-list">
          {numbers.map((number) => (
            <article key={number.id}>
              <div dir="ltr">
                <strong>{number.e164}</strong>
                <p>{number.dispatch_rule_id}</p>
              </div>
              <Badge label={number.admission} tone="info" />
            </article>
          ))}
        </div>
        {error === undefined ? null : (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </Surface>
    </div>
  );
}
