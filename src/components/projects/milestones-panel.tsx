"use client";

import { Flag, Sparkles } from "lucide-react";

import { SectionCard } from "@/components/section-card";
import { CLOSED_MILESTONE_STATUSES } from "@/components/projects/retrospective-modal";
import { formatStatus, type Milestone } from "@/lib/ui/api-client";

export function MilestonesPanel({
  milestones,
  onOpenRetro,
}: {
  milestones: Milestone[];
  onOpenRetro: (milestone: Milestone) => void;
}) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Flag className="text-teal-300" size={18} />
        Milestones
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Progress is computed live from real task completion.
      </p>

      <div className="mt-5 space-y-4">
        {milestones.length ? (
          milestones.map((milestone) => (
            <div
              key={milestone.id}
              className="rounded-3xl border border-white/10 bg-white/[0.035] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-white">{milestone.name}</p>
                <span className="rounded-full bg-white/8 px-2 py-1 text-[11px] text-slate-300">
                  {formatStatus(milestone.status)}
                </span>
              </div>
              <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-teal-300 transition-all"
                  style={{ width: `${milestone.completion}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {milestone.taskCompleted}/{milestone.taskTotal} tasks done ·{" "}
                {milestone.completion}%
              </p>

              {/*
                Only closed milestones can be looked back on. The route
                enforces this too — it 400s on an open milestone — so
                hiding the button is a UX nicety, not the boundary.
              */}
              {CLOSED_MILESTONE_STATUSES.has(milestone.status) && (
                <button
                  type="button"
                  onClick={() => onOpenRetro(milestone)}
                  className="mt-3 inline-flex items-center gap-2 rounded-2xl border border-violet-300/30 bg-violet-300/[0.1] px-3 py-2 text-xs font-semibold text-violet-100 transition-all hover:bg-violet-300/20"
                >
                  <Sparkles size={14} />
                  View Retrospective
                </button>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">No milestones for this project yet.</p>
        )}
      </div>
    </SectionCard>
  );
}
