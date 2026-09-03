"use client";
import { useTranslations } from "next-intl";
import type { ReactNode, SyntheticEvent } from "react";

function field(target: EventTarget) {
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
    ? target
    : undefined;
}
export function FormValidation({ children }: { readonly children: ReactNode }) {
  const t = useTranslations("validation");
  function invalid(event: SyntheticEvent) {
    const input = field(event.target);
    if (!input) return;
    const validity = input.validity;
    if (validity.valueMissing) input.setCustomValidity(t("required"));
    else if (
      validity.typeMismatch &&
      input instanceof HTMLInputElement &&
      input.type === "email"
    )
      input.setCustomValidity(t("email"));
    else if (
      validity.rangeUnderflow ||
      validity.rangeOverflow ||
      validity.stepMismatch
    )
      input.setCustomValidity(t("range"));
    else if (
      validity.patternMismatch ||
      validity.tooLong ||
      validity.tooShort ||
      validity.badInput
    )
      input.setCustomValidity(t("format"));
  }
  return (
    <div
      className="validation-boundary"
      onInvalidCapture={invalid}
      onInputCapture={(event) => field(event.target)?.setCustomValidity("")}
    >
      {children}
    </div>
  );
}
