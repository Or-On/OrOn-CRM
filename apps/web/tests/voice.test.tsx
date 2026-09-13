import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { localized, renderMarkup } from "./localized";
import en from "../src/i18n/messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  CallRecordingPlayer,
  LiveCallSummary,
  VoiceCampaignPanel,
  VoiceFlowPanel,
  VoiceOverview,
} from "../src/features/voice";

const flow = {
  flow_id: "11111111-1111-4111-8111-111111111111",
  language: "he",
  latest_version: 1,
  name: "בדיקת קול",
  packaged: false,
} as const;

describe("voice operator surfaces", () => {
  it("renders tenant-protected full-call playback", () => {
    const markup = renderToStaticMarkup(
      <CallRecordingPlayer
        label="Full call playback"
        sessionId="40000000-0000-4000-8000-000000000001"
        unsupported="Audio unsupported"
      />,
    );
    expect(markup).toContain("<audio");
    expect(markup).toContain("controls");
    expect(markup).toContain(
      "/api/voice/sessions/40000000-0000-4000-8000-000000000001/recording",
    );
  });
  it("renders safe DID and call controls with RTL-readable phone markup", () => {
    const markup = renderMarkup(
      <VoiceOverview
        flows={[flow]}
        numbers={[
          {
            admission: "simulated",
            dispatch_rule_id: "simulator:fixture",
            e164: "+14155550111",
            flow_id: flow.flow_id,
            id: "22222222-2222-4222-8222-222222222222",
          },
        ]}
        reconciliation={{ findings: [], ok: true, provider_enabled: false }}
        sessions={[]}
      />,
    );
    expect(markup).toContain("Real calls disabled");
    expect(markup).toContain('dir="ltr"');
    expect(markup).toContain("Restricted carrier CIDR");
  });

  it("shows an honest per-call price estimate in the call list and detail", () => {
    const session = {
      answered: true,
      contact_id: null,
      cost: {
        llm: 0.0021,
        stt: 0.003,
        total: 0.0123,
        tts: 0.0072,
        unpriced: ["carrier"],
      },
      created_at: "2026-09-10T10:00:00Z",
      direction: "outbound" as const,
      ended_at: null,
      outcome: null,
      platform_campaign_id: null,
      provider: "livekit",
      session_id: "40000000-0000-4000-8000-000000000001",
      status: "started" as const,
      usage: { call_seconds: 42 },
    };
    const listMarkup = renderMarkup(
      <VoiceOverview
        flows={[flow]}
        numbers={[]}
        reconciliation={{ findings: [], ok: true, provider_enabled: false }}
        sessions={[session]}
      />,
    );
    const detailMarkup = renderMarkup(
      <LiveCallSummary
        initial={{
          ...session,
          events: [],
          recording_available: false,
          recording_object_id: null,
          transcript_available: false,
          transcript_object_id: null,
        }}
      />,
    );

    expect(listMarkup).toContain("Estimated cost");
    expect(listMarkup).toContain("$0.0123");
    expect(listMarkup).toContain("Live · partial estimate");
    expect(detailMarkup).toContain("Estimated usage cost");
    expect(detailMarkup).toContain("Speech recognition");
    expect(detailMarkup).toContain("$0.0030");
  });

  it("labels the voice flow editor and campaign simulator clearly", () => {
    const flowMarkup = renderMarkup(
      <VoiceFlowPanel
        catalog={{ components: [], spec_version: "4.0.0" }}
        flows={[flow]}
      />,
    );
    const campaignMarkup = renderMarkup(
      <VoiceCampaignPanel campaigns={[]} flows={[flow]} />,
    );
    expect(flowMarkup).toContain("Voice flow editor");
    expect(flowMarkup).toContain("voice components available");
    expect(campaignMarkup).toContain(en.tenantOperations.campaignAudience);
    expect(campaignMarkup).not.toContain("Consent-aware simulator");
    expect(campaignMarkup).toContain("Maximum attempts");
  });

  it("keeps campaign and flow creation behind progressive disclosure", () => {
    const campaignMarkup = renderMarkup(
      <VoiceCampaignPanel
        campaigns={[
          {
            completed_calls: 3,
            created_at: "2026-09-01T10:00:00Z",
            eligible_contacts: 5,
            flow_id: flow.flow_id,
            id: "33333333-3333-4333-8333-333333333333",
            max_attempts: 2,
            max_concurrent: 2,
            name: "Fictional campaign",
            status: "running",
          },
        ]}
        flows={[flow]}
      />,
    );
    const flowMarkup = renderMarkup(
      <VoiceFlowPanel
        catalog={{ components: [{ type: "fixture" }], spec_version: "4.0.0" }}
        flows={[flow]}
      />,
    );

    expect(campaignMarkup).toContain('aria-expanded="false"');
    expect(campaignMarkup).toMatch(
      /<dialog[^>]*class="or-dialog voice-detail-create"/u,
    );
    expect(campaignMarkup).not.toMatch(/<dialog[^>]*\sopen(?:\s|=|>)/u);
    expect(campaignMarkup).toContain("Fictional campaign");
    expect(campaignMarkup).toContain(en.premiumVoice.completedCalls);
    expect(campaignMarkup).toContain(en.tenantOperations.audienceScope);
    expect(campaignMarkup).not.toContain(`3/5 ${en.voice.completed}`);
    expect(campaignMarkup).toContain("בדיקת קול");
    expect(flowMarkup).toMatch(
      /<dialog[^>]*class="or-dialog voice-flow-editor"/u,
    );
    expect(flowMarkup).not.toMatch(/<dialog[^>]*\sopen(?:\s|=|>)/u);
    expect(flowMarkup).toContain(
      `aria-label="${en.tenantOperations.executionConfiguration}"`,
    );
    expect(flowMarkup).toContain("Catalog 4.0.0");
  });

  it("renders voice workspaces as non-actionable for read-only access", () => {
    const campaignMarkup = renderToStaticMarkup(
      localized(<VoiceCampaignPanel campaigns={[]} flows={[flow]} />, "en", [
        "voice:read",
      ]),
    );
    const flowMarkup = renderToStaticMarkup(
      localized(
        <VoiceFlowPanel
          catalog={{ components: [], spec_version: "4.0.0" }}
          flows={[flow]}
        />,
        "en",
        ["voice:read"],
      ),
    );

    expect(campaignMarkup).toContain("Read-only access");
    expect(campaignMarkup).toContain('disabled=""');
    expect(flowMarkup).toContain("Read-only access");
    expect(flowMarkup).toContain('disabled=""');
  });
});
