// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceOverview } from "../src/features/voice";
import { localized } from "./localized";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

describe("voice provider reconciliation observation", () => {
  it.each([
    ["en", "Provider comparison not performed", "Real calls disabled"],
    ["he", "השוואה מול הספק לא בוצעה", "שיחות אמיתיות מושבתות"],
  ] as const)(
    "does not claim global voice delivery is disabled in %s",
    (locale, label, disabled) => {
      render(
        localized(
          <VoiceOverview
            flows={[]}
            numbers={[]}
            sessions={[]}
            reconciliation={{ ok: true, provider_enabled: false, findings: [] }}
          />,
          locale,
        ),
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.queryByText(disabled)).toBeNull();
    },
  );
});
