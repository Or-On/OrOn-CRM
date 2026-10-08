"use client";

import type { FlowNodeType, JsonValue, AgentProfileSummary } from "@or-on/crm";
import type { FlowSummary } from "@or-on/api-client";
import { Input, Select, Textarea } from "@or-on/ui";
import { useEffect, useState } from "react";

export function defaultNodeConfiguration(type: FlowNodeType): string {
  return JSON.stringify(
    {
      start: {},
      end: {},
      "message.send": { kind: "text", text: "" },
      "voice.call": {
        flowId: "",
        flowVersion: 1,
        flowReferencePolicy: "pinned",
      },
      "crm.update": { field: "company", value: "" },
      handoff: { reason: "" },
    }[type],
    null,
    2,
  );
}

export function FlowNodeFields({
  id,
  type,
  configuration,
  onChange,
  agents = [],
}: {
  readonly id: string;
  readonly type: FlowNodeType;
  readonly configuration: string;
  readonly onChange: (value: string) => void;
  readonly agents?: readonly AgentProfileSummary[];
}) {
  const [flows, setFlows] = useState<readonly FlowSummary[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (type !== "voice.call") return;
    const controller = new AbortController();
    void fetch("/api/voice/flows", {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("load_failed");
        const data = (await response.json()) as { items: FlowSummary[] };
        if (!controller.signal.aborted) {
          setFlows(data.items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [type, attempt]);
  let parsed: Record<string, JsonValue>;
  try {
    const value = JSON.parse(configuration) as JsonValue;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return null;
    parsed = value as Record<string, JsonValue>;
  } catch {
    return null;
  }
  const change = (key: string, value: JsonValue) =>
    onChange(JSON.stringify({ ...parsed, [key]: value }, null, 2));
  if (type === "start" || type === "end") return null;
  if (type === "voice.call")
    return (
      <div dir="rtl">
        <Select
          id={`${id}-flow-choice`}
          label="תהליך קולי שפורסם"
          value={typeof parsed.flowId === "string" ? parsed.flowId : ""}
          onChange={(event) => {
            const flow = flows.find(
              (item) => item.flow_id === event.target.value,
            );
            if (flow)
              onChange(
                JSON.stringify(
                  {
                    ...parsed,
                    flowId: flow.flow_id,
                    flowVersion: flow.latest_version,
                  },
                  null,
                  2,
                ),
              );
          }}
        >
          <option value="">בחרו תהליך</option>
          {typeof parsed.flowId === "string" &&
          !flows.some((flow) => flow.flow_id === parsed.flowId) ? (
            <option value={parsed.flowId}>
              {parsed.flowId} · v
              {typeof parsed.flowVersion === "number"
                ? String(parsed.flowVersion)
                : "?"}
            </option>
          ) : null}
          {flows.map((flow) => (
            <option key={flow.flow_id} value={flow.flow_id}>
              {flow.name} · v{flow.latest_version}
            </option>
          ))}
        </Select>
        {failed ? (
          <p role="alert">
            רשימת התהליכים לא נטענה.{" "}
            <button type="button" onClick={() => setAttempt(attempt + 1)}>
              ניסיון נוסף
            </button>
          </p>
        ) : null}
        <Input
          id={`${id}-flow-version`}
          label="גרסת תהליך מדויקת"
          type="number"
          min={1}
          value={
            typeof parsed.flowVersion === "number" ? parsed.flowVersion : 1
          }
          onChange={(event) =>
            change("flowVersion", Number(event.target.value))
          }
        />
        <Select
          id={`${id}-agent-choice`}
          label="גרסת סוכן קולית"
          value={
            typeof parsed.agentVersionId === "string"
              ? parsed.agentVersionId
              : ""
          }
          onChange={(event) => {
            const next = { ...parsed };
            if (event.target.value) next.agentVersionId = event.target.value;
            else delete next.agentVersionId;
            onChange(JSON.stringify(next, null, 2));
          }}
        >
          <option value="">הסוכן של התהליך הראשי</option>
          {typeof parsed.agentVersionId === "string" &&
          !agents.some(
            (agent) => agent.publishedVersionId === parsed.agentVersionId,
          ) ? (
            <option value={parsed.agentVersionId}>
              {parsed.agentVersionId}
            </option>
          ) : null}
          {agents
            .filter(
              (agent) =>
                agent.publishedVersionId &&
                agent.publishedChannels.includes("voice"),
            )
            .map((agent) => (
              <option key={agent.id} value={agent.publishedVersionId ?? ""}>
                {agent.name} · v{agent.publishedVersion}
              </option>
            ))}
        </Select>
        {(["flowReferencePolicy", "agentReferencePolicy"] as const).map(
          (key) => (
            <Select
              key={key}
              id={`${id}-${key}`}
              label={
                key === "flowReferencePolicy"
                  ? "שיוך תהליך קולי"
                  : "שיוך סוכן הצומת"
              }
              value={typeof parsed[key] === "string" ? parsed[key] : "pinned"}
              onChange={(event) => change(key, event.target.value)}
            >
              <option value="pinned">נעול לגרסה שנבחרה</option>
              <option value="follow_published">
                מעקב אחרי פרסומים מאושרים
              </option>
            </Select>
          ),
        )}
      </div>
    );
  const field =
    type === "handoff" ? "reason" : type === "message.send" ? "text" : "value";
  if (type === "message.send" && parsed.kind === "template")
    return <p dir="rtl">תבנית מובנית: פרמטרי התבנית נשמרים במקור המתקדם.</p>;
  return (
    <div dir="rtl">
      {type === "crm.update" ? (
        <Select
          id={`${id}-crm-field`}
          label="שדה לקוח"
          value={typeof parsed.field === "string" ? parsed.field : "company"}
          onChange={(event) => change("field", event.target.value)}
        >
          <option value="company">חברה</option>
          <option value="name">שם</option>
          <option value="email">דוא״ל</option>
        </Select>
      ) : null}
      <Textarea
        id={`${id}-text`}
        label={
          type === "handoff"
            ? "סיבת העברה"
            : type === "message.send"
              ? "תוכן ההודעה"
              : "ערך השדה"
        }
        rows={3}
        value={typeof parsed[field] === "string" ? parsed[field] : ""}
        onChange={(event) => change(field, event.target.value)}
      />
    </div>
  );
}
