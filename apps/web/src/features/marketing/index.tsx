import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  ContactRound,
  MessagesSquare,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { BrandLockup, SignalBackdrop } from "../brand";
import { MobileMarketingMenu } from "./mobile-menu";
import { WorkflowPreview } from "./workflow-preview";

export function MarketingPage() {
  const t = useTranslations("marketing");
  return (
    <div className="public-site">
      <a className="skip-link" href="#product-content">
        {t("skipContent")}
      </a>
      <header className="public-header" id="public-top">
        <Link aria-label={t("brandHome")} href="#public-top" className="brand">
          <BrandLockup markSize={38} />
        </Link>
        <nav
          aria-label={t("navProduct")}
          className="public-nav public-nav--desktop"
        >
          <a href="#workflow">{t("navWorkflow")}</a>
          <a href="#security">{t("navSecurity")}</a>
          <a href="#questions">{t("navFaq")}</a>
        </nav>
        <MobileMarketingMenu />
        <div className="public-controls">
          <LanguageControl />
          <ThemeControl />
          <Link
            className="or-button or-button--secondary action-link"
            href="/login"
          >
            {t("signIn")}
          </Link>
        </div>
      </header>
      <main id="product-content" tabIndex={-1}>
        <section className="public-hero">
          <div className="public-hero__copy">
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1>
              <span>{t("titleLead")}</span>
              <strong>{t("titleEmphasis")}</strong>
            </h1>
            <p className="public-lede">{t("description")}</p>
            <div className="public-actions">
              <Link
                className="or-button or-button--primary action-link"
                href="/login"
              >
                {t("primary")}
                <ArrowRight
                  className="directional-icon"
                  aria-hidden="true"
                  size={18}
                />
              </Link>
              <a className="text-link" href="#workflow">
                {t("secondary")}
              </a>
            </div>
            <p className="public-note">{t("note")}</p>
          </div>
          <div className="public-hero__visual">
            <SignalBackdrop />
            <WorkflowPreview />
          </div>
        </section>
        <section className="public-proof" aria-label={t("proofLabel")}>
          <dl>
            {(
              [
                ["proofDatabaseValue", "proofDatabaseLabel"],
                ["proofSafetyValue", "proofSafetyLabel"],
                ["proofJobsValue", "proofJobsLabel"],
                ["proofWebhooksValue", "proofWebhooksLabel"],
              ] as const
            ).map(([value, label]) => (
              <div key={value}>
                <dt>{t(label)}</dt>
                <dd>{t(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section className="public-value" id="workflow" tabIndex={-1}>
          <div>
            <p className="eyebrow">{t("valueEyebrow")}</p>
            <h2>{t("valueTitle")}</h2>
          </div>
          <p>{t("valueBody")}</p>
        </section>
        <section className="public-capabilities" aria-label={t("navProduct")}>
          {[
            { key: "capInbox", body: "capInboxBody", Icon: MessagesSquare },
            { key: "capCrm", body: "capCrmBody", Icon: ContactRound },
            { key: "capFlow", body: "capFlowBody", Icon: Workflow },
          ].map(({ key, body, Icon }, index) => (
            <article key={key}>
              <div className="capability-marker">
                <span>{String(index + 1).padStart(2, "0")}</span>
                <Icon aria-hidden="true" size={24} />
              </div>
              <h3>{t(key)}</h3>
              <p>{t(body)}</p>
            </article>
          ))}
        </section>
        <section className="public-trust" id="security" tabIndex={-1}>
          <ShieldCheck size={32} aria-hidden="true" />
          <div>
            <h2>{t("securityTitle")}</h2>
            <p>{t("securityBody")}</p>
            <p className="public-note">{t("securityLimits")}</p>
          </div>
        </section>
        <section className="public-integrations">
          <p className="eyebrow">Meta · LiveKit · Pipecat · PostgreSQL</p>
          <h2>{t("integrationTitle")}</h2>
          <p>{t("integrationBody")}</p>
        </section>
        <section className="public-faq" id="questions" tabIndex={-1}>
          <h2>{t("faqTitle")}</h2>
          <div>
            {[1, 2, 3, 4].map((index) => (
              <details key={index}>
                <summary>{t(`faq${String(index)}`)}</summary>
                <p>{t(`answer${String(index)}`)}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="public-cta">
          <div>
            <h2>{t("ctaTitle")}</h2>
            <p>{t("ctaBody")}</p>
          </div>
          <Link
            className="or-button or-button--primary action-link"
            href="/login"
          >
            {t("primary")}
            <ArrowRight
              className="directional-icon"
              aria-hidden="true"
              size={18}
            />
          </Link>
        </section>
      </main>
      <footer className="public-footer">
        <p>{t("footer")}</p>
        <details>
          <summary>{t("privacy")}</summary>
          <p>{t("privacyNote")}</p>
        </details>
        <a href="#questions">{t("navFaq")}</a>
      </footer>
    </div>
  );
}
