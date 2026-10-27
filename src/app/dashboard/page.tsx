"use client";

import Link from "next/link";
import { useApiQuery } from "@/lib/ui/use-api-query";
import { ArrowRight, CheckCircle2, Clock3, ShieldCheck, TrendingUp } from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import {
  formatStatus,
  type Project,
  type Task,
} from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

type Summary = {
  activeProjectCount: number;
  completedTaskCount: number;
  memberCount: number;
  projectCount: number;
  taskCount: number;
};

export default function DashboardPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const scope = organization?.id ?? "";
  const summaryQuery = useApiQuery<{summary: Summary}>(organization ? "/api/v1/dashboard/summary" : null, "Unable to load dashboard.", scope);
  const projectQuery = useApiQuery<{projects: Project[]}>(organization ? "/api/v1/projects" : null, "Unable to load projects.", scope);
  const taskQuery = useApiQuery<{tasks: Task[]}>(organization ? "/api/v1/dashboard/my-tasks" : null, "Unable to load tasks.", scope);
  const summary = summaryQuery.data?.summary;
  const projects = projectQuery.data?.projects ?? [];
  const tasks = taskQuery.data?.tasks ?? [];
  const loading = summaryQuery.loading || projectQuery.loading || taskQuery.loading;
  const error = summaryQuery.error || projectQuery.error || taskQuery.error;

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  return (
    <AppShell
      eyebrow="Tenant dashboard"
      organizationName={organization?.name}
      role={role}
      title="A clear command center for project momentum."
      description="Live data is loaded through tenant-scoped APIs, and available actions follow your active organization role."
    >
      {error && <div className="mb-4"><InlineError message={error} /><button type="button" className="mt-2 text-sm font-semibold text-teal-200" onClick={() => { void summaryQuery.reload(); void projectQuery.reload(); void taskQuery.reload(); }}>Retry dashboard</button></div>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active projects", summary?.activeProjectCount ?? "—", "Tenant scoped"],
          ["Open tasks", summary ? summary.taskCount - summary.completedTaskCount : "—", "In progress"],
          ["Done tasks", summary?.completedTaskCount ?? "—", "Completed"],
          ["Members", summary?.memberCount ?? "—", "Active roster"],
        ].map(([label, value, change]) => (
          <SectionCard key={label.toString()}>
            <p className="text-sm text-slate-400">{label}</p>
            <div className="mt-4 flex items-end justify-between">
              <p className="text-4xl font-semibold text-white">{loading ? "..." : value}</p>
              <span className="rounded-full bg-teal-300/10 px-3 py-1 text-xs font-medium text-teal-200">
                {change}
              </span>
            </div>
          </SectionCard>
        ))}
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Project pulse</h2>
              <p className="mt-1 text-sm text-slate-400">Live workstreams inside this tenant.</p>
            </div>
            {can(role, "projects:create") ? (
              <Link
                href="/projects"
                className="inline-flex h-11 items-center justify-center rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200"
              >
                New project
              </Link>
            ) : (
              <PermissionAction role={role} permission="projects:create">
                New project
              </PermissionAction>
            )}
          </div>

          <div className="mt-6 space-y-4">
            {projects.length === 0 && !loading && !projectQuery.error ? (
              <EmptyState
                title="No projects yet"
                description="Finish onboarding or create a project from the board to populate the dashboard."
                action={<Link className="text-sm font-semibold text-teal-200" href="/projects">Open board</Link>}
              />
            ) : (
              projects.slice(0, 4).map((project) => (
                <Link
                  key={project.id}
                  href={`/projects?projectId=${encodeURIComponent(project.id)}`}
                  className="group block rounded-3xl border border-white/10 bg-white/[0.035] p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-300/30 hover:bg-white/[0.06]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-base font-semibold text-white">{project.name}</p>
                      <p className="mt-1 text-sm text-slate-400">
                        {formatStatus(project.status)} · {project._count?.tasks ?? 0} tasks
                      </p>
                    </div>
                    <ArrowRight
                      className="text-slate-500 transition-transform group-hover:translate-x-1 group-hover:text-teal-200"
                      size={18}
                    />
                  </div>
                </Link>
              ))
            )}
          </div>
        </SectionCard>

        <SectionCard>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-white">Assigned focus</h2>
              <p className="mt-1 text-sm text-slate-400">Your tenant-scoped task queue</p>
            </div>
            <CheckCircle2 className="text-teal-300" size={24} />
          </div>

          <div className="mt-6 space-y-3">
            {tasks.length === 0 && !loading && !taskQuery.error ? (
              <EmptyState
                title="Nothing assigned yet"
                description="Create a task and assign it to yourself to see it here."
              />
            ) : (
              tasks.slice(0, 4).map((task) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="block rounded-3xl border border-white/10 bg-white/[0.035] p-4 transition-all hover:border-teal-300/30 hover:bg-white/[0.06]"
                >
                  <p className="text-sm font-semibold text-white">{task.title}</p>
                  <p className="mt-2 text-xs text-slate-500">
                    {formatStatus(task.status)} · {task.project?.name ?? "Project"}
                  </p>
                </Link>
              ))
            )}
          </div>

          <div className="mt-5 space-y-3">
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <ShieldCheck className="text-teal-300" size={18} />
              Tenant-safe API context active
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <Clock3 className="text-blue-300" size={18} />
              Session cookie is HTTP-only
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-300">
              <TrendingUp className="text-emerald-300" size={18} />
              RBAC is enforced server-side
            </div>
          </div>

          {!can(role, "members:manage") && (
            <div className="mt-5">
              <RoleNotice text="Member management is hidden unless your active role is Admin." />
            </div>
          )}
        </SectionCard>
      </div>
    </AppShell>
  );
}
