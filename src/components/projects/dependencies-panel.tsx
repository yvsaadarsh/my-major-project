"use client";

import Link from "next/link";
import { GitBranch } from "lucide-react";

import { SectionCard } from "@/components/section-card";
import { formatStatus, type Dependency } from "@/lib/ui/api-client";

export function DependenciesPanel({ dependencies }: { dependencies: Dependency[] }) {
  return (
    <SectionCard>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
        <GitBranch className="text-teal-300" size={18} />
        Dependencies
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Directed source → target edges, including links to other projects. Circular chains are
        rejected on the server.
      </p>

      <div className="mt-5 space-y-3">
        {dependencies.length ? (
          dependencies.map((dependency) => (
            <div
              key={dependency.id}
              className={`rounded-3xl border p-3 text-sm ${
                dependency.crossProject
                  ? "border-violet-300/25 bg-violet-300/[0.05]"
                  : "border-white/10 bg-white/[0.035]"
              }`}
            >
              {/* Inbound edges were invisible before dependencies became
                  tenant-scoped, and they need a different response from
                  the reader than outbound ones — so they are labelled
                  distinctly rather than both being "cross-project". */}
              {dependency.crossProject && (
                <p className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-violet-200">
                  {dependency.direction === "inbound"
                    ? `Blocked by ${dependency.sourceTask.project.name}`
                    : `Blocking ${dependency.targetTask.project.name}`}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/tasks/${dependency.sourceTask.id}`}
                  className="rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-1.5 font-semibold text-white transition-all hover:border-teal-300/40"
                >
                  {dependency.sourceTask.title}
                </Link>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-teal-200">
                  <span aria-hidden>→</span>
                  {formatStatus(dependency.type)}
                </span>
                <Link
                  href={`/tasks/${dependency.targetTask.id}`}
                  className="rounded-2xl border border-white/10 bg-white/[0.05] px-3 py-1.5 font-semibold text-white transition-all hover:border-teal-300/40"
                >
                  {dependency.targetTask.title}
                </Link>
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-slate-500">
            No dependencies yet. Link tasks from a task&apos;s detail view.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
