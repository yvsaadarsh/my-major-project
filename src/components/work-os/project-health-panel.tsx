"use client";

import { Gauge } from "lucide-react";

import { EmptyState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { formatStatus } from "@/lib/ui/api-client";
import { healthColor, type HealthProject } from "@/lib/ui/work-os-types";

export function ProjectHealthPanel({ projects }: { projects: HealthProject[] }) {
  return (
    <SectionCard>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Project health</h2>
          <p className="mt-1 text-sm text-slate-400">
            Transparent scoring from overdue work, blockers, milestones, and deadlines.
          </p>
        </div>
        <Gauge className="text-teal-300" size={24} />
      </div>

      <div className="mt-6 space-y-4">
        {projects.length ? (
          projects.map((project) => {
            const intel = project.intelligence;

            return (
              <div
                className="rounded-3xl border border-white/10 bg-white/[0.035] p-4"
                key={project.id}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-base font-semibold text-white">{project.name}</p>
                    <p className="mt-1 text-sm text-slate-400">
                      {formatStatus(project.status)} / {project._count.tasks} tasks /{" "}
                      {intel.completion}% complete
                    </p>
                  </div>
                  <span
                    className={`rounded-2xl border px-3 py-2 text-sm font-semibold ${healthColor(intel.band)}`}
                  >
                    {intel.band} {intel.score}
                  </span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
                  <div
                    className="h-full rounded-full bg-teal-300"
                    style={{ width: `${intel.completion}%` }}
                  />
                </div>
                {/*
                  Read straight off the ranked factors. Each carries its own
                  point cost, so the card can show what the score is made of
                  rather than an undifferentiated list of sentences.
                */}
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {intel.factors.length ? (
                    intel.factors.map((factor) => (
                      <p
                        className="rounded-2xl bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-300"
                        key={factor.key}
                      >
                        <span className="font-semibold text-slate-200">
                          {factor.label} −{factor.points}
                        </span>{" "}
                        {factor.detail}
                      </p>
                    ))
                  ) : (
                    <p className="rounded-2xl bg-white/[0.04] px-3 py-2 text-xs leading-5 text-slate-300">
                      No health signals are currently costing points.
                    </p>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <EmptyState
            title="No projects to monitor"
            description="Create a project to start health tracking."
          />
        )}
      </div>
    </SectionCard>
  );
}
