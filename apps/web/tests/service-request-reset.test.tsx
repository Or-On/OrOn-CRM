// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceRequestForm } from "../src/features/service-request";
import { localized } from "./localized";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps Hebrew under an English browser and appends three selections without losing files", async () => {
  window.history.replaceState(
    null,
    "",
    `/service-request#tenant=11111111-1111-4111-8111-111111111111&token=${"a".repeat(64)}`,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        customerName: "בדיקה",
        faultDescription: "מסך",
        photoRequired: false,
        submitted: false,
        formVersion: 2,
        businessPhone: "+97291234567",
      }),
    ),
  );
  URL.createObjectURL = vi.fn(() => "blob:fictional-preview");
  URL.revokeObjectURL = vi.fn();
  const { container } = render(localized(<ServiceRequestForm />, "en"));
  await screen.findByLabelText("שם מלא");
  expect(container.querySelector("main")?.getAttribute("lang")).toBe("he");
  expect(container.querySelector("main")?.getAttribute("dir")).toBe("rtl");
  const input = screen.getByLabelText("הוספת תמונות");
  for (const name of ["one.png", "two.png", "three.png"])
    fireEvent.change(input, {
      target: { files: [new File(["fixture"], name, { type: "image/png" })] },
    });
  await screen.findByText("3 מתוך 5");
  fireEvent.click(screen.getByRole("button", { name: "הסרת two.png" }));
  expect(screen.getByText("2 מתוך 5")).toBeTruthy();
  fireEvent.change(input, {
    target: {
      files: [new File(["fixture"], "two.png", { type: "image/png" })],
    },
  });
  expect(screen.getByText("3 מתוך 5")).toBeTruthy();
  expect(screen.getByLabelText("רחוב ומספר בית")).toBeTruthy();
  expect(screen.getByLabelText("עיר")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "התקשרו אלינו" }).getAttribute("href"),
  ).toBe("tel:+97291234567");
  cleanup();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- stubbed with vi.fn in this test
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
});
