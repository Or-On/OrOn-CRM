import type postgres from "postgres";

import type {
  Expense,
  ExpenseCursor,
  ExpenseCurrencySummary,
  ExpenseInput,
  ExpensePage,
  ExpenseStatus,
  ExpenseSummary,
} from "./types.js";

interface ExpenseRow {
  id: string;
  created_by_user_id: string | null;
  title: string;
  vendor: string | null;
  category: string;
  amount: string;
  currency: string;
  status: ExpenseStatus;
  source_kind: Expense["sourceKind"];
  source_reference: string | null;
  notes: string | null;
  incurred_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface ExpenseListOptions {
  readonly query?: string;
  readonly status?: ExpenseStatus;
  readonly category?: string;
  readonly limit?: number;
  readonly cursor?: ExpenseCursor;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum)
    throw new TypeError(
      `${name} must contain between 1 and ${String(maximum)} characters`,
    );
  return normalized;
}

function nullableText(
  value: string | null | undefined,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximum)
    throw new TypeError(
      `${name} must contain no more than ${String(maximum)} characters`,
    );
  return normalized;
}

function decimalAmount(value: string): string {
  const normalized = value.trim();
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/u.exec(normalized);
  if (match === null || !/[1-9]/u.test(normalized))
    throw new TypeError(
      "amount must be a positive decimal with up to 6 fractional digits",
    );
  const whole = (match[1] ?? "0").replace(/^0+(?=\d)/u, "");
  const fraction = match[2]?.replace(/0+$/u, "");
  return fraction === undefined || fraction === ""
    ? whole
    : `${whole}.${fraction}`;
}

function currencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized))
    throw new TypeError("currency must use a three-letter ISO code");
  return normalized;
}

function editableStatus(value: string): Exclude<ExpenseStatus, "void"> {
  if (value !== "pending" && value !== "recorded")
    throw new TypeError("expense status must be pending or recorded");
  return value;
}

function instant(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized) ||
    !Number.isFinite(Date.parse(normalized))
  ) {
    throw new TypeError(
      `${name} must be an ISO 8601 instant with a time-zone offset`,
    );
  }
  return new Date(normalized).toISOString();
}

function mapExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    createdByUserId: row.created_by_user_id,
    title: row.title,
    vendor: row.vendor,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    sourceKind: row.source_kind,
    sourceReference: row.source_reference,
    notes: row.notes,
    incurredAt: row.incurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listExpenses(
  sql: postgres.TransactionSql,
  options: ExpenseListOptions = {},
): Promise<readonly Expense[]> {
  return (await listExpensePage(sql, options)).expenses;
}

export async function listExpensePage(
  sql: postgres.TransactionSql,
  options: ExpenseListOptions = {},
): Promise<ExpensePage> {
  const query = options.query?.trim() ?? "";
  if (query.length > 200) throw new TypeError("expense search is too long");
  const category = options.category?.trim() ?? "";
  if (category.length > 80) throw new TypeError("expense category is too long");
  const status: string | null = options.status ?? null;
  if (
    status !== null &&
    status !== "pending" &&
    status !== "recorded" &&
    status !== "void"
  )
    throw new TypeError("invalid expense status");
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
  const cursorAt =
    options.cursor === undefined
      ? null
      : instant(options.cursor.incurredAt, "expense cursor incurredAt");
  const cursorId = options.cursor?.id ?? null;
  if (cursorId !== null && !uuidPattern.test(cursorId))
    throw new TypeError("invalid expense cursor identifier");
  const rows = await sql<ExpenseRow[]>`
    SELECT id, created_by_user_id, title, vendor, category, amount::text,
           currency, status, source_kind, source_reference, notes,
           incurred_at, created_at, updated_at
    FROM finance.expenses
    WHERE (${query}::text = '' OR title ILIKE '%' || ${query} || '%'
           OR coalesce(vendor, '') ILIKE '%' || ${query} || '%'
           OR category ILIKE '%' || ${query} || '%'
           OR coalesce(notes, '') ILIKE '%' || ${query} || '%')
      AND (${status}::text IS NULL OR status = ${status})
      AND (${category}::text = '' OR lower(category) = lower(${category}))
      AND (${cursorAt}::timestamptz IS NULL OR (incurred_at, id) <
        (${cursorAt}::timestamptz, ${cursorId}::uuid))
    ORDER BY incurred_at DESC, id DESC
    LIMIT ${limit + 1}
  `;
  const hasNextPage = rows.length > limit;
  const expenses = rows.slice(0, limit).map(mapExpense);
  const last = expenses.at(-1);
  return {
    expenses,
    nextCursor:
      hasNextPage && last !== undefined
        ? { incurredAt: last.incurredAt, id: last.id }
        : null,
  };
}

