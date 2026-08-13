"use client";

import { useEffect, useState } from "react";
import { Bell, CheckCheck, Settings2 } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import {
  apiRequest,
  formatStatus,
  type AppNotification,
  type NotificationPreference,
} from "@/lib/ui/api-client";
import { useAuthSession } from "@/lib/ui/use-auth-session";

type NotificationsResponse = {
  notifications: AppNotification[];
  unreadCount: number;
};

// Mirrors notificationTypeSchema in src/lib/validators.ts (kept local so this
// client page never imports server/validator modules).
const NOTIFICATION_TYPES = [
  "general",
  "task.status_changed",
  "task.overdue",
  "project.health_changed",
] as const;

function typeLabel(type: string) {
  return formatStatus(type.replace(/\./g, "_"));
}

export default function NotificationsPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [preference, setPreference] = useState<NotificationPreference | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadNotifications(nextFilter: "all" | "unread") {
    setError(null);
    setLoading(true);
    try {
      const query = nextFilter === "unread" ? "?unread=1" : "";
      const [list, prefs] = await Promise.all([
        apiRequest<NotificationsResponse>(`/api/v1/notifications${query}`, {
          cache: "no-store",
        }),
        preference
          ? Promise.resolve({ preference })
          : apiRequest<{ preference: NotificationPreference }>(
              "/api/v1/notifications/preferences",
              { cache: "no-store" },
            ),
      ]);
      setNotifications(list.notifications);
      setUnreadCount(list.unreadCount);
      setPreference(prefs.preference);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load notifications.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (organization) {
      void loadNotifications(filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization, filter]);

  async function markRead(id: string, read: boolean) {
    try {
      await apiRequest(`/api/v1/notifications/${id}`, {
        method: "PATCH",
        body: { read },
      });
      await loadNotifications(filter);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update notification.");
    }
  }

  async function markAllRead() {
    try {
      await apiRequest("/api/v1/notifications/read-all", { method: "POST" });
      await loadNotifications(filter);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to mark all read.");
    }
  }

  async function savePreference(next: NotificationPreference) {
    setPreference(next);
    setSavingPrefs(true);
    setError(null);
    try {
      const response = await apiRequest<{ preference: NotificationPreference }>(
        "/api/v1/notifications/preferences",
        {
          method: "PUT",
          body: {
            inAppEnabled: next.inAppEnabled,
            emailEnabled: next.emailEnabled,
            mutedTypes: next.mutedTypes,
          },
        },
      );
      setPreference(response.preference);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save preferences.");
    } finally {
      setSavingPrefs(false);
    }
  }

  function toggleMuted(type: string) {
    if (!preference) {
      return;
    }
    const muted = preference.mutedTypes.includes(type)
      ? preference.mutedTypes.filter((value) => value !== type)
      : [...preference.mutedTypes, type];
    void savePreference({ ...preference, mutedTypes: muted });
  }

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  return (
    <AppShell
      eyebrow="Notifications"
      organizationName={organization?.name}
      role={role}
      title="Stay on top of what changed in your workspace."
      description="Automations and workspace events surface here. Notifications are private to you and always scoped to the active organization."
    >
      {error && (
        <div className="mb-4">
          <InlineError message={error} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
                <Bell size={18} className="text-teal-300" />
                Inbox
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-2xl border border-white/10 bg-white/[0.04] p-1">
                {(["all", "unread"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    className={`rounded-xl px-3 py-1.5 text-xs font-semibold capitalize transition-colors ${
                      filter === value
                        ? "bg-white text-slate-950"
                        : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void markAllRead()}
                disabled={unreadCount === 0}
                className="flex items-center gap-1.5 rounded-2xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-teal-200 transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:text-slate-600"
              >
                <CheckCheck size={14} />
                Mark all read
              </button>
            </div>
          </div>

          {notifications.length === 0 && !loading ? (
            <div className="mt-6">
              <EmptyState
                title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
                description="When automations fire or workspace events occur, they will appear here."
              />
            </div>
          ) : (
            <div className="mt-6 space-y-3">
              {notifications.map((item) => {
                const unread = !item.readAt;

                return (
                  <div
                    key={item.id}
                    className={`rounded-2xl border px-4 py-3 transition-colors ${
                      unread
                        ? "border-teal-300/25 bg-teal-300/[0.06]"
                        : "border-white/10 bg-white/[0.02]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <a href={item.href} className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-semibold text-white">
                          {unread && (
                            <span
                              className="h-2 w-2 shrink-0 rounded-full bg-teal-300"
                              aria-hidden
                            />
                          )}
                          {item.title}
                        </p>
                        <p className="mt-1 text-sm leading-6 text-slate-400">{item.body}</p>
                        <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-600">
                          {typeLabel(item.type)} · {new Date(item.createdAt).toLocaleString()}
                        </p>
                      </a>
                      <button
                        type="button"
                        onClick={() => void markRead(item.id, unread)}
                        className="shrink-0 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:bg-white/[0.08]"
                      >
                        {unread ? "Mark read" : "Mark unread"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>

        <SectionCard>
          <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
            <Settings2 size={18} className="text-teal-300" />
            Preferences
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Control how you receive notifications in this organization.
          </p>

          {!preference ? (
            <p className="mt-6 text-sm text-slate-500">Loading preferences…</p>
          ) : (
            <div className="mt-6 space-y-5">
              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-semibold text-white">In-app notifications</span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Receive notifications in this app. Disabling stops new ones being created.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={preference.inAppEnabled}
                  disabled={savingPrefs}
                  onChange={(event) =>
                    void savePreference({ ...preference, inAppEnabled: event.target.checked })
                  }
                  className="h-5 w-5 accent-teal-300"
                />
              </label>

              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-semibold text-white">
                    Email notifications
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    Preference stored for a future email digest (not sent yet).
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={preference.emailEnabled}
                  disabled={savingPrefs}
                  onChange={(event) =>
                    void savePreference({ ...preference, emailEnabled: event.target.checked })
                  }
                  className="h-5 w-5 accent-teal-300"
                />
              </label>

              <div>
                <p className="text-sm font-semibold text-white">Muted types</p>
                <p className="mt-0.5 text-xs text-slate-500">
                  Muted notification types are never created for you.
                </p>
                <div className="mt-3 space-y-2">
                  {NOTIFICATION_TYPES.map((type) => {
                    const muted = preference.mutedTypes.includes(type);

                    return (
                      <label
                        key={type}
                        className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.02] px-3 py-2"
                      >
                        <span className="text-sm text-slate-200">{typeLabel(type)}</span>
                        <span className="flex items-center gap-2 text-xs text-slate-500">
                          {muted ? "Muted" : "Active"}
                          <input
                            type="checkbox"
                            checked={muted}
                            disabled={savingPrefs}
                            onChange={() => toggleMuted(type)}
                            aria-label={`Mute ${typeLabel(type)} notifications`}
                            className="h-4 w-4 accent-rose-300"
                          />
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </AppShell>
  );
}
