"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell, CheckCheck } from "lucide-react";

import { apiRequest, formatStatus, type AppNotification } from "@/lib/ui/api-client";

type NotificationsResponse = {
  notifications: AppNotification[];
  unreadCount: number;
};

/**
 * Header notification bell. Polls once on mount (no websockets); shows an unread
 * count badge and a dropdown of recent notifications with per-item and bulk
 * mark-read. Every request is caller-scoped server-side, so this only ever shows
 * the signed-in user's notifications.
 */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  async function load() {
    setLoading(true);
    try {
      const response = await apiRequest<NotificationsResponse>("/api/v1/notifications", {
        cache: "no-store",
      });
      setNotifications(response.notifications);
      setUnreadCount(response.unreadCount);
    } catch {
      // Best-effort: a failed poll must never break the shell.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    function onPointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function markRead(id: string) {
    try {
      await apiRequest(`/api/v1/notifications/${id}`, {
        method: "PATCH",
        body: { read: true },
      });
      setNotifications((current) =>
        current.map((item) =>
          item.id === id ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
        ),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch {
      // Ignore; the list will re-sync on next open.
    }
  }

  async function markAllRead() {
    try {
      await apiRequest("/api/v1/notifications/read-all", { method: "POST" });
      const stamp = new Date().toISOString();
      setNotifications((current) =>
        current.map((item) => ({ ...item, readAt: item.readAt ?? stamp })),
      );
      setUnreadCount(0);
    } catch {
      // Ignore.
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={`Notifications${unreadCount ? `, ${unreadCount} unread` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-200 transition-all hover:border-teal-300/50 hover:text-white"
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-teal-300 px-1 text-[11px] font-bold text-slate-950">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-3xl border border-white/10 bg-slate-950/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
        >
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <p className="text-sm font-semibold text-white">Notifications</p>
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={unreadCount === 0}
              className="flex items-center gap-1.5 rounded-xl px-2 py-1 text-xs font-medium text-teal-200 transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:text-slate-600"
            >
              <CheckCheck size={14} />
              Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">Loading…</p>
            ) : notifications.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-slate-500">
                You have no notifications yet.
              </p>
            ) : (
              notifications.map((item) => {
                const unread = !item.readAt;

                return (
                  <div
                    key={item.id}
                    className={`border-b border-white/5 px-4 py-3 transition-colors last:border-b-0 ${
                      unread ? "bg-teal-300/[0.06]" : ""
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        href={item.href}
                        onClick={() => {
                          setOpen(false);
                          if (unread) {
                            void markRead(item.id);
                          }
                        }}
                        className="min-w-0 flex-1"
                      >
                        <p className="flex items-center gap-2 text-sm font-semibold text-white">
                          {unread && (
                            <span className="h-2 w-2 shrink-0 rounded-full bg-teal-300" aria-hidden />
                          )}
                          {item.title}
                        </p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">{item.body}</p>
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-600">
                          {formatStatus(item.type.replace(/\./g, "_"))}
                        </p>
                      </Link>
                      {unread && (
                        <button
                          type="button"
                          onClick={() => void markRead(item.id)}
                          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-teal-200 transition-colors hover:bg-white/[0.06]"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-white/10 px-4 py-3 text-center text-sm font-medium text-teal-200 transition-colors hover:bg-white/[0.06]"
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
