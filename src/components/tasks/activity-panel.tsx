"use client";

import { Activity } from "lucide-react";

import { SectionCard } from "@/components/section-card";
import { humanizeActivity } from "@/lib/ui/activity-text";
import type { ActivityEvent } from "@/lib/ui/api-client";

export function ActivityPanel({ activity }: { activity: ActivityEvent[] }) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-xl font-semibold text-white">
        <Activity className="text-teal-300" size={18} />
        Activity
      </h2>
      <div className="mt-5 space-y-4">
        {activity.length ? (
          activity.map((event) => (
            <div key={event.id} className="flex gap-3">
              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal-300/70" />
              <div>
                <p className="text-sm text-slate-200">{humanizeActivity(event)}</p>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">No activity recorded yet.</p>
        )}
      </div>
    </SectionCard>
  );
}
