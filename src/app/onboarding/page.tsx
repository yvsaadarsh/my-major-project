"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  FolderKanban,
  Compass,
  Lock,
  UsersRound,
} from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import {
  apiRequest,
  activeMembership,
  type AuthMe,
  type Project,
} from "@/lib/ui/api-client";
import { can, roleLabel, type Role } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

const steps = [
  { label: "Organization", icon: Compass },
  { label: "Members", icon: UsersRound },
  { label: "First project", icon: FolderKanban },
  { label: "Walkthrough", icon: CheckCircle2 },
];

type DraftMember = {
  email: string;
  role: Role;
};

export default function OnboardingPage() {
  const router = useRouter();
  const { auth, error: authError, loading: authLoading, organization, role } = useAuthSession();
  const [step, setStep] = useState(0);
  const [organizationName, setOrganizationName] = useState("Northstar Labs");
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<Role>("MEMBER");
  const [members, setMembers] = useState<DraftMember[]>([]);
  const [projectName, setProjectName] = useState("Tenant Isolation Audit");
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [localAuth, setLocalAuth] = useState<AuthMe | null>(null);

  const currentAuth = localAuth ?? auth;
  const membership = activeMembership(currentAuth);
  const activeOrganization = membership?.organization ?? organization;
  const activeRole = membership?.role ?? role;
  const progress = useMemo(() => ((step + 1) / steps.length) * 100, [step]);
  const canContinue =
    (step === 0 && Boolean(activeOrganization)) ||
    step === 1 ||
    (step === 2 && Boolean(project)) ||
    step === 3;

  useEffect(() => {
    if (organization) {
      queueMicrotask(() => setStep(1));
    }
  }, [organization]);

  async function refreshAuth() {
    const response = await apiRequest<AuthMe>("/api/v1/auth/me");
    setLocalAuth(response);
    return response;
  }

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (activeOrganization || !organizationName.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest("/api/v1/organizations", {
        method: "POST",
        body: { name: organizationName },
      });
      await refreshAuth();
      setStep(1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create organization.");
    } finally {
      setSaving(false);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!can(activeRole, "members:manage") || !memberEmail.includes("@")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest("/api/v1/members/invite", {
        method: "POST",
        body: { email: memberEmail, role: memberRole },
      });
      setMembers((current) => [...current, { email: memberEmail, role: memberRole }]);
      setMemberEmail("");
      setMemberRole("MEMBER");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to add member. The user must register before being invited.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!can(activeRole, "projects:create") || !projectName.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response = await apiRequest<{ project: Project }>("/api/v1/projects", {
        method: "POST",
        body: {
          description: "First project created during onboarding.",
          name: projectName,
        },
      });
      setProject(response.project);

      await Promise.all([
        apiRequest(`/api/v1/projects/${response.project.id}/tasks`, {
          method: "POST",
          body: {
            assignedToUserId: currentAuth?.user.id ?? null,
            description: "Confirm tenant context is resolved from the session.",
            priority: "HIGH",
            status: "IN_PROGRESS",
            title: "Validate tenant guard on task update",
          },
        }),
        apiRequest(`/api/v1/projects/${response.project.id}/tasks`, {
          method: "POST",
          body: {
            assignedToUserId: currentAuth?.user.id ?? null,
            description: "Review visible permissions for the active role.",
            priority: "MEDIUM",
            status: "TODO",
            title: "Review RBAC command surface",
          },
        }),
      ]);

      setStep(3);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create project.");
    } finally {
      setSaving(false);
    }
  }

  if (authLoading) {
    return <LoadingState />;
  }

  if (authError) {
    return <LoadingState label={authError} />;
  }

  return (
    <AppShell
      eyebrow="Onboarding"
      organizationName={activeOrganization?.name}
      role={activeRole}
      title="Set up the workspace without losing momentum."
      description="A guided path from tenant creation to the first usable project, connected to the real API layer."
    >
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <SectionCard>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Setup progress</p>
              <p className="mt-2 text-2xl font-semibold text-white">{Math.round(progress)}%</p>
            </div>
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-teal-300 text-slate-950">
              <Compass size={20} />
            </div>
          </div>

          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/8">
            <div
              className="h-full rounded-full bg-teal-300 transition-all duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-7 space-y-3">
            {steps.map((item, index) => {
              const Icon = item.icon;
              const active = index === step;
              const complete = index < step;

              return (
                <button
                  key={item.label}
                  onClick={() => setStep(index)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-all duration-200 ${
                    active
                      ? "bg-white text-slate-950"
                      : complete
                        ? "bg-teal-300/10 text-teal-100 hover:bg-teal-300/15"
                        : "bg-white/[0.035] text-slate-400 hover:bg-white/[0.06] hover:text-white"
                  }`}
                >
                  <span
                    className={`grid h-9 w-9 place-items-center rounded-xl ${
                      active ? "bg-slate-950 text-white" : "bg-white/8"
                    }`}
                  >
                    {complete ? <Check size={16} /> : <Icon size={16} />}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold">{item.label}</span>
                    <span className="block text-xs opacity-70">Step {index + 1}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </SectionCard>

        <SectionCard className="min-h-[620px]">
          {error && <InlineError message={error} />}

          <div className="mt-4 flex min-h-[570px] flex-col">
            <div className="flex-1">
              {step === 0 && (
                <form onSubmit={createOrganization}>
                  <p className="text-sm font-semibold text-teal-200">Step 1</p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">Create organization</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                    This becomes the tenant boundary. Every project, task, member, and dashboard query is scoped to this organization.
                  </p>

                  <label className="mt-8 block">
                    <span className="text-sm font-medium text-slate-300">Organization name</span>
                    <input
                      value={activeOrganization?.name ?? organizationName}
                      onChange={(event) => setOrganizationName(event.target.value)}
                      disabled={Boolean(activeOrganization)}
                      className="mt-3 h-14 w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-base text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-500"
                    />
                  </label>

                  <button
                    disabled={saving || Boolean(activeOrganization)}
                    className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-5 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
                  >
                    {activeOrganization ? "Organization created" : saving ? "Creating..." : "Create organization"}
                    <ArrowRight size={16} />
                  </button>
                </form>
              )}

              {step === 1 && (
                <div>
                  <p className="text-sm font-semibold text-teal-200">Step 2</p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">Add members</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                    Add already registered users to this tenant. You can also skip this and invite people later from Members.
                  </p>

                  {!can(activeRole, "members:manage") && (
                    <div className="mt-6">
                      <RoleNotice text="This setup action is locked unless the active role is Admin." />
                    </div>
                  )}

                  <form onSubmit={addMember} className="mt-8 grid gap-3 lg:grid-cols-[1fr_180px_140px]">
                    <input
                      value={memberEmail}
                      onChange={(event) => setMemberEmail(event.target.value)}
                      disabled={!can(activeRole, "members:manage")}
                      className="h-14 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                      placeholder="registered-user@example.com"
                    />
                    <select
                      value={memberRole}
                      onChange={(event) => setMemberRole(event.target.value as Role)}
                      disabled={!can(activeRole, "members:manage")}
                      className="h-14 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                    >
                      <option className="bg-slate-950 text-white" value="ADMIN">Admin</option>
                      <option className="bg-slate-950 text-white" value="MANAGER">Manager</option>
                      <option className="bg-slate-950 text-white" value="MEMBER">Team Member</option>
                    </select>
                    <button
                      disabled={saving || !can(activeRole, "members:manage")}
                      className="inline-flex h-14 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
                    >
                      {!can(activeRole, "members:manage") && <Lock size={15} />}
                      {saving ? "Adding..." : "Add"}
                    </button>
                  </form>

                  <div className="mt-6 space-y-3">
                    {members.length === 0 ? (
                      <p className="text-sm text-slate-500">No extra members added yet.</p>
                    ) : (
                      members.map((member) => (
                        <div
                          key={`${member.email}-${member.role}`}
                          className="flex items-center justify-between gap-4 rounded-3xl border border-white/10 bg-white/[0.035] p-4"
                        >
                          <div>
                            <p className="text-sm font-semibold text-white">{member.email}</p>
                            <p className="mt-1 text-xs text-slate-500">{roleLabel(member.role)}</p>
                          </div>
                          <CheckCircle2 className="text-teal-300" size={18} />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {step === 2 && (
                <form onSubmit={createProject}>
                  <p className="text-sm font-semibold text-teal-200">Step 3</p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">Create first project</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                    This creates the first project and two starter tasks through the protected API.
                  </p>

                  <label className="mt-8 block">
                    <span className="text-sm font-medium text-slate-300">Project name</span>
                    <input
                      value={project?.name ?? projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      disabled={Boolean(project) || !can(activeRole, "projects:create")}
                      className="mt-3 h-14 w-full max-w-xl rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-base text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                    />
                  </label>

                  {!can(activeRole, "projects:create") && (
                    <div className="mt-6">
                      <RoleNotice text="Project creation is available to Admins and Managers." />
                    </div>
                  )}

                  <button
                    disabled={saving || Boolean(project) || !can(activeRole, "projects:create")}
                    className="mt-6 inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-5 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
                  >
                    {project ? "Project created" : saving ? "Creating..." : "Create project"}
                    <ArrowRight size={16} />
                  </button>
                </form>
              )}

              {step === 3 && (
                <div>
                  <p className="text-sm font-semibold text-teal-200">Step 4</p>
                  <h2 className="mt-3 text-3xl font-semibold text-white">Guided walkthrough</h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                    The workspace is ready. These are connected pages backed by your tenant-scoped API.
                  </p>

                  <div className="mt-8 grid gap-4 lg:grid-cols-2">
                    {[
                      "Dashboard loads tenant counts and assigned tasks.",
                      "Project board creates projects and tasks through protected routes.",
                      "Task view updates status and writes comments using the session tenant.",
                      "Members page exposes admin-only membership controls.",
                    ].map((item, index) => (
                      <div
                        key={item}
                        className="rounded-3xl border border-white/10 bg-white/[0.035] p-5 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-300/30"
                      >
                        <span className="grid h-9 w-9 place-items-center rounded-2xl bg-teal-300/10 text-sm font-semibold text-teal-200">
                          {index + 1}
                        </span>
                        <p className="mt-4 text-sm leading-6 text-slate-300">{item}</p>
                      </div>
                    ))}
                  </div>

                  <div className="mt-8 flex flex-wrap gap-3">
                    <Link
                      href="/dashboard"
                      className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-teal-300 px-5 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200"
                    >
                      Open dashboard
                      <ArrowRight size={16} />
                    </Link>
                    <Link
                      href="/projects"
                      className="inline-flex h-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] px-5 text-sm font-semibold text-white transition-all hover:bg-white/[0.1]"
                    >
                      View board
                    </Link>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-8 flex items-center justify-between border-t border-white/10 pt-5">
              <button
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0}
                className="inline-flex h-11 items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:text-slate-600"
              >
                <ArrowLeft size={16} />
                Back
              </button>
              <button
                onClick={() => {
                  if (step === steps.length - 1) {
                    router.push("/dashboard");
                    return;
                  }
                  setStep((current) => Math.min(steps.length - 1, current + 1));
                }}
                disabled={!canContinue}
                className="inline-flex h-11 items-center gap-2 rounded-2xl bg-teal-300 px-4 text-sm font-semibold text-slate-950 transition-all hover:bg-teal-200 disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-slate-600"
              >
                {step === steps.length - 1 ? "Finish" : "Continue"}
                <ArrowRight size={16} />
              </button>
            </div>
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
