"use client";

import type {
  Expense,
  ExpenseCursor,
  ExpenseStatus,
  ExpenseSummary,
  CampaignWallet,
  CampaignPaymentSource,
} from "@or-on/crm";
import {
  Button,
  ConfirmDialog,
  Dialog,
  Input,
  Select,
  Textarea,
} from "@or-on/ui";
import {
  Download,
  Edit3,
  CreditCard,
  Plus,
  RotateCw,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type SyntheticEvent } from "react";

import { useCapability } from "../access";
import { crmMutation, crmRead } from "../crm";
import styles from "./finance-workspace.module.css";

export interface VoiceUsageEstimate {
  readonly id: string;
  readonly createdAt: string;
  readonly totalUsd: number;
  readonly durationSeconds: number | null;
  readonly partial: boolean;
}

interface ExpensePayload {
  readonly expense: Expense;
}

interface ExpenseDraft {
  readonly title: string;
  readonly vendor: string;
  readonly category: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: Exclude<ExpenseStatus, "void">;
  readonly notes: string;
  readonly incurredAt: string;
}

const COPY = {
  en: {
    title: "Finance",
    eyebrow: "Operations & billing",
    description:
      "Track tenant spending, campaign funds, and voice usage in one accountable ledger.",
    addExpense: "Add expense",
    overview: "Overview",
    expenses: "Expenses",
    storedRecords: "stored records",
    loadedRecords: "loaded records",
    export: "Export loaded",
    overviewLabel: "Finance overview",
    recordedExpenses: "Recorded expenses",
    ledgerTotal: "ledger total",
    thisMonth: "This month",
    currentMonth: "Recorded in the current month",
    currentMonthLoaded: "Recorded this month in loaded ledger records",
    pending: "Pending",
    awaiting: "Awaiting final recording",
    activeRecords: "Active records",
    voided: "voided",
    currencyTitle: "Ledger by currency",
    currencyDescription: "Currencies remain separate; totals are never mixed.",
    noCurrencies: "No ledger currencies yet",
    voiceTitle: "Voice usage estimate",
    voiceDescription: "Separate from stored expenses · latest session sample",
    voiceSessions: "voice sessions in the current sample",
    partialEstimates: "estimates have unpriced components",
    voiceUnavailable:
      "Live voice estimates are temporarily unavailable. Stored expenses are unaffected.",
    activityTitle: "Expense activity",
    activityDescription: "Recorded expenses over the last 30 days",
    activityLoadedDescription:
      "Recorded expenses in the last 30 days from loaded ledger records",
    chartCurrency: "Chart currency",
    chartLabel: "30-day expense trend",
    chartEmpty: "No recorded expenses in this period.",
    chartData: "Expense chart data",
    loadedNotice:
      "More ledger records are available. Search, filters, this-month, and chart values cover loaded records and update as you load them; all-time totals above come from the complete ledger.",
    ago30: "30 days ago",
    ago20: "20 days",
    ago10: "10 days",
    today: "Today",
    allExpenses: "All expenses",
    recentExpenses: "Recent expenses",
    matchingRecords: "matching records",
    matchingLoadedRecords: "matching loaded records",
    search: "Search expenses",
    searchPlaceholder: "Search title, vendor, or category…",
    status: "Expense status",
    allStatuses: "All statuses",
    recorded: "Recorded",
    void: "Void",
    ledgerLabel: "Tenant expense ledger",
    scrollLabel: "Scrollable expense records",
    expense: "Expense",
    category: "Category",
    date: "Date",
    amount: "Amount",
    currency: "Currency",
    actions: "Actions",
    noVendor: "No vendor",
    edit: "Edit",
    noMatches: "No expenses match these filters",
    noLoadedMatches: "No loaded expenses match these filters",
    noExpenses: "No expenses recorded yet",
    adjustFilters: "Adjust the search or status filter.",
    adjustLoadedFilters:
      "Load more records or adjust the search or status filter.",
    addFirst: "Add the tenant’s first expense to start the ledger.",
    loadMore: "Load more expenses",
    loadError: "More expenses could not be loaded. Please try again.",
    close: "Close",
    dialogDescription:
      "Stored amounts remain separate from estimated voice usage.",
    editTitle: "Edit expense",
    createTitle: "Add expense",
    expenseTitle: "Expense title",
    vendor: "Vendor",
    incurredDate: "Incurred date",
    notes: "Notes",
    cancel: "Cancel",
    save: "Save changes",
    create: "Add expense",
    saveError: "The expense could not be saved. Your entries are still here.",
    voidError: "The expense could not be voided. Please try again.",
    keepExpense: "Keep expense",
    voidExpense: "Void expense",
    voidDescription: "The expense remains in the ledger and is marked void.",
    voidTitle: "Void this expense?",
    operations: "Operations",
    campaignFunds: "Campaign funds",
    availableBalance: "Available prepaid balance",
    addFunds: "Add funds",
    amountToLoad: "Amount to load",
    billingHint:
      "Cards are collected only by Stripe Checkout. Campaign delivery can reserve and debit this balance when real campaigns are enabled.",
    fundsAdded: "Campaign funds added.",
    fundsError: "Funds could not be added. No charge was confirmed.",
    stripeBilling: "Funding always continues through secure Stripe Checkout.",
    paymentMethod: "Payment method",
    connectCard: "Connect card",
    replaceCard: "Replace card",
    noCard: "No payment card connected",
    cardRequired: "Connect a payment card before adding campaign funds.",
    billingUnavailable:
      "Stripe is not configured for this deployment. Card connection and funding are unavailable.",
    cardEnding: "ending in",
    expires: "Expires",
  },
  he: {
    title: "כספים",
    eyebrow: "תפעול וחיוב",
    description:
      "מעקב אחר הוצאות, כספי קמפיינים ושימוש קולי בספר תנועות אחוד ואמין.",
    addExpense: "הוצאה חדשה",
    overview: "סקירה",
    expenses: "הוצאות",
    storedRecords: "רשומות שמורות",
    loadedRecords: "רשומות שנטענו",
    export: "ייצוא הרשומות שנטענו",
    overviewLabel: "סקירת כספים",
    recordedExpenses: "הוצאות שנרשמו",
    ledgerTotal: "סך הכול בספר",
    thisMonth: "החודש",
    currentMonth: "נרשם בחודש הנוכחי",
    currentMonthLoaded: "נרשם החודש ברשומות הספר שנטענו",
    pending: "ממתין",
    awaiting: "ממתין לרישום סופי",
    activeRecords: "רשומות פעילות",
    voided: "בוטלו",
    currencyTitle: "ספר לפי מטבע",
    currencyDescription: "כל מטבע נשאר נפרד; לעולם לא מחברים מטבעות שונים.",
    noCurrencies: "עדיין אין מטבעות בספר",
    voiceTitle: "אומדן שימוש בקול",
    voiceDescription: "נפרד מהוצאות שמורות · מדגם הסשנים האחרון",
    voiceSessions: "סשנים קוליים במדגם הנוכחי",
    partialEstimates: "אומדנים כוללים רכיבים ללא מחיר",
    voiceUnavailable:
      "אומדני הקול החיים אינם זמינים כרגע. ההוצאות השמורות לא הושפעו.",
    activityTitle: "פעילות הוצאות",
    activityDescription: "הוצאות שנרשמו ב־30 הימים האחרונים",
    activityLoadedDescription:
      "הוצאות ב־30 הימים האחרונים מתוך רשומות הספר שנטענו",
    chartCurrency: "מטבע בתרשים",
    chartLabel: "מגמת הוצאות ל־30 יום",
    chartEmpty: "לא נרשמו הוצאות בתקופה הזאת.",
    chartData: "נתוני תרשים ההוצאות",
    loadedNotice:
      "קיימות רשומות נוספות. החיפוש, המסננים, נתוני החודש והתרשים חלים על הרשומות שנטענו ומתעדכנים עם הטעינה; הסיכומים לכל התקופה למעלה מחושבים מכל הספר.",
    ago30: "לפני 30 יום",
    ago20: "20 ימים",
    ago10: "10 ימים",
    today: "היום",
    allExpenses: "כל ההוצאות",
    recentExpenses: "הוצאות אחרונות",
    matchingRecords: "רשומות תואמות",
    matchingLoadedRecords: "רשומות תואמות מתוך הרשומות שנטענו",
    search: "חיפוש הוצאות",
    searchPlaceholder: "חיפוש לפי שם, ספק או קטגוריה…",
    status: "סטטוס הוצאה",
    allStatuses: "כל הסטטוסים",
    recorded: "נרשמה",
    void: "בוטלה",
    ledgerLabel: "ספר ההוצאות של הארגון",
    scrollLabel: "רשומות הוצאות נגללות",
    expense: "הוצאה",
    category: "קטגוריה",
    date: "תאריך",
    amount: "סכום",
    currency: "מטבע",
    actions: "פעולות",
    noVendor: "ללא ספק",
    edit: "עריכה",
    noMatches: "אין הוצאות שתואמות למסננים",
    noLoadedMatches: "אין הוצאות שנטענו שתואמות למסננים",
    noExpenses: "עדיין לא נרשמו הוצאות",
    adjustFilters: "אפשר לשנות את החיפוש או את מסנן הסטטוס.",
    adjustLoadedFilters:
      "אפשר לטעון רשומות נוספות או לשנות את החיפוש או את מסנן הסטטוס.",
    addFirst: "הוסיפו את ההוצאה הראשונה כדי להתחיל את הספר.",
    loadMore: "טעינת הוצאות נוספות",
    loadError: "לא הצלחנו לטעון הוצאות נוספות. נסו שוב.",
    close: "סגירה",
    dialogDescription: "סכומים שמורים נשארים נפרדים מאומדני השימוש בקול.",
    editTitle: "עריכת הוצאה",
    createTitle: "הוצאה חדשה",
    expenseTitle: "שם ההוצאה",
    vendor: "ספק",
    incurredDate: "תאריך ההוצאה",
    notes: "הערות",
    cancel: "ביטול",
    save: "שמירת שינויים",
    create: "הוספת הוצאה",
    saveError: "לא הצלחנו לשמור את ההוצאה. הפרטים שהוזנו נשמרו.",
    voidError: "לא הצלחנו לבטל את ההוצאה. נסו שוב.",
    keepExpense: "השארת ההוצאה",
    voidExpense: "ביטול ההוצאה",
    voidDescription: "ההוצאה תישאר בספר ותסומן כמבוטלת.",
    voidTitle: "לבטל את ההוצאה?",
    operations: "תפעול",
    campaignFunds: "כספי קמפיינים",
    availableBalance: "יתרה זמינה ששולמה מראש",
    addFunds: "הוספת כסף",
    amountToLoad: "סכום לטעינה",
    billingHint:
      "פרטי כרטיס נאספים רק ב-Stripe Checkout. מסירת קמפיינים יכולה לשריין ולחייב יתרה זו כאשר קמפיינים אמיתיים מופעלים.",
    fundsAdded: "כספי הקמפיין נוספו.",
    fundsError: "לא הצלחנו להוסיף כסף. לא אושר חיוב.",
    stripeBilling: "הטעינה ממשיכה תמיד דרך Stripe Checkout המאובטח.",
    paymentMethod: "אמצעי תשלום",
    connectCard: "חיבור כרטיס",
    replaceCard: "החלפת כרטיס",
    noCard: "לא מחובר כרטיס תשלום",
    cardRequired: "יש לחבר כרטיס תשלום לפני הוספת כסף לקמפיינים.",
    billingUnavailable:
      "Stripe אינו מוגדר בפריסה זו. חיבור כרטיס וטעינת כסף אינם זמינים.",
    cardEnding: "מסתיים בספרות",
    expires: "תוקף",
  },
} as const;

