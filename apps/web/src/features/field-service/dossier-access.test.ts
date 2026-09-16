import { describe, expect, it } from "vitest";
import type { ServiceCaseDossier } from "@or-on/crm";

import {
  dossierForVoiceAccess,
  linkCandidatesForVoiceAccess,
} from "./dossier-access";

const fixture = {
  callSessionIds: ["50000000-0000-4000-8000-000000000001"],
  calls: [
    {
      sessionId: "50000000-0000-4000-8000-000000000001",
      status: "ended",
      direction: "outbound",
      outcome: "completed",
      answered: true,
      startedAt: "2026-09-15T08:00:00.000Z",
      endedAt: "2026-09-15T08:01:00.000Z",
      recordingObjectId: "60000000-0000-4000-8000-000000000001",
      transcriptObjectId: "70000000-0000-4000-8000-000000000001",
      recordingStatus: "available",
      transcriptStatus: "available",
      outcomeDetail: null,
    },
  ],
  summaries: [
    { sourceKind: "call", status: "completed", summary: "Private call" },
    {
      sourceKind: "dossier",
      status: "completed",
      summary: "Aggregate summary containing call evidence",
    },
    {
      sourceKind: "whatsapp",
      status: "completed",
      summary: "Permitted chat",
    },
  ],
  technicianBriefing: {
    voiceSummary: "Private voice summary",
  },
} as unknown as ServiceCaseDossier;

describe("field-service dossier access", () => {
  it("removes all retained voice evidence without voice permission", () => {
    const result = dossierForVoiceAccess(fixture, false);

    expect(result.callSessionIds).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(result.summaries).toEqual([
      expect.objectContaining({ sourceKind: "whatsapp" }),
    ]);
    expect(result.technicianBriefing.voiceSummary).toBeNull();
  });

  it("preserves the original dossier for authorized voice readers", () => {
    expect(dossierForVoiceAccess(fixture, true)).toBe(fixture);
  });

  it("keeps conversation candidates but removes call candidates", () => {
    const candidates = {
      conversations: [
        {
          id: "80000000-0000-4000-8000-000000000001",
          status: "open",
          lastMessageAt: null,
          linked: false,
          linkedCaseCount: 0,
        },
      ],
      calls: [
        {
          sessionId: "50000000-0000-4000-8000-000000000001",
          status: "ended",
          direction: "outbound",
          startedAt: "2026-09-15T08:00:00.000Z",
          linked: false,
          linkedCaseCount: 0,
        },
      ],
    };

    const result = linkCandidatesForVoiceAccess(candidates, false);

    expect(result.conversations).toEqual(candidates.conversations);
    expect(result.calls).toEqual([]);
  });
});
