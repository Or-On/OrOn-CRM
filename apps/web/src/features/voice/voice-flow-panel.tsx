"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ComponentCatalog, FlowSummary } from "@or-on/api-client";
import { Badge, Button, Surface } from "@or-on/ui";

import { voiceMutation } from "./mutation";

const EXAMPLE = JSON.stringify(
  {
    flow: {
      id: "11111111-1111-4111-8111-111111111111",
      version: 1,
      language: "he",
      name: "Fictional welcome",
    },
    nodes: [
      {
        name: "welcome",
        task_messages: [
          { role: "system", content: "Fictional simulator greeting" },
        ],
        post_actions: [{ type: "end_conversation" }],
      },
    ],
  },
  null,
  2,
);

export function VoiceFlowPanel({
  catalog,
  flows,
}: {
  readonly catalog: ComponentCatalog;
  readonly flows: readonly FlowSummary[];
}) {
  const router = useRouter();
  const [source, setSource] = useState(EXAMPLE);
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);

  async function act(path: string) {
    setPending(true);
    setMessage(undefined);
    try {
      const parsed: unknown = JSON.parse(source);
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      )
        throw new TypeError("Flow source must be a JSON object");
      const result = (await voiceMutation(path, { source: parsed })) as {
        valid?: boolean;
        errors?: string[];
      };
      setMessage(
        result.valid === false
          ? result.errors?.join("; ")
          : path.endsWith("publish")
            ? "Immutable version published."
            : "Flow is valid.",
      );
      router.refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Flow operation failed",
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
            <p className="eyebrow">Pipecat adapter</p>
            <h2>Voice flows</h2>
          </div>
          <Badge label={`Catalog ${catalog.spec_version}`} tone="info" />
        </div>
        <label htmlFor="flow-source">Versioned flow JSON</label>
        <textarea
          className="code-editor"
          dir="ltr"
          id="flow-source"
          onChange={(event) => setSource(event.target.value)}
          rows={18}
          spellCheck={false}
          value={source}
        />
        <div className="action-row">
          <Button
            disabled={pending}
            onClick={() => void act("/api/voice/flows/validate")}
            variant="secondary"
          >
            Validate
          </Button>
          <Button
            disabled={pending}
            onClick={() => void act("/api/voice/flows/publish")}
          >
            Publish version
          </Button>
        </div>
        {message === undefined ? null : <p aria-live="polite">{message}</p>}
      </Surface>
      <Surface>
        <h2>Published catalog</h2>
        <p>
          {catalog.components.length} retained typed components available. This
          is the voice adapter, not the Phase 7 cross-channel compiler.
        </p>
        <div className="operation-list">
          {flows.map((flow) => (
            <article key={flow.flow_id}>
              <div>
                <strong>{flow.name}</strong>
                <p>
                  {flow.language} · v{flow.latest_version}
                </p>
              </div>
              <Badge
                label={flow.packaged ? "packaged" : "tenant"}
                tone="neutral"
              />
            </article>
          ))}
        </div>
      </Surface>
    </div>
  );
}
