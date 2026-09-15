"use client";

import type {
  TeamMember,
  Task as TenantTask,
  TaskPriority,
  TaskStatus,
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
  Check,
  ChevronLeft,
  ChevronRight,
  Edit3,
  Plus,
  Trash2,
} from "lucide-react";
import { useLocale } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type SyntheticEvent } from "react";

import { useCapability } from "../access";
import { crmMutation } from "../crm";
import { tenantDateFormatter } from "../../i18n/tenant-date-time";
import { taskDueAtInput, taskDueAtInstant } from "./task-time";
import styles from "./tasks-workspace.module.css";

const COPY = {
  en: {
    title: "Tasks",
    subtitle: "Plan, assign, and finish tenant work from one live register.",
    add: "Add task",
    all: "All tasks",
    todo: "To do",
    inProgress: "In progress",
    completed: "Completed",
    search: "Search tasks…",
    allStatuses: "All statuses",
    allPriorities: "All priorities",
    showing: "Showing",
    of: "of",
    task: "Task",
    status: "Status",
    priority: "Priority",
    due: "Due",
    assignee: "Assignee",
    customer: "Customer",
    openCustomer: "Open customer",
    noCustomer: "Not linked",
    updated: "Updated",
    unassigned: "Unassigned",
    formerMember: "Former member",
    noDue: "No due date",
    previous: "Previous",
    next: "Next",
    page: "Page",
    noLoadedMatches: "No loaded tasks match these filters",
    noTasks: "No tasks yet",
    adjust: "Adjust the search, status, or priority filter.",
    createFirst: "Add the first task to start planning tenant work.",
    edit: "Edit",
    complete: "Complete",
    cancel: "Cancel task",
    close: "Close",
    editTitle: "Edit task",
    createTitle: "Add task",
    formDescription: "Task changes are saved to the tenant workspace.",
    taskTitle: "Task title",
    description: "Description",
    dueDate: "Due date",
    assignTo: "Assign to",
    save: "Save changes",
    create: "Create task",
    keep: "Keep task",
    confirmTitle: "Cancel this task?",
    confirmDescription:
      "The task remains in the record and is marked cancelled.",
    confirm: "Cancel task",
    saveError: "The task could not be saved. Your entries are still here.",
    updateError: "The task could not be updated. Please try again.",
    cancelError: "The task could not be cancelled. Please try again.",
    low: "Low",
    medium: "Medium",
    high: "High",
    urgent: "Urgent",
    cancelled: "Cancelled",
    actions: "Actions",
    resultLimit:
      "This register shows up to 500 tasks returned by the tenant service. Search and filters apply to these loaded tasks.",
  },
  he: {
    title: "משימות",
    subtitle: "תכנון, הקצאה והשלמה של עבודת הצוות מתוך רשימה חיה אחת.",
    add: "משימה חדשה",
    all: "כל המשימות",
    todo: "לביצוע",
    inProgress: "בתהליך",
    completed: "הושלמו",
    search: "חיפוש משימות…",
    allStatuses: "כל הסטטוסים",
    allPriorities: "כל העדיפויות",
    showing: "מוצגות",
    of: "מתוך",
    task: "משימה",
    status: "סטטוס",
    priority: "עדיפות",
    due: "יעד",
    assignee: "אחראי/ת",
    customer: "לקוח/ה",
    openCustomer: "פתיחת כרטיס לקוח",
    noCustomer: "ללא קישור",
    updated: "עודכן",
    unassigned: "ללא הקצאה",
    formerMember: "חבר/ת צוות לשעבר",
    noDue: "ללא תאריך יעד",
    previous: "הקודם",
    next: "הבא",
    page: "עמוד",
    noLoadedMatches: "אין משימות שנטענו שתואמות למסננים",
    noTasks: "עדיין אין משימות",
    adjust: "אפשר לשנות את החיפוש, הסטטוס או העדיפות.",
    createFirst: "הוסיפו משימה ראשונה כדי להתחיל לתכנן את עבודת הצוות.",
    edit: "עריכה",
    complete: "סיום",
    cancel: "ביטול משימה",
    close: "סגירה",
    editTitle: "עריכת משימה",
    createTitle: "משימה חדשה",
    formDescription: "השינויים נשמרים בסביבת העבודה של הארגון.",
    taskTitle: "שם המשימה",
    description: "תיאור",
    dueDate: "תאריך יעד",
    assignTo: "הקצאה אל",
    save: "שמירת שינויים",
    create: "יצירת משימה",
    keep: "השארת המשימה",
    confirmTitle: "לבטל את המשימה?",
    confirmDescription: "המשימה תישאר ברשומה ותסומן כמבוטלת.",
    confirm: "ביטול משימה",
    saveError: "לא הצלחנו לשמור את המשימה. הפרטים שהוזנו נשמרו.",
    updateError: "לא הצלחנו לעדכן את המשימה. נסו שוב.",
    cancelError: "לא הצלחנו לבטל את המשימה. נסו שוב.",
    low: "נמוכה",
    medium: "בינונית",
    high: "גבוהה",
    urgent: "דחופה",
    cancelled: "בוטלה",
    actions: "פעולות",
    resultLimit:
      "הרשימה מציגה עד 500 משימות שהוחזרו משירות הארגון. החיפוש והמסננים חלים על המשימות שנטענו.",
  },
} as const;

