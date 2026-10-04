// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMutationFocus } from "../src/features/keyboard";

function MutationControls() {
  const [pending, setPending] = useState(false);
  const rememberFocus = useMutationFocus(pending);
  return (
    <>
      <button
        disabled={pending}
        onClick={() => {
          rememberFocus();
          setPending(true);
        }}
      >
        Save
      </button>
      <button onClick={() => setPending(false)}>Finish mutation</button>
      <button>Other control</button>
    </>
  );
}
afterEach(cleanup);
describe("focus after a mutation disables controls", () => {
  it("recovers the original control when native disabled focus was lost", () => {
    render(<MutationControls />);
    const save = screen.getByText("Save");
    save.focus();
    fireEvent.click(save);
    // jsdom retains focus on disabled controls; model the observed native BODY focus.
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    document.body.removeAttribute("tabindex");
    expect(document.activeElement).toBe(document.body);
    act(() => {
      fireEvent.click(screen.getByText("Finish mutation"));
    });
    expect(document.activeElement).toBe(save);
  });
  it("preserves a user move to another control while the mutation is pending", () => {
    render(<MutationControls />);
    const save = screen.getByText("Save");
    save.focus();
    fireEvent.click(save);
    const other = screen.getByText("Other control");
    other.focus();
    act(() => {
      fireEvent.click(screen.getByText("Finish mutation"));
    });
    expect(document.activeElement).toBe(other);
  });
});