export async function summarizeExpenses(
  sql: postgres.TransactionSql,
): Promise<ExpenseSummary> {
  const totals = await sql<ExpenseCurrencySummary[]>`
    SELECT currency,
      coalesce(sum(amount) FILTER (WHERE status = 'recorded'), 0)::text AS "recordedTotal",
      coalesce(sum(amount) FILTER (WHERE status = 'pending'), 0)::text AS "pendingTotal",
      count(*) FILTER (WHERE status = 'recorded')::int AS "recordedCount",
      count(*) FILTER (WHERE status = 'pending')::int AS "pendingCount"
    FROM finance.expenses
    WHERE status <> 'void'
    GROUP BY currency
    ORDER BY currency
  `;
  const counts = await sql<
    {
      expense_count: number;
      recorded_count: number;
      pending_count: number;
      void_count: number;
    }[]
  >`
    SELECT count(*)::int AS expense_count,
      count(*) FILTER (WHERE status = 'recorded')::int AS recorded_count,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      count(*) FILTER (WHERE status = 'void')::int AS void_count
    FROM finance.expenses
  `;
  const count = counts[0];
  if (count === undefined) throw new Error("expense summary returned no row");
  return {
    totals,
    expenseCount: count.expense_count,
    recordedCount: count.recorded_count,
    pendingCount: count.pending_count,
    voidCount: count.void_count,
  };
}

export async function createExpense(
  sql: postgres.TransactionSql,
  actorUserId: string | null,
  input: ExpenseInput,
): Promise<Expense> {
  const title = requiredText(input.title, "expense title", 240);
  const vendor = nullableText(input.vendor, "expense vendor", 240);
  const category = requiredText(input.category, "expense category", 80);
  const amount = decimalAmount(input.amount);
  const currency = currencyCode(input.currency);
  const status =
    input.status === undefined ? "recorded" : editableStatus(input.status);
  const notes = nullableText(input.notes, "expense notes", 10_000);
  const incurredAt = instant(input.incurredAt, "incurredAt");
  const rows = await sql<ExpenseRow[]>`
    INSERT INTO finance.expenses(
      tenant_id, created_by_user_id, title, vendor, category, amount,
      currency, status, source_kind, notes, incurred_at
    ) VALUES (
      platform.current_tenant_id(), ${actorUserId}::uuid, ${title}, ${vendor},
      ${category}, ${amount}::numeric, ${currency}, ${status}, 'manual', ${notes},
      ${incurredAt}::timestamptz
    )
    RETURNING id, created_by_user_id, title, vendor, category, amount::text,
      currency, status, source_kind, source_reference, notes,
      incurred_at, created_at, updated_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("expense insert returned no row");
  return mapExpense(row);
}

export async function updateExpense(
  sql: postgres.TransactionSql,
  expenseId: string,
  input: Partial<ExpenseInput>,
): Promise<Expense | undefined> {
  const changed =
    input.title !== undefined ||
    input.vendor !== undefined ||
    input.category !== undefined ||
    input.amount !== undefined ||
    input.currency !== undefined ||
    input.status !== undefined ||
    input.notes !== undefined ||
    input.incurredAt !== undefined;
  if (!changed) throw new TypeError("expense update contains no changes");
  const title =
    input.title === undefined
      ? null
      : requiredText(input.title, "expense title", 240);
  const vendor =
    input.vendor === undefined
      ? null
      : nullableText(input.vendor, "expense vendor", 240);
  const category =
    input.category === undefined
      ? null
      : requiredText(input.category, "expense category", 80);
  const amount =
    input.amount === undefined ? null : decimalAmount(input.amount);
  const currency =
    input.currency === undefined ? null : currencyCode(input.currency);
  const status =
    input.status === undefined ? null : editableStatus(input.status);
  const notes =
    input.notes === undefined
      ? null
      : nullableText(input.notes, "expense notes", 10_000);
  const incurredAt =
    input.incurredAt === undefined
      ? null
      : instant(input.incurredAt, "incurredAt");
  const rows = await sql<ExpenseRow[]>`
    UPDATE finance.expenses
    SET title = CASE WHEN ${input.title !== undefined} THEN ${title} ELSE title END,
        vendor = CASE WHEN ${input.vendor !== undefined} THEN ${vendor} ELSE vendor END,
        category = CASE WHEN ${input.category !== undefined} THEN ${category} ELSE category END,
        amount = CASE WHEN ${input.amount !== undefined} THEN ${amount}::numeric ELSE amount END,
        currency = CASE WHEN ${input.currency !== undefined} THEN ${currency} ELSE currency END,
        status = CASE WHEN ${input.status !== undefined} THEN ${status} ELSE status END,
        notes = CASE WHEN ${input.notes !== undefined} THEN ${notes} ELSE notes END,
        incurred_at = CASE WHEN ${input.incurredAt !== undefined}
          THEN ${incurredAt}::timestamptz ELSE incurred_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${expenseId}::uuid AND status <> 'void'
    RETURNING id, created_by_user_id, title, vendor, category, amount::text,
      currency, status, source_kind, source_reference, notes,
      incurred_at, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapExpense(rows[0]);
}

export async function voidExpense(
  sql: postgres.TransactionSql,
  expenseId: string,
): Promise<Expense | undefined> {
  const rows = await sql<ExpenseRow[]>`
    UPDATE finance.expenses
    SET status = 'void', updated_at = CURRENT_TIMESTAMP
    WHERE id = ${expenseId}::uuid AND status <> 'void'
    RETURNING id, created_by_user_id, title, vendor, category, amount::text,
      currency, status, source_kind, source_reference, notes,
      incurred_at, created_at, updated_at
  `;
  return rows[0] === undefined ? undefined : mapExpense(rows[0]);
}
