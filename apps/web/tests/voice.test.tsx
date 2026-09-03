import { renderMarkup as renderToStaticMarkup } from "./localized";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
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
  it("renders safe DID and call controls with RTL-readable phone markup", () => {
    const markup = renderToStaticMarkup(
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

  it("labels the retained flow adapter and campaign simulator honestly", () => {
    const flowMarkup = renderToStaticMarkup(
      <VoiceFlowPanel
        catalog={{ components: [], spec_version: "4.0.0" }}
        flows={[flow]}
      />,
    );
    const campaignMarkup = renderToStaticMarkup(
      <VoiceCampaignPanel campaigns={[]} flows={[flow]} />,
    );
    expect(flowMarkup).toContain("retained voice adapter");
    expect(campaignMarkup).toContain("Consent-aware simulator");
    expect(campaignMarkup).toContain("Maximum attempts");
  });
});