interface Draft {
  title: string;
  description: string;
  status: Exclude<TaskStatus, "cancelled">;
  priority: TaskPriority;
  dueAt: string;
  assigneeUserId: string;
}

const EMPTY_DRAFT: Draft = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  dueAt: "",
  assigneeUserId: "",
};

function statusClass(status: TaskStatus) {
  return [
    styles.status ?? "",
    status === "todo"
      ? (styles.todo ?? "")
      : status === "in_progress"
        ? (styles.progress ?? "")
        : status === "completed"
          ? (styles.completed ?? "")
          : (styles.cancelled ?? ""),
  ].join(" ");
}

function priorityClass(priority: TaskPriority) {
  return [styles.priority ?? "", styles[priority] ?? ""].join(" ");
}

export function TasksWorkspace({
  initialTasks,
  members,
  tenantTimeZone,
}: {
  readonly initialTasks: readonly TenantTask[];
  readonly members: readonly TeamMember[];
  readonly tenantTimeZone: string;
}) {
  const locale = useLocale();
  const t = COPY[locale.startsWith("he") ? "he" : "en"];
  const router = useRouter();
  const canEdit = useCapability("crm:write");
  const [tasks, setTasks] = useState([...initialTasks]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | TaskStatus>("all");
  const [priority, setPriority] = useState<"all" | TaskPriority>("all");
  const [page, setPage] = useState(0);
  const [pageSize] = useState(10);
  const [editing, setEditing] = useState<TenantTask>();
  const [cancelling, setCancelling] = useState<TenantTask>();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        (status === "all" || task.status === status) &&
        (priority === "all" || task.priority === priority) &&
        `${task.title} ${task.description ?? ""}`
          .toLowerCase()
          .includes(needle),
    );
  }, [priority, query, status, tasks]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(
    safePage * pageSize,
    (safePage + 1) * pageSize,
  );
  const statusLabel = (value: TaskStatus) =>
    value === "todo"
      ? t.todo
      : value === "in_progress"
        ? t.inProgress
        : value === "completed"
          ? t.completed
          : t.cancelled;
  const priorityLabel = (value: TaskPriority) => t[value];
  const formatDate = (value: string) =>
    tenantDateFormatter(locale, tenantTimeZone, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  const isOverdue = (task: TenantTask) =>
    task.dueAt !== null &&
    task.status !== "completed" &&
    task.status !== "cancelled" &&
    new Date(task.dueAt).getTime() < Date.now();

  function openCreate() {
    setEditing(undefined);
    setDraft(EMPTY_DRAFT);
    setError(undefined);
    setDialogOpen(true);
  }

  function openEdit(task: TenantTask) {
    setEditing(task);
    setDraft({
      title: task.title,
      description: task.description ?? "",
      status: task.status === "cancelled" ? "todo" : task.status,
      priority: task.priority,
      dueAt: taskDueAtInput(task.dueAt, tenantTimeZone),
      assigneeUserId: task.assigneeUserId ?? "",
    });
    setError(undefined);
    setDialogOpen(true);
  }

  async function saveTask(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingId(editing?.id ?? "new");
    setError(undefined);
    try {
      const result = await crmMutation<{ task: TenantTask }>(
        editing ? `/api/tasks/${editing.id}` : "/api/tasks",
        {
          title: draft.title.trim(),
          description: draft.description.trim() || null,
          status: draft.status,
          priority: draft.priority,
          assigneeUserId: draft.assigneeUserId || null,
          dueAt: draft.dueAt
            ? taskDueAtInstant(draft.dueAt, tenantTimeZone)
            : null,
        },
        { method: editing ? "PATCH" : "POST" },
      );
      setTasks((current) =>
        editing
          ? current.map((item) =>
              item.id === result.task.id ? result.task : item,
            )
          : [result.task, ...current],
      );
      setDialogOpen(false);
      router.refresh();
    } catch {
      setError(t.saveError);
    } finally {
      setPendingId(undefined);
    }
  }

  async function setTaskStatus(task: TenantTask, nextStatus: TaskStatus) {
    setPendingId(task.id);
    setError(undefined);
    try {
      const result = await crmMutation<{ task: TenantTask }>(
        `/api/tasks/${task.id}`,
        { status: nextStatus },
        { method: "PATCH" },
      );
      setTasks((current) =>
        current.map((item) =>
          item.id === result.task.id ? result.task : item,
        ),
      );
      router.refresh();
    } catch {
      setError(t.updateError);
    } finally {
      setPendingId(undefined);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    const task = cancelling;
    setPendingId(task.id);
    setError(undefined);
    try {
      const result = await crmMutation<{ task: TenantTask }>(
        `/api/tasks/${task.id}`,
        {},
        { method: "DELETE" },
      );
      setTasks((current) =>
        current.map((item) =>
          item.id === result.task.id ? result.task : item,
        ),
      );
      setCancelling(undefined);
      router.refresh();
    } catch {
      setError(t.cancelError);
    } finally {
      setPendingId(undefined);
    }
  }

  function openCancel(task: TenantTask) {
    setError(undefined);
    setCancelling(task);
  }

  const actionButtons = (task: TenantTask) =>
    canEdit && task.status !== "cancelled" ? (
      <div className={styles.rowActions}>
        {task.status !== "completed" ? (
          <Button
            aria-label={`${t.complete}: ${task.title}`}
            disabled={pendingId !== undefined}
            onClick={() => void setTaskStatus(task, "completed")}
            size="small"
            variant="quiet"
          >
            <Check aria-hidden="true" size={14} />
          </Button>
        ) : null}
        <Button
          aria-label={`${t.edit}: ${task.title}`}
          disabled={pendingId !== undefined}
          onClick={() => openEdit(task)}
          size="small"
          variant="quiet"
        >
          <Edit3 aria-hidden="true" size={14} />
        </Button>
        <Button
          aria-label={`${t.cancel}: ${task.title}`}
          disabled={pendingId !== undefined}
          onClick={() => openCancel(task)}
          size="small"
          variant="quiet"
        >
          <Trash2 aria-hidden="true" size={14} />
        </Button>
      </div>
    ) : null;
  const memberLabel = (userId: string | null) => {
    if (userId === null) return t.unassigned;
    const member = members.find((candidate) => candidate.userId === userId);
    if (member === undefined) return t.formerMember;
    const displayName = member.displayName?.trim();
    return displayName === undefined || displayName === ""
      ? member.email
      : displayName;
  };

  return (
    <div
      className={styles.workspace}
      aria-busy={pendingId !== undefined || undefined}
    >
      <header className={styles.heading}>
        <div>
          <h1>{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        {canEdit ? (
          <Button onClick={openCreate} size="small">
            <Plus aria-hidden="true" size={15} />
            {t.add}
          </Button>
        ) : null}
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <section className={styles.register} aria-label={t.title}>
        <p className={styles.limitNotice}>{t.resultLimit}</p>
        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <label className="or-visually-hidden" htmlFor="task-search">
              {t.search}
            </label>
            <input
              className={styles.search}
              id="task-search"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder={t.search}
              type="search"
              value={query}
            />
            <label className="or-visually-hidden" htmlFor="task-status-filter">
              {t.status}
            </label>
            <select
              className={styles.select}
              id="task-status-filter"
              onChange={(event) => {
                setStatus(event.target.value as "all" | TaskStatus);
                setPage(0);
              }}
              value={status}
            >
              <option value="all">{t.allStatuses}</option>
              <option value="todo">{t.todo}</option>
              <option value="in_progress">{t.inProgress}</option>
              <option value="completed">{t.completed}</option>
              <option value="cancelled">{t.cancelled}</option>
            </select>
            <label
              className="or-visually-hidden"
              htmlFor="task-priority-filter"
            >
              {t.priority}
            </label>
            <select
              className={styles.select}
              id="task-priority-filter"
              onChange={(event) => {
                setPriority(event.target.value as "all" | TaskPriority);
                setPage(0);
              }}
              value={priority}
            >
              <option value="all">{t.allPriorities}</option>
              <option value="low">{t.low}</option>
              <option value="medium">{t.medium}</option>
              <option value="high">{t.high}</option>
              <option value="urgent">{t.urgent}</option>
            </select>
          </div>
          <span className={styles.toolbarStatus}>
            {t.showing} {visible.length} {t.of} {filtered.length}
          </span>
        </div>

        {visible.length ? (
          <>
            <div
              className={styles.tableViewport}
              tabIndex={0}
              role="region"
              aria-label={t.title}
            >
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t.task}</th>
                    <th scope="col">{t.status}</th>
                    <th scope="col">{t.priority}</th>
                    <th scope="col">{t.due}</th>
                    <th scope="col">{t.customer}</th>
                    <th scope="col">{t.assignee}</th>
                    <th scope="col">{t.updated}</th>
                    <th scope="col">
                      <span className="or-visually-hidden">{t.actions}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((task) => (
                    <tr key={task.id}>
                      <th className={styles.taskCell} scope="row">
                        <strong>{task.title}</strong>
                        <small>{task.description ?? "—"}</small>
                      </th>
                      <td>
                        <span className={statusClass(task.status)}>
                          {statusLabel(task.status)}
                        </span>
                      </td>
                      <td>
                        <span className={priorityClass(task.priority)}>
                          {priorityLabel(task.priority)}
                        </span>
                      </td>
                      <td
                        className={isOverdue(task) ? styles.overdue : undefined}
                      >
                        {task.dueAt ? (
                          <time dateTime={task.dueAt}>
                            {formatDate(task.dueAt)}
                          </time>
                        ) : (
                          t.noDue
                        )}
                      </td>
                      <td>
                        {task.contactId ? (
                          <Link
                            className={styles.customerLink}
                            href={`/contacts/${task.contactId}`}
                          >
                            {task.contactName ?? t.openCustomer}
                          </Link>
                        ) : (
                          t.noCustomer
                        )}
                      </td>
                      <td>{memberLabel(task.assigneeUserId)}</td>
                      <td>
                        <time dateTime={task.updatedAt}>
                          {formatDate(task.updatedAt)}
                        </time>
                      </td>
                      <td>{actionButtons(task)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.mobileList}>
              {visible.map((task) => (
                <article className={styles.mobileCard} key={task.id}>
                  <div className={styles.mobileTop}>
                    <h2>{task.title}</h2>
                    {actionButtons(task)}
                  </div>
                  <div className={styles.mobileBadges}>
                    <span className={statusClass(task.status)}>
                      {statusLabel(task.status)}
                    </span>
                    <span className={priorityClass(task.priority)}>
                      {priorityLabel(task.priority)}
                    </span>
                  </div>
                  <p className={styles.taskMeta}>
                    <bdi>{task.description ?? "—"}</bdi>
                  </p>
                  {task.contactId ? (
                    <Link
                      className={styles.customerLink}
                      href={`/contacts/${task.contactId}`}
                    >
                      {task.contactName ?? t.openCustomer}
                    </Link>
                  ) : null}
                  <div className={styles.mobileFooter}>
                    <span
                      className={
                        isOverdue(task) ? styles.overdue : styles.taskMeta
                      }
                    >
                      {task.dueAt ? formatDate(task.dueAt) : t.noDue}
                    </span>
                    <span className={styles.taskMeta}>
                      <bdi>{memberLabel(task.assigneeUserId)}</bdi>
                    </span>
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <div>
              <strong>{tasks.length ? t.noLoadedMatches : t.noTasks}</strong>
              <p>{tasks.length ? t.adjust : t.createFirst}</p>
            </div>
          </div>
        )}

        <footer className={styles.footer}>
          <span>
            {t.showing} {visible.length} {t.of} {filtered.length}
          </span>
          <div className={styles.pagination}>
            <Button
              aria-label={t.previous}
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              size="small"
              variant="quiet"
            >
              <ChevronLeft
                aria-hidden="true"
                className="directional-icon"
                size={15}
              />
              {t.previous}
            </Button>
            <span>
              {t.page} {safePage + 1} / {pageCount}
            </span>
            <Button
              aria-label={t.next}
              disabled={safePage >= pageCount - 1}
              onClick={() =>
                setPage((current) => Math.min(pageCount - 1, current + 1))
              }
              size="small"
              variant="quiet"
            >
              {t.next}
              <ChevronRight
                aria-hidden="true"
                className="directional-icon"
                size={15}
              />
            </Button>
          </div>
        </footer>
      </section>

      <Dialog
        className={styles.dialog ?? ""}
        closeLabel={t.close}
        description={t.formDescription}
        onClose={() => setDialogOpen(false)}
        open={dialogOpen}
        title={editing ? t.editTitle : t.createTitle}
      >
        <form
          className={styles.dialogForm}
          onSubmit={(event) => void saveTask(event)}
        >
          <div className={styles.formGrid}>
            <div className={styles.full}>
              <Input
                autoFocus
                id="task-title"
                label={t.taskTitle}
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
            <Select
              id="task-status"
              label={t.status}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  status: event.target.value as Draft["status"],
                }))
              }
              value={draft.status}
            >
              <option value="todo">{t.todo}</option>
              <option value="in_progress">{t.inProgress}</option>
              <option value="completed">{t.completed}</option>
            </Select>
            <Select
              id="task-priority"
              label={t.priority}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  priority: event.target.value as TaskPriority,
                }))
              }
              value={draft.priority}
            >
              <option value="low">{t.low}</option>
              <option value="medium">{t.medium}</option>
              <option value="high">{t.high}</option>
              <option value="urgent">{t.urgent}</option>
            </Select>
            <Select
              id="task-assignee"
              label={t.assignTo}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  assigneeUserId: event.target.value,
                }))
              }
              value={draft.assigneeUserId}
            >
              <option value="">{t.unassigned}</option>
              {members.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName?.trim() ?? member.email}
                </option>
              ))}
            </Select>
            <div className={styles.full}>
              <Input
                id="task-due"
                label={`${t.dueDate} · ${tenantTimeZone}`}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    dueAt: event.target.value,
                  }))
                }
                type="datetime-local"
                value={draft.dueAt}
              />
            </div>
            <div className={styles.full}>
              <Textarea
                id="task-description"
                label={t.description}
                maxLength={20000}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                rows={4}
                value={draft.description}
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
              disabled={pendingId !== undefined}
              onClick={() => setDialogOpen(false)}
              variant="quiet"
            >
              {t.close}
            </Button>
            <Button busy={pendingId !== undefined} type="submit">
              {editing ? t.save : t.create}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        busy={pendingId === cancelling?.id}
        cancelLabel={t.keep}
        confirmLabel={t.confirm}
        description={t.confirmDescription}
        destructive
        onCancel={() => setCancelling(undefined)}
        onConfirm={() => void confirmCancel()}
        open={cancelling !== undefined}
        title={t.confirmTitle}
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
