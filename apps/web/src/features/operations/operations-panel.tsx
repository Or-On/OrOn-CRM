"use client";

import { errorMessage } from "../../i18n/error-message";
import { useCapability } from "../access";
import { useLocale, useTranslations } from "next-intl";
import { Activity, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type SyntheticEvent } from "react";
import type {
  AutomationRunSummary,
  AutomationSummary,
  BroadcastSummary,
  TenantOperationalInsights,
} from "@or-on/crm";
import { Badge, Button, Dialog, Input, Tabs, Textarea } from "@or-on/ui";
import { crmMutation } from "../crm";
import { CampaignsView } from "./campaigns-view";
import { AutomationsView } from "./automations-view";
import { AutomationRunHistory } from "./run-history";

type CreationTab = "campaigns" | "automations";
type OperationsTab = CreationTab | "history";

export function OperationsPanel({
  broadcasts,
  automations,
  runs,
  initialCreate,
  initialTab = "campaigns",
  insights,
  simulationAvailable,
}: {
  readonly broadcasts: readonly BroadcastSummary[];
  readonly automations: readonly AutomationSummary[];
  readonly runs: readonly AutomationRunSummary[];
  readonly initialCreate?: CreationTab;
  readonly insights?: TenantOperationalInsights;
  readonly initialTab?: OperationsTab;
  readonly simulationAvailable: boolean;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const canManageCampaigns = useCapability("campaigns:manage");
  const canManageFlows = useCapability("flows:manage");
  const router = useRouter();
  const allowedInitialCreate =
    initialCreate === "campaigns" && !simulationAvailable
      ? undefined
      : initialCreate;
  const [activeTab, setActiveTab] = useState<OperationsTab>(
    allowedInitialCreate ?? initialTab,
  );
  const [creation, setCreation] = useState<CreationTab | undefined>(
    allowedInitialCreate,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [campaignDraft, setCampaignDraft] = useState({ name: "", body: "" });
  const [automationDraft, setAutomationDraft] = useState({
    name: "",
    description: "",
  });
  const number = new Intl.NumberFormat(locale);
  const activeCanManage =
    activeTab === "campaigns" ? canManageCampaigns : canManageFlows;
  const campaignSimulationUnavailable =
    activeTab === "campaigns" && canManageCampaigns && !simulationAvailable;

  useEffect(() => setActiveTab(initialTab), [initialTab]);
  useEffect(() => {
    if (allowedInitialCreate !== undefined) {
      setActiveTab(allowedInitialCreate);
      setCreation(allowedInitialCreate);
    }
  }, [allowedInitialCreate]);

  function openCreation(kind: CreationTab) {
    if (kind === "campaigns" && !simulationAvailable) return;
    setCreation(kind);
    setError(undefined);
  }

  async function run(operation: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await operation();
      router.refresh();
      return true;
    } catch (caught) {
      setError(errorMessage(caught, t, "operations.failed"));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function createCampaign(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!simulationAvailable) return;
    if (await run(() => crmMutation("/api/campaigns", campaignDraft))) {
      setCampaignDraft({ name: "", body: "" });
      setCreation(undefined);
    }
  }

  async function createAutomation(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await run(() => crmMutation("/api/automations", automationDraft))) {
      setAutomationDraft({ name: "", description: "" });
      setCreation(undefined);
    }
  }

  return (
    <div className="operation-workspace">
      <section className="operation-overview">
        <header className="operation-command">
          <div className="operation-command__context">
            <span className="operation-command__icon" aria-hidden="true">
              <Activity size={19} />
            </span>
            <div>
              <h2>{t("tenantOperations.performance")}</h2>
              <p>{t("tenantOperations.monthScope")}</p>
            </div>
          </div>
          <div className="operation-command__actions">
            {campaignSimulationUnavailable ? null : activeCanManage ? (
              <Button
                onClick={() =>
                  openCreation(
                    activeTab === "history" ? "automations" : activeTab,
                  )
                }
              >
                <Plus aria-hidden="true" size={16} />
                {t(
                  activeTab === "campaigns"
                    ? "premiumPrimary.newCampaign"
                    : "premiumPrimary.newAutomation",
                )}
              </Button>
            ) : (
              <Badge label={t("common.readOnly")} tone="neutral" />
            )}
          </div>
        </header>
        {insights ? (
          <section
            className="tenant-performance-strip"
            aria-label={t("tenantOperations.performance")}
          >
            <dl>
              {(
                [
                  ["outbound", insights.outbound],
                  ["inbound", insights.inbound],
                  ["delivered", insights.delivered],
                  ["failed", insights.failed],
                ] as const
              ).map(([key, value]) => (
                <div
                  className={`operation-metric operation-metric--${key}`}
                  key={key}
                >
                  <dt>{t(`tenantOperations.${key}`)}</dt>
                  <dd>{number.format(value)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </section>
      <section
        className="operation-console"
        aria-label={t("pages.operationsTitle")}
      >
        <Tabs
          activeId={activeTab}
          ariaLabel={t("pages.operationsTitle")}
          direction={locale === "he" ? "rtl" : "ltr"}
          items={[
            {
              count: broadcasts.length,
              id: "campaigns",
              controls: "operations-campaigns-panel",
              tabId: "operations-campaigns-tab",
              label: t("tenantOperations.campaigns"),
            },
            {
              count: automations.length,
              id: "automations",
              controls: "operations-automations-panel",
              tabId: "operations-automations-tab",
              label: t("tenantOperations.automations"),
            },
            {
              id: "history",
              controls: "operations-history-panel",
              tabId: "operations-history-tab",
              label: t("tenantOperations.runHistory"),
              count: runs.length,
            },
          ]}
          onChange={(id) => {
            if (
              id === "campaigns" ||
              id === "automations" ||
              id === "history"
            ) {
              setActiveTab(id);
              const query = new URLSearchParams(window.location.search);
              query.set("tab", id);
              query.delete("create");
              window.history.replaceState(
                null,
                "",
                `/operations?${query.toString()}`,
              );
            }
          }}
        />

        <CampaignsView
          broadcasts={broadcasts}
          activeTab={activeTab}
          pending={pending}
          canManageCampaigns={canManageCampaigns}
          simulationAvailable={simulationAvailable}
          run={run}
          openCreation={openCreation}
        />
        <AutomationsView
          automations={automations}
          runs={runs}
          activeTab={activeTab}
          pending={pending}
          canManageFlows={canManageFlows}
          simulationAvailable={simulationAvailable}
          run={run}
          openCreation={openCreation}
        />

        <section
          id="operations-history-panel"
          aria-labelledby="operations-history-tab"
          role="tabpanel"
          hidden={activeTab !== "history"}
          className="operation-workspace__panel"
        >
          <AutomationRunHistory runs={runs} flows={automations} />
        </section>
      </section>
      {error && creation === undefined ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Dialog
        className="operation-create-dialog"
        closeLabel={t("common.close")}
        title={t("operations.draft")}
        description={t("premiumPrimary.campaignDraftHint")}
        open={creation === "campaigns"}
        onClose={() => setCreation(undefined)}
      >
        <form
          className="feature-form"
          onSubmit={(event) => void createCampaign(event)}
        >
          <fieldset
            className="form-fieldset"
            disabled={pending || !canManageCampaigns || !simulationAvailable}
          >
            <Input
              data-dialog-initial-focus
              id="campaign-name"
              label={t("operations.campaignName")}
              name="name"
              required
              value={campaignDraft.name}
              onChange={(event) =>
                setCampaignDraft((draft) => ({
                  ...draft,
                  name: event.target.value,
                }))
              }
            />
            <Textarea
              id="campaign-body"
              label={t("operations.body")}
              name="body"
              required
              rows={5}
              value={campaignDraft.body}
              onChange={(event) =>
                setCampaignDraft((draft) => ({
                  ...draft,
                  body: event.target.value,
                }))
              }
            />
            {error && creation === "campaigns" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button
              busy={pending}
              disabled={!canManageCampaigns || !simulationAvailable}
              type="submit"
            >
              {t("operations.draft")}
            </Button>
          </fieldset>
        </form>
      </Dialog>
      <Dialog
        className="operation-create-dialog"
        closeLabel={t("common.close")}
        title={t("operations.create")}
        description={t("premiumPrimary.automationDraftHint")}
        open={creation === "automations"}
        onClose={() => setCreation(undefined)}
      >
        <form
          className="feature-form"
          onSubmit={(event) => void createAutomation(event)}
        >
          <fieldset
            className="form-fieldset"
            disabled={pending || !canManageFlows}
          >
            <Input
              data-dialog-initial-focus
              id="automation-name"
              label={t("operations.name")}
              name="name"
              required
              value={automationDraft.name}
              onChange={(event) =>
                setAutomationDraft((draft) => ({
                  ...draft,
                  name: event.target.value,
                }))
              }
            />
            <Textarea
              id="automation-description"
              label={t("operations.description")}
              name="description"
              rows={4}
              value={automationDraft.description}
              onChange={(event) =>
                setAutomationDraft((draft) => ({
                  ...draft,
                  description: event.target.value,
                }))
              }
            />
            {error && creation === "automations" ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button busy={pending} disabled={!canManageFlows} type="submit">
              {t("operations.create")}
            </Button>
          </fieldset>
        </form>
      </Dialog>
    </div>
  );
}
