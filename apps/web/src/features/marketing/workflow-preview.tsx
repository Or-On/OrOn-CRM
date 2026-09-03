"use client";

import { useTranslations, useLocale } from "next-intl";
import { useId, useRef, useState } from "react";
import {
  ContactRound,
  MessagesSquare,
  Check,
  CornerDownRight,
} from "lucide-react";

export function WorkflowPreview() {
  const t = useTranslations("marketing");
  const locale = useLocale();
  const [step, setStep] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const steps = ["stepMessage", "stepContext", "stepAction"];
  return (
    <section className="workflow-preview" aria-label={t("demoLabel")}>
      <p className="workflow-preview__label">{t("demoLabel")}</p>
      <div
        className="workflow-tabs"
        role="tablist"
        aria-label={t("navWorkflow")}
      >
        {steps.map((key, index) => (
          <button
            role="tab"
            aria-selected={index === step}
            aria-controls={`${id}-panel`}
            id={`${id}-${String(index)}`}
            tabIndex={index === step ? 0 : -1}
            key={key}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            onClick={() => setStep(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowRight")
                next = (step + (locale === "he" ? 2 : 1)) % 3;
              else if (event.key === "ArrowLeft")
                next = (step + (locale === "he" ? 1 : 2)) % 3;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = 2;
              else return;
              event.preventDefault();
              setStep(next);
              tabs.current[next]?.focus();
            }}
          >
            {t(key)}
          </button>
        ))}
      </div>
      <div
        className="workflow-stage"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${String(step)}`}
        tabIndex={0}
      >
        <div className="workflow-contact">
          <span className="contact-avatar" aria-hidden="true">
            <ContactRound size={20} />
          </span>
          <div>
            <strong>{t("demoCustomer")}</strong>
            <small>{t("demoCompany")}</small>
          </div>
        </div>
        <div className={`workflow-path workflow-path--${String(step)}`}>
          <div className="workflow-event">
            <MessagesSquare aria-hidden="true" size={17} />
            <p>{t("demoMessage")}</p>
          </div>
          {step >= 1 ? (
            <div className="workflow-context">
              <CornerDownRight
                className="directional-icon"
                aria-hidden="true"
                size={20}
              />
              <div>
                <p>{t("demoReply")}</p>
                <span>
                  <Check aria-hidden="true" size={14} />
                  {t("demoConsent")}
                </span>
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="workflow-next">
              <p>{t("demoOwner")}</p>
              <small>{t("demoResult")}</small>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
