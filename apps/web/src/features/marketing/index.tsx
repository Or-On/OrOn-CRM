import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  ContactRound,
  MessagesSquare,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { product } from "../../branding";
import { LanguageControl } from "../../i18n/language-control";
import { ThemeControl } from "../../i18n/theme-control";
import { WorkflowPreview } from "./workflow-preview";

export function MarketingPage() {
  const t = useTranslations("marketing");
  return (
    <div className="public-site">
      <a className="skip-link" href="#product-content">
        {t("navProduct")}
      </a>
      <header className="public-header">
        <Link href="#product-content" className="brand">
          <span className="brand__mark" aria-hidden="true">
            O.
          </span>
          <span>{product.name}</span>
        </Link>
        <nav aria-label={t("navProduct")}>
          <a href="#workflow">{t("navWorkflow")}</a>
          <a href="#security">{t("navSecurity")}</a>
          <a href="#questions">{t("navFaq")}</a>
        </nav>
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
      <main id="product-content">
        <section className="public-hero">
          <div className="public-hero__copy">
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1>{t("title")}</h1>
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
          <WorkflowPreview />
        </section>
        <section className="public-value" id="workflow">
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
        <section className="public-trust" id="security">
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
        <section className="public-faq" id="questions">
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
