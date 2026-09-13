"use client";

import type { NotificationSummary } from "@or-on/crm";
import { Button, IconButton, Popover } from "@or-on/ui";
import { Bell, BellRing, CheckCheck, Volume2, VolumeX, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { crmMutation, crmRead } from "../crm";

const preferenceKey = "or-on.inbox-notifications";

function notificationHref(notification: NotificationSummary): string {
  if (notification.referenceType === "handoff" && notification.referenceId)
    return "/orchestration?tab=handoffs";
  return notification.referenceType === "conversation" &&
    notification.referenceId
    ? `/inbox?conversation=${encodeURIComponent(notification.referenceId)}`
    : "/settings?tab=notifications";
}

function isWhatsAppInbound(notification: NotificationSummary): boolean {
  return notification.type?.startsWith("whatsapp.inbound") === true;
}

export function NotificationCenter({
  pollIntervalMs = 5000,
}: {
  readonly pollIntervalMs?: number;
} = {}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [items, setItems] = useState<readonly NotificationSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [toast, setToast] = useState<NotificationSummary>();
  const known = useRef<Set<string> | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const unlocked = useRef(false);

  const unlockSound = useCallback(async () => {
    if (typeof window === "undefined" || !("AudioContext" in window)) return;
    const context = audio.current ?? new AudioContext();
    audio.current = context;
    try {
      await context.resume();
      unlocked.current = context.state === "running";
    } catch {
      unlocked.current = false;
    }
  }, []);

  const playSound = useCallback(() => {
    const context = audio.current;
    if (!alertsEnabled || !unlocked.current || context?.state !== "running")
      return;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.11, context.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.42);
    gain.connect(context.destination);
    for (const [frequency, delay] of [
      [660, 0],
      [880, 0.13],
    ] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(context.currentTime + delay);
      oscillator.stop(context.currentTime + delay + 0.24);
    }
  }, [alertsEnabled]);

  const announce = useCallback(
    (notification: NotificationSummary) => {
      setToast(notification);
      playSound();
      if (
        alertsEnabled &&
        "Notification" in window &&
        Notification.permission === "granted" &&
        document.visibilityState === "hidden"
      ) {
        const desktop = new Notification(t("inbox.notificationTitle"), {
          body: t("inbox.notificationBody", { count: 1 }),
          tag: `or-on-${notification.id}`,
        });
        desktop.onclick = () => {
          window.focus();
          router.push(notificationHref(notification));
          desktop.close();
        };
      }
    },
    [alertsEnabled, playSound, router, t],
  );

  const refresh = useCallback(async () => {
    const result = await crmRead<{ notifications: NotificationSummary[] }>(
      "/api/notifications",
    );
    const next = Array.isArray(result.notifications)
      ? result.notifications
      : [];
    const nextIds = new Set(next.map(({ id }) => id));
    if (known.current !== null) {
      const newest = next.find(
        (notification) =>
          !notification.read && !known.current?.has(notification.id),
      );
      if (newest) announce(newest);
    }
    known.current = nextIds;
    setItems(next);
  }, [announce]);

  useEffect(() => {
    try {
      setAlertsEnabled(localStorage.getItem(preferenceKey) !== "off");
    } catch {
      // The in-memory default remains usable when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    const unlock = () => void unlockSound();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
      void audio.current?.close();
    };
  }, [unlockSound]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!cancelled) await refresh();
      } catch {
        // A transient refresh failure must not interrupt the application shell.
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), pollIntervalMs);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pollIntervalMs, refresh]);

  async function openNotification(notification: NotificationSummary) {
    if (!notification.read) {
      await crmMutation(
        "/api/notifications",
        { id: notification.id },
        { method: "PATCH" },
      );
      setItems((current) =>
        current.map((item) =>
          item.id === notification.id ? { ...item, read: true } : item,
        ),
      );
    }
    setOpen(false);
    router.push(notificationHref(notification));
  }

  async function markAllRead() {
    await crmMutation("/api/notifications", { all: true }, { method: "PATCH" });
    setItems((current) => current.map((item) => ({ ...item, read: true })));
  }

  async function toggleAlerts() {
    const next = !alertsEnabled;
    setAlertsEnabled(next);
    try {
      localStorage.setItem(preferenceKey, next ? "on" : "off");
    } catch {
      // Preference still applies for this browser session.
    }
    if (!next) return;
    await unlockSound();
    playSound();
    if ("Notification" in window && Notification.permission === "default")
      await Notification.requestPermission();
  }

  const unread = items.filter((notification) => !notification.read).length;
  return (
    <>
      <Popover
        align="end"
        contentClassName="notification-center__panel"
        label={t("shell.notifications")}
        onOpenChange={setOpen}
        open={open}
        triggerClassName="topbar-square-action notification-center__trigger"
        trigger={
          <>
            {unread > 0 ? (
              <BellRing aria-hidden="true" size={17} />
            ) : (
              <Bell aria-hidden="true" size={17} />
            )}
            {unread > 0 ? (
              <span className="notification-center__count">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </>
        }
      >
        {({ close }) => (
          <div className="notification-center">
            <header>
              <div>
                <strong>{t("shell.notifications")}</strong>
                <small>{t("shell.notificationCount", { count: unread })}</small>
              </div>
              <IconButton label={t("common.close")} onClick={close}>
                <X aria-hidden="true" size={16} />
              </IconButton>
            </header>
            <div className="notification-center__tools">
              <Button
                onClick={() => void toggleAlerts()}
                size="small"
                variant="quiet"
              >
                {alertsEnabled ? (
                  <Volume2 aria-hidden="true" size={15} />
                ) : (
                  <VolumeX aria-hidden="true" size={15} />
                )}
                {t(alertsEnabled ? "shell.alertsOn" : "shell.alertsOff")}
              </Button>
              {unread > 0 ? (
                <Button
                  onClick={() => void markAllRead()}
                  size="small"
                  variant="quiet"
                >
                  <CheckCheck aria-hidden="true" size={15} />
                  {t("shell.markAllRead")}
                </Button>
              ) : null}
            </div>
            <div className="notification-center__list">
              {items.length === 0 ? (
                <p>{t("shell.noNotifications")}</p>
              ) : (
                items.map((notification) => (
                  <button
                    data-unread={notification.read ? undefined : "true"}
                    key={notification.id}
                    onClick={() => void openNotification(notification)}
                    type="button"
                  >
                    <span aria-hidden="true">
                      <Bell size={15} />
                    </span>
                    <span>
                      <strong>
                        {isWhatsAppInbound(notification)
                          ? t("inbox.notificationTitle")
                          : notification.title}
                      </strong>
                      <small>
                        {isWhatsAppInbound(notification)
                          ? t("shell.inboxNotification")
                          : notification.body}
                      </small>
                      <time dateTime={notification.createdAt}>
                        {new Intl.DateTimeFormat(locale, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        }).format(new Date(notification.createdAt))}
                      </time>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </Popover>
      {toast ? (
        <div className="notification-toast" role="status" aria-live="polite">
          <BellRing aria-hidden="true" size={18} />
          <button onClick={() => void openNotification(toast)} type="button">
            <strong>{t("inbox.notificationTitle")}</strong>
            <span>{t("shell.inboxNotification")}</span>
          </button>
          <IconButton
            label={t("common.close")}
            onClick={() => setToast(undefined)}
          >
            <X aria-hidden="true" size={15} />
          </IconButton>
        </div>
      ) : null}
    </>
  );
}
