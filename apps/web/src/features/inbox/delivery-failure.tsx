"use client";

import type { MessageDeliveryFailure } from "@or-on/crm";
import { useTranslations } from "next-intl";

export function DeliveryFailure({
  failure,
}: {
  readonly failure: MessageDeliveryFailure | null | undefined;
}) {
  const t = useTranslations("deliveryFailure");
  const diagnostic = failure?.diagnostic;
  return (
    <div className="message-failure">
      <strong>{t("title")}</strong>
      <p>
        {diagnostic
          ? t(diagnostic.reason)
          : failure && t.has(failure.code)
            ? t(failure.code)
            : t("legacy")}
      </p>
      {failure ? (
        <details>
          <summary>{t("details")}</summary>
          <dl>
            <div>
              <dt>{t("code")}</dt>
              <dd>
                <bdi>{failure.code}</bdi>
              </dd>
            </div>
            {diagnostic ? (
              <>
                <div>
                  <dt>{t("http")}</dt>
                  <dd>
                    <bdi>{diagnostic.httpStatus}</bdi>
                  </dd>
                </div>
                {diagnostic.metaSubcode !== null ? (
                  <div>
                    <dt>{t("subcode")}</dt>
                    <dd>
                      <bdi>{diagnostic.metaSubcode}</bdi>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t("retryable")}</dt>
                  <dd>{diagnostic.retryable ? t("yes") : t("no")}</dd>
                </div>
              </>
            ) : null}
          </dl>
          <p>{t("privacy")}</p>
          <p>{t("retryHint")}</p>
        </details>
      ) : null}
    </div>
  );
}
