"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useTranslations } from "next-intl";

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
  const t = useTranslations();
  const canEdit = useCapability("voice:operate");
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
        throw new TypeError(t("voice.sourceInvalid"));
      const result = (await voiceMutation(path, { source: parsed })) as {
        valid?: boolean;
        errors?: string[];
      };
      setMessage(
        result.valid === false
          ? result.errors?.join("; ")
          : path.endsWith("publish")
            ? t("voice.published")
            : t("voice.valid"),
      );
      router.refresh();
    } catch (error) {
      setMessage(errorMessage(error, t, "voice.flowFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="voice-grid">
      <Surface level="raised">
        <div className="feature-heading">
          <div>
            <p className="eyebrow">{t("voice.adapter")}</p>
            <h2>{t("voice.flows")}</h2>
          </div>
          <Badge
            label={t("voice.catalogVersion", { version: catalog.spec_version })}
            tone="info"
          />
        </div>
        <label htmlFor="flow-source">{t("voice.source")}</label>
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
            disabled={pending || !canEdit}
            onClick={() => void act("/api/voice/flows/validate")}
            variant="secondary"
          >
            {t("voice.validate")}
          </Button>
          <Button
            disabled={pending || !canEdit}
            onClick={() => void act("/api/voice/flows/publish")}
          >
            {t("voice.publish")}
          </Button>
        </div>
        {message === undefined ? null : <p aria-live="polite">{message}</p>}
      </Surface>
      <Surface>
        <h2>{t("voice.catalog")}</h2>
        <p>{t("voice.components", { count: catalog.components.length })}</p>
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
                label={t(flow.packaged ? "voice.packaged" : "voice.tenant")}
                tone="neutral"
              />
            </article>
          ))}
        </div>
      </Surface>
    </div>
  );
}