function emptyDraft(currency: string, category: string): ExpenseDraft {
  return {
    title: "",
    vendor: "",
    category,
    amount: "",
    currency,
    status: "recorded",
    notes: "",
    incurredAt: "",
  };
}

function dateInputValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function formatMoney(value: string | number, currency: string, locale: string) {
  const amount = typeof value === "number" ? value : Number(value);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

function statusClass(status: ExpenseStatus) {
  return [
    styles.status ?? "",
    status === "recorded"
      ? (styles.statusRecorded ?? "")
      : status === "pending"
        ? (styles.statusPending ?? "")
        : (styles.statusVoid ?? ""),
  ].join(" ");
}

function chartSeries(expenses: readonly Expense[], currency: string) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);
  const buckets = Array.from({ length: 10 }, (_, index) => ({
    date: new Date(start.getTime() + index * 3 * 86_400_000),
    value: 0,
  }));
  for (const expense of expenses) {
    if (expense.status !== "recorded" || expense.currency !== currency)
      continue;
    const timestamp = new Date(expense.incurredAt).getTime();
    if (timestamp < start.getTime() || timestamp > today.getTime()) continue;
    const index = Math.min(
      buckets.length - 1,
      Math.floor((timestamp - start.getTime()) / (3 * 86_400_000)),
    );
    const bucket = buckets[index];
    if (bucket !== undefined) {
      const amount = Number(expense.amount);
      bucket.value += Number.isFinite(amount) ? amount : 0;
    }
  }
  return buckets;
}

function buildChart(expenses: readonly Expense[], currency: string) {
  const series = chartSeries(expenses, currency);
  const max = Math.max(...series.map((item) => item.value), 1);
  const points = series.map((item, index) => ({
    ...item,
    x: 8 + (index / Math.max(1, series.length - 1)) * 84,
    y: 88 - (item.value / max) * 72,
  }));
  const line = points.map((point) => [point.x, point.y].join(",")).join(" ");
  const area = [
    "M",
    points[0]?.x ?? 8,
    "92 L",
    points.map((point) => [point.x, point.y].join(" ")).join(" L "),
    "L",
    points.at(-1)?.x ?? 92,
    "92 Z",
  ].join(" ");
  return { points, line, area, hasData: series.some((item) => item.value > 0) };
}

export function FinanceWorkspace({
  initialExpenses,
  initialNextCursor,
  initialSummary,
  defaultCurrency,
  voiceEstimates,
  voiceEstimateAvailable,
  initialWallet,
  initialPaymentSource,
  realBillingEnabled = false,
}: {
  readonly initialExpenses: readonly Expense[];
  readonly initialNextCursor: ExpenseCursor | null;
  readonly initialSummary: ExpenseSummary;
  readonly defaultCurrency: string;
  readonly voiceEstimates: readonly VoiceUsageEstimate[];
  readonly voiceEstimateAvailable: boolean;
  readonly initialWallet?: CampaignWallet;
  readonly initialPaymentSource?: CampaignPaymentSource | null;
  readonly realBillingEnabled?: boolean;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const router = useRouter();
  const canEdit = useCapability("tenant:manage");
  const [expenses, setExpenses] = useState([...initialExpenses]);
  const [summary, setSummary] = useState(initialSummary);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "expenses">(
    "overview",
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | ExpenseStatus>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Expense>();
  const [voiding, setVoiding] = useState<Expense>();
  const [draft, setDraft] = useState<ExpenseDraft>(() =>
    emptyDraft(defaultCurrency, t.operations),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const wallet = initialWallet;
  const [topupAmount, setTopupAmount] = useState("50");
  const [topupPending, setTopupPending] = useState(false);
  const [topupNotice, setTopupNotice] = useState<string>();
  const paymentSource = initialPaymentSource ?? null;
  const paymentReady = realBillingEnabled && paymentSource?.status === "active";

  async function connectPaymentSource() {
    if (!realBillingEnabled || topupPending) return;
    setTopupPending(true);
    setTopupNotice(undefined);
    try {
      const result = await crmMutation<{ checkoutUrl: string }>(
        "/api/billing/payment-source",
        {},
        { idempotencyKey: `payment-source-${crypto.randomUUID()}` },
      );
      window.location.assign(result.checkoutUrl);
    } catch {
      setTopupNotice(t.fundsError);
      setTopupPending(false);
    }
  }

  async function addFunds(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (topupPending) return;
    setTopupPending(true);
    setTopupNotice(undefined);
    try {
      const result = await crmMutation<{
        checkoutUrl: string;
      }>(
        "/api/billing/topups",
        { amount: Number(topupAmount) },
        { idempotencyKey: `campaign-topup-${crypto.randomUUID()}` },
      );
      window.location.assign(result.checkoutUrl);
    } catch {
      setTopupNotice(t.fundsError);
    } finally {
      setTopupPending(false);
    }
  }

  useEffect(() => {
    setExpenses([...initialExpenses]);
    setSummary(initialSummary);
    setNextCursor(initialNextCursor);
  }, [initialExpenses, initialNextCursor, initialSummary]);

  const currencyTotals = summary.totals.map((item) => ({
    currency: item.currency,
    recorded: Number(item.recordedTotal) || 0,
    pending: Number(item.pendingTotal) || 0,
    count: item.recordedCount + item.pendingCount,
  }));
  const availableCurrencies = [
    ...new Set([
      defaultCurrency,
      ...currencyTotals.map((item) => item.currency),
    ]),
  ];
  const [chartCurrency, setChartCurrency] = useState(defaultCurrency);
  const effectiveChartCurrency = availableCurrencies.includes(chartCurrency)
    ? chartCurrency
    : defaultCurrency;
  const chart = useMemo(
    () => buildChart(expenses, effectiveChartCurrency),
    [expenses, effectiveChartCurrency],
  );
  const now = new Date();
  const thisMonthTotal = expenses
    .filter((expense) => {
      const date = new Date(expense.incurredAt);
      return (
        expense.status === "recorded" &&
        expense.currency === effectiveChartCurrency &&
        date.getMonth() === now.getMonth() &&
        date.getFullYear() === now.getFullYear()
      );
    })
    .reduce((sum, expense) => sum + (Number(expense.amount) || 0), 0);
  const primaryTotals = currencyTotals.find(
    (item) => item.currency === effectiveChartCurrency,
  );
  const filtered = expenses.filter((expense) => {
    const haystack =
      `${expense.title} ${expense.vendor ?? ""} ${expense.category}`.toLowerCase();
    return (
      (status === "all" || expense.status === status) &&
      haystack.includes(query.trim().toLowerCase())
    );
  });
  const voiceTotal = voiceEstimates.reduce(
    (sum, estimate) => sum + estimate.totalUsd,
    0,
  );
  const partialVoiceCount = voiceEstimates.filter(
    (estimate) => estimate.partial,
  ).length;

  function openCreate() {
    setEditing(undefined);
    setDraft({
      ...emptyDraft(defaultCurrency, t.operations),
      incurredAt: dateInputValue(new Date().toISOString()),
    });
    setError(undefined);
    setDialogOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditing(expense);
    setDraft({
      title: expense.title,
      vendor: expense.vendor ?? "",
      category: expense.category,
      amount: expense.amount,
      currency: expense.currency,
      status: expense.status === "pending" ? "pending" : "recorded",
      notes: expense.notes ?? "",
      incurredAt: dateInputValue(expense.incurredAt),
    });
    setError(undefined);
    setDialogOpen(true);
  }

  function openVoid(expense: Expense) {
    setError(undefined);
    setVoiding(expense);
  }

  async function submitExpense(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const body = {
      title: draft.title.trim(),
      vendor: draft.vendor.trim() || null,
      category: draft.category.trim(),
      amount: draft.amount,
      currency: draft.currency.trim().toUpperCase(),
      status: draft.status,
      notes: draft.notes.trim() || null,
      incurredAt: new Date(`${draft.incurredAt}T12:00:00`).toISOString(),
      sourceKind: "manual",
      sourceReference: null,
    };
    try {
      const result = await crmMutation<ExpensePayload>(
        editing
          ? `/api/finance/expenses/${editing.id}`
          : "/api/finance/expenses",
        body,
        { method: editing ? "PATCH" : "POST" },
      );
      setExpenses((current) =>
        editing
          ? current.map((item) =>
              item.id === result.expense.id ? result.expense : item,
            )
          : [result.expense, ...current],
      );
      setDialogOpen(false);
      router.refresh();
    } catch {
      setError(t.saveError);
    } finally {
      setPending(false);
    }
  }

  async function confirmVoid() {
    if (!voiding) return;
    const expense = voiding;
    setPending(true);
    setError(undefined);
    try {
      const result = await crmMutation<ExpensePayload>(
        `/api/finance/expenses/${expense.id}`,
        {},
        { method: "DELETE" },
      );
      setExpenses((current) =>
        current.map((item) =>
          item.id === result.expense.id ? result.expense : item,
        ),
      );
      setVoiding(undefined);
      router.refresh();
    } catch {
      setError(t.voidError);
    } finally {
      setPending(false);
    }
  }

  async function loadMore() {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const query = new URLSearchParams({
        limit: "500",
        cursorAt: nextCursor.incurredAt,
        cursorId: nextCursor.id,
      });
      const result = await crmRead<{
        expenses: Expense[];
        nextCursor: ExpenseCursor | null;
      }>(`/api/finance/expenses?${query}`);
      setExpenses((current) => {
        const known = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...result.expenses.filter((item) => !known.has(item.id)),
        ];
      });
      setNextCursor(result.nextCursor);
    } catch {
      setError(t.loadError);
    } finally {
      setLoadingMore(false);
    }
  }

  function exportExpenses() {
    const rows = [
      [
        t.expenseTitle,
        t.vendor,
        t.category,
        t.amount,
        t.currency,
        t.status,
        t.date,
      ],
      ...filtered.map((expense) => [
        expense.title,
        expense.vendor ?? "",
        expense.category,
        expense.amount,
        expense.currency,
        expense.status,
        expense.incurredAt,
      ]),
    ];
    const csv = rows
      .map((row) =>
        row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","),
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tenant-expenses-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className={["platform-admin-workspace", styles.workspace].join(" ")}
      aria-busy={pending || undefined}
    >
      <header className="platform-admin-hero">
        <div className="platform-admin-hero__copy">
          <span className="eyebrow">{t.eyebrow}</span>
          <h1>{t.title}</h1>
          <p>{t.description}</p>
        </div>
        {canEdit ? (
          <Button className="platform-admin-hero__action" onClick={openCreate}>
            <Plus aria-hidden="true" size={15} />
            {t.addExpense}
          </Button>
        ) : null}
      </header>

      {wallet ? (
        <section
          className={[styles.walletCard, styles.featureCard].join(" ")}
          aria-label={t.campaignFunds}
        >
          <div>
            <span>
              <WalletCards size={17} />
              {t.campaignFunds}
            </span>
            <strong>
              {formatMoney(
                wallet.availableMinor / 100,
                wallet.currency,
                locale,
              )}
            </strong>
            <small>
              {t.availableBalance} · {wallet.currency}
            </small>
            <small>{t.stripeBilling}</small>
          </div>
          <div className={styles.paymentSource}>
            <span>
              <CreditCard aria-hidden="true" size={16} />
              {t.paymentMethod}
            </span>
            {paymentSource?.status === "active" && paymentSource.last4 ? (
              <div>
                <strong>
                  {paymentSource.brand?.toUpperCase()} · {t.cardEnding}{" "}
                  {paymentSource.last4}
                </strong>
                <small>
                  {t.expires} {paymentSource.expMonth}/
                  {String(paymentSource.expYear).slice(-2)}
                </small>
              </div>
            ) : (
              <strong>{t.noCard}</strong>
            )}
            <Button
              disabled={!realBillingEnabled || topupPending}
              onClick={() => void connectPaymentSource()}
              size="small"
              type="button"
              variant="secondary"
            >
              {paymentSource?.status === "active"
                ? t.replaceCard
                : t.connectCard}
            </Button>
          </div>
          <form
            className={styles.topupForm}
            onSubmit={(event) => void addFunds(event)}
          >
            <Input
              id="campaign-topup"
              label={t.amountToLoad}
              min="1"
              onChange={(event) => setTopupAmount(event.target.value)}
              step="0.01"
              type="number"
              value={topupAmount}
            />
            <Button disabled={!paymentReady || topupPending} type="submit">
              {t.addFunds}
            </Button>
          </form>
          <p>
            {realBillingEnabled
              ? paymentReady
                ? t.billingHint
                : t.cardRequired
              : t.billingUnavailable}
          </p>
          {topupNotice ? <p role="status">{topupNotice}</p> : null}
        </section>
      ) : null}

      <div className={styles.toolbar}>
        <div className={styles.tabs} aria-label={t.title}>
          <button
            aria-pressed={activeTab === "overview"}
            className={styles.tab}
            onClick={() => setActiveTab("overview")}
            type="button"
          >
            {t.overview}
          </button>
          <button
            aria-pressed={activeTab === "expenses"}
            className={styles.tab}
            onClick={() => setActiveTab("expenses")}
            type="button"
          >
            {t.expenses}
          </button>
        </div>
        <div className={styles.toolbarActions}>
          <span className={styles.muted}>
            <RotateCw aria-hidden="true" size={13} />{" "}
            {nextCursor === null ? (
              <>
                {new Intl.NumberFormat(locale).format(summary.expenseCount)}{" "}
                {t.storedRecords}
              </>
            ) : (
              <>
                {new Intl.NumberFormat(locale).format(expenses.length)}{" "}
                {t.loadedRecords} ·{" "}
                {new Intl.NumberFormat(locale).format(summary.expenseCount)}{" "}
                {t.storedRecords}
              </>
            )}
          </span>
          <Button onClick={exportExpenses} size="small" variant="secondary">
            <Download aria-hidden="true" size={14} />
            {t.export}
          </Button>
        </div>
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {activeTab === "overview" ? (
        <>
          <section className={styles.overviewGrid} aria-label={t.overviewLabel}>
            <div className={styles.kpis}>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>{t.recordedExpenses}</span>
                <div>
                  <strong className={styles.kpiValue}>
                    {formatMoney(
                      primaryTotals?.recorded ?? 0,
                      effectiveChartCurrency,
                      locale,
                    )}
                  </strong>
                  <span className={styles.kpiMeta}>
                    {effectiveChartCurrency} · {t.ledgerTotal}
                  </span>
                </div>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>{t.thisMonth}</span>
                <div>
                  <strong className={styles.kpiValue}>
                    {formatMoney(
                      thisMonthTotal,
                      effectiveChartCurrency,
                      locale,
                    )}
                  </strong>
                  <span className={styles.kpiMeta}>
                    {nextCursor === null
                      ? t.currentMonth
                      : t.currentMonthLoaded}
                  </span>
                </div>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>{t.pending}</span>
                <div>
                  <strong className={styles.kpiValue}>
                    {formatMoney(
                      primaryTotals?.pending ?? 0,
                      effectiveChartCurrency,
                      locale,
                    )}
                  </strong>
                  <span className={styles.kpiMeta}>{t.awaiting}</span>
                </div>
              </article>
              <article className={styles.kpi}>
                <span className={styles.kpiLabel}>{t.activeRecords}</span>
                <div>
                  <strong className={styles.kpiValue}>
                    {new Intl.NumberFormat(locale).format(
                      summary.recordedCount + summary.pendingCount,
                    )}
                  </strong>
                  <span className={styles.kpiMeta}>
                    {new Intl.NumberFormat(locale).format(summary.voidCount)}{" "}
                    {t.voided}
                  </span>
                </div>
              </article>
            </div>

            <div className={styles.sideStack}>
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <div>
                    <h2>{t.currencyTitle}</h2>
                    <p>{t.currencyDescription}</p>
                  </div>
                  <WalletCards aria-hidden="true" size={18} />
                </header>
                <div className={styles.summaryList}>
                  {currencyTotals.length ? (
                    currencyTotals.map((item) => (
                      <div className={styles.summaryLine} key={item.currency}>
                        <span>{item.currency}</span>
                        <strong>
                          {formatMoney(item.recorded, item.currency, locale)}
                        </strong>
                      </div>
                    ))
                  ) : (
                    <div className={styles.summaryLine}>
                      <span>{t.noCurrencies}</span>
                      <strong>—</strong>
                    </div>
                  )}
                </div>
              </article>

              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <div>
                    <h2>{t.voiceTitle}</h2>
                    <p>{t.voiceDescription}</p>
                  </div>
                </header>
                {voiceEstimateAvailable ? (
                  <>
                    <div className={styles.voiceTotal}>
                      {formatMoney(voiceTotal, "USD", locale)}
                    </div>
                    <p className={styles.voiceMeta}>
                      {new Intl.NumberFormat(locale).format(
                        voiceEstimates.length,
                      )}{" "}
                      {t.voiceSessions}
                    </p>
                    {partialVoiceCount ? (
                      <span className={styles.voiceStatus}>
                        {new Intl.NumberFormat(locale).format(
                          partialVoiceCount,
                        )}{" "}
                        {t.partialEstimates}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <p className={styles.voiceMeta}>{t.voiceUnavailable}</p>
                )}
              </article>
            </div>
          </section>

          <article className={styles.chartCard}>
            <header className={styles.cardHeader}>
              <div>
                <h2>{t.activityTitle}</h2>
                <p>
                  {nextCursor === null
                    ? t.activityDescription
                    : t.activityLoadedDescription}
                </p>
              </div>
              {availableCurrencies.length > 0 ? (
                <div className={styles.chartControls}>
                  <label
                    className="or-visually-hidden"
                    htmlFor="finance-chart-currency"
                  >
                    {t.chartCurrency}
                  </label>
                  <select
                    className={styles.compactSelect}
                    id="finance-chart-currency"
                    onChange={(event) => setChartCurrency(event.target.value)}
                    value={effectiveChartCurrency}
                  >
                    {availableCurrencies.map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </header>
            <div className={styles.chart}>
              <svg
                aria-label={`${t.chartLabel} · ${effectiveChartCurrency}`}
                preserveAspectRatio="none"
                viewBox="0 0 100 100"
                role="img"
              >
                {[20, 44, 68, 92].map((y) => (
                  <line
                    className={styles.gridLine}
                    key={y}
                    x1="8"
                    x2="92"
                    y1={y}
                    y2={y}
                  />
                ))}
                {chart.hasData ? (
                  <>
                    <path className={styles.area} d={chart.area} />
                    <polyline
                      className={styles.trend}
                      pathLength="1"
                      points={chart.line}
                    />
                    {chart.points
                      .filter(
                        (_, index) =>
                          index % 3 === 0 || index === chart.points.length - 1,
                      )
                      .map((point) => (
                        <circle
                          className={styles.point}
                          cx={point.x}
                          cy={point.y}
                          key={point.date.toISOString()}
                          r="1.4"
                        />
                      ))}
                  </>
                ) : null}
              </svg>
              <table className="or-visually-hidden">
                <caption>
                  {t.chartData} · {effectiveChartCurrency}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{t.date}</th>
                    <th scope="col">{t.amount}</th>
                  </tr>
                </thead>
                <tbody>
                  {chart.points.map((point) => (
                    <tr key={point.date.toISOString()}>
                      <th scope="row">
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                        }).format(point.date)}
                      </th>
                      <td>
                        {formatMoney(
                          point.value,
                          effectiveChartCurrency,
                          locale,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!chart.hasData ? (
                <div className={styles.chartEmpty}>{t.chartEmpty}</div>
              ) : null}
              <div className={styles.axisLabels} aria-hidden="true">
                <span>{t.ago30}</span>
                <span>{t.ago20}</span>
                <span>{t.ago10}</span>
                <span>{t.today}</span>
              </div>
            </div>
          </article>
        </>
      ) : null}

      <section className={styles.ledger} aria-label={t.ledgerLabel}>
        <header className={styles.ledgerHeader}>
          <div>
            <h2>
              {activeTab === "expenses" ? t.allExpenses : t.recentExpenses}
            </h2>
            <p>
              {new Intl.NumberFormat(locale).format(filtered.length)}{" "}
              {nextCursor === null
                ? t.matchingRecords
                : t.matchingLoadedRecords}
            </p>
          </div>
          <div className={styles.ledgerTools}>
            <label className="or-visually-hidden" htmlFor="expense-search">
              {t.search}
            </label>
            <input
              className={styles.search}
              id="expense-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t.searchPlaceholder}
              type="search"
              value={query}
            />
            <label className="or-visually-hidden" htmlFor="expense-status">
              {t.status}
            </label>
            <select
              className={styles.compactSelect}
              id="expense-status"
              onChange={(event) =>
                setStatus(event.target.value as "all" | ExpenseStatus)
              }
              value={status}
            >
              <option value="all">{t.allStatuses}</option>
              <option value="recorded">{t.recorded}</option>
              <option value="pending">{t.pending}</option>
              <option value="void">{t.void}</option>
            </select>
          </div>
        </header>
        {nextCursor !== null ? (
          <p className={styles.loadedNotice} role="status">
            {t.loadedNotice}
          </p>
        ) : null}
        {filtered.length ? (
          <>
            <div
              className={styles.tableViewport}
              tabIndex={0}
              role="region"
              aria-label={t.scrollLabel}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t.expense}</th>
                    <th scope="col">{t.category}</th>
                    <th scope="col">{t.date}</th>
                    <th scope="col">{t.status}</th>
                    <th scope="col">{t.amount}</th>
                    <th scope="col">
                      <span className="or-visually-hidden">{t.actions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((expense) => (
                    <tr key={expense.id}>
                      <th scope="row">
                        <span>{expense.title}</span>
                        <small>{expense.vendor ?? t.noVendor}</small>
                      </th>
                      <td>{expense.category}</td>
                      <td>
                        <time dateTime={expense.incurredAt}>
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                          }).format(new Date(expense.incurredAt))}
                        </time>
                      </td>
                      <td>
                        <span className={statusClass(expense.status)}>
                          {expense.status === "recorded"
                            ? t.recorded
                            : expense.status === "pending"
                              ? t.pending
                              : t.void}
                        </span>
                      </td>
                      <td>
                        <strong>
                          <bdi>
                            {formatMoney(
                              expense.amount,
                              expense.currency,
                              locale,
                            )}
                          </bdi>
                        </strong>
                      </td>
                      <td>
                        {canEdit && expense.status !== "void" ? (
                          <div className={styles.rowActions}>
                            <Button
                              aria-label={`${t.edit}: ${expense.title}`}
                              onClick={() => openEdit(expense)}
                              size="small"
                              variant="quiet"
                            >
                              <Edit3 aria-hidden="true" size={14} />
                            </Button>
                            <Button
                              aria-label={`${t.voidExpense}: ${expense.title}`}
                              onClick={() => openVoid(expense)}
                              size="small"
                              variant="quiet"
                            >
                              <Trash2 aria-hidden="true" size={14} />
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.mobileList}>
              {filtered.map((expense) => (
                <article className={styles.mobileCard} key={expense.id}>
                  <header className={styles.mobileCardHeader}>
                    <div>
                      <h3>{expense.title}</h3>
                      <p>{expense.vendor ?? t.noVendor}</p>
                    </div>
                    <strong>
                      <bdi>
                        {formatMoney(expense.amount, expense.currency, locale)}
                      </bdi>
                    </strong>
                  </header>
                  <div className={styles.mobileCardMeta}>
                    <span>{expense.category}</span>
                    <time dateTime={expense.incurredAt}>
                      {new Intl.DateTimeFormat(locale, {
                        dateStyle: "medium",
                      }).format(new Date(expense.incurredAt))}
                    </time>
                    <span className={statusClass(expense.status)}>
                      {expense.status === "recorded"
                        ? t.recorded
                        : expense.status === "pending"
                          ? t.pending
                          : t.void}
                    </span>
                  </div>
                  {canEdit && expense.status !== "void" ? (
                    <div className={styles.rowActions}>
                      <Button
                        aria-label={`${t.edit}: ${expense.title}`}
                        onClick={() => openEdit(expense)}
                        size="small"
                        variant="quiet"
                      >
                        <Edit3 aria-hidden="true" size={14} />
                      </Button>
                      <Button
                        aria-label={`${t.voidExpense}: ${expense.title}`}
                        onClick={() => openVoid(expense)}
                        size="small"
                        variant="quiet"
                      >
                        <Trash2 aria-hidden="true" size={14} />
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <div>
              <strong>
                {expenses.length
                  ? nextCursor === null
                    ? t.noMatches
                    : t.noLoadedMatches
                  : t.noExpenses}
              </strong>
              <p>
                {expenses.length
                  ? nextCursor === null
                    ? t.adjustFilters
                    : t.adjustLoadedFilters
                  : t.addFirst}
              </p>
            </div>
          </div>
        )}
        {nextCursor !== null ? (
          <div className={styles.loadMore}>
            <Button
              busy={loadingMore}
              onClick={() => void loadMore()}
              variant="secondary"
            >
              {t.loadMore}
            </Button>
          </div>
        ) : null}
      </section>

      <Dialog
        className={styles.dialog ?? ""}
        closeLabel={t.close}
        description={t.dialogDescription}
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title={editing ? t.editTitle : t.createTitle}
      >
        <form
          className={styles.dialogForm}
          onSubmit={(event) => void submitExpense(event)}
        >
          <div className={styles.formGrid}>
            <div className={styles.fullField}>
              <Input
                autoFocus
                id="expense-title"
                label={t.expenseTitle}
                maxLength={240}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    title: event.target.value,
                  }))
                }
                required
                value={draft.title}
              />
            </div>
            <Input
              id="expense-vendor"
              label={t.vendor}
              maxLength={240}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  vendor: event.target.value,
                }))
              }
              value={draft.vendor}
            />
            <Input
              id="expense-category"
              label={t.category}
              maxLength={80}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  category: event.target.value,
                }))
              }
              required
              value={draft.category}
            />
            <Input
              id="expense-amount"
              inputMode="decimal"
              label={t.amount}
              min="0.000001"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  amount: event.target.value,
                }))
              }
              required
              step="0.000001"
              type="number"
              value={draft.amount}
            />
            <Input
              id="expense-currency"
              label={t.currency}
              maxLength={3}
              minLength={3}
              name="currency"
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  currency: event.target.value.toUpperCase(),
                }))
              }
              required
              value={draft.currency}
            />
            <Input
              id="expense-date"
              label={t.incurredDate}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  incurredAt: event.target.value,
                }))
              }
              required
              type="date"
              value={draft.incurredAt}
            />
            <Select
              id="expense-recording-status"
              label={t.status}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as ExpenseDraft["status"],
                }))
              }
              value={draft.status}
            >
              <option value="recorded">{t.recorded}</option>
              <option value="pending">{t.pending}</option>
            </Select>
            <div className={styles.fullField}>
              <Textarea
                id="expense-notes"
                label={t.notes}
                maxLength={10000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    notes: event.target.value,
                  }))
                }
                rows={3}
                value={draft.notes}
              />
            </div>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            <Button
              disabled={pending}
              onClick={() => setDialogOpen(false)}
              variant="quiet"
            >
              {t.cancel}
            </Button>
            <Button busy={pending} type="submit">
              {editing ? t.save : t.create}
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        busy={pending}
        cancelLabel={t.keepExpense}
        confirmLabel={t.voidExpense}
        description={t.voidDescription}
        destructive
        onCancel={() => setVoiding(undefined)}
        onConfirm={() => void confirmVoid()}
        open={voiding !== undefined}
        title={t.voidTitle}
      >
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
