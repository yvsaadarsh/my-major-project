"use client";

import { FormEvent, useEffect, useState } from "react";
import { ShieldCheck, UserPlus } from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { apiRequest, formatStatus, type Member, type Task } from "@/lib/ui/api-client";
import { can, roleDescription, roleLabel, type Role } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

type RosterMember = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  activeTask: (Pick<Task, "id" | "title" | "status" | "priority"> & {
    project?: { name: string };
  }) | null;
};

export default function MembersPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("MEMBER");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [managingMemberId, setManagingMemberId] = useState<string | null>(null);

  async function loadMembers() {
    setError(null);
    setLoading(true);

    try {
      if (role === "MEMBER") {
        const response = await apiRequest<{ roster: RosterMember[] }>("/api/v1/members/roster");
        setRoster(response.roster);
        setMembers([]);
      } else {
        const response = await apiRequest<{ members: Member[] }>("/api/v1/members");
        setMembers(response.members);
        setRoster([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load members.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (organization) {
      queueMicrotask(() => {
        void loadMembers();
      });
    }
  }, [organization]);

  async function inviteMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !can(role, "members:manage")) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await apiRequest("/api/v1/members/invite", {
        method: "POST",
        body: { email, role: inviteRole },
      });
      setEmail("");
      setInviteRole("MEMBER");
      await loadMembers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to invite member.");
    } finally {
      setSaving(false);
    }
  }

  async function updateMemberRole(memberId: string, nextRole: Role) {
    if (!can(role, "members:manage")) {
      return;
    }

    setManagingMemberId(memberId);
    setError(null);

    try {
      await apiRequest(`/api/v1/members/${memberId}/role`, {
        method: "PATCH",
        body: { role: nextRole },
      });
      await loadMembers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to update member role.");
    } finally {
      setManagingMemberId(null);
    }
  }

  async function disableMember(memberId: string) {
    if (!can(role, "members:manage")) {
      return;
    }

    if (!window.confirm("Disable this member in the current organization?")) {
      return;
    }

    setManagingMemberId(memberId);
    setError(null);

    try {
      await apiRequest(`/api/v1/members/${memberId}`, {
        method: "DELETE",
      });
      await loadMembers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to disable member.");
    } finally {
      setManagingMemberId(null);
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
      eyebrow="Members"
      organizationName={organization?.name}
      role={role}
      title="A role-aware roster with visible access boundaries."
      description="Admins can manage membership, Managers can inspect delivery ownership, and Team Members see a simplified team view."
    >
      {error && <InlineError message={error} />}

      {role === "MEMBER" ? (
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Team Roster Overview</h2>
              <p className="mt-1 text-sm text-slate-400">
                Participants in your active organization and their current active task.
              </p>
            </div>
          </div>

          {roster.length === 0 && !loading ? (
            <div className="mt-6">
              <EmptyState
                title="No roster members found"
                description="No active participants are available in this organization yet."
              />
            </div>
          ) : (
            <div className="mt-6 overflow-hidden rounded-3xl border border-white/10">
              <div className="grid grid-cols-[1.1fr_0.7fr_1.2fr] bg-white/[0.04] px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span>Participant</span>
                <span>Role</span>
                <span>Current active task</span>
              </div>
              {roster.map((member) => (
                <div
                  key={member.id}
                  className="grid grid-cols-[1.1fr_0.7fr_1.2fr] items-center border-t border-white/10 px-4 py-4 transition-colors hover:bg-white/[0.035]"
                >
                  <div>
                    <p className="text-sm font-semibold text-white">{member.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{member.email}</p>
                  </div>
                  <span className="w-fit rounded-full bg-teal-300/10 px-3 py-1 text-xs font-semibold text-teal-100">
                    {roleLabel(member.role)}
                  </span>
                  <div>
                    {member.activeTask ? (
                      <>
                        <p className="text-sm font-medium text-white">{member.activeTask.title}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          {formatStatus(member.activeTask.status)} ·{" "}
                          {member.activeTask.project?.name ?? "Project"}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-slate-500">No active task</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      ) : (
        <SectionCard>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white">Workspace members</h2>
              <p className="mt-1 text-sm text-slate-400">
                Membership is always filtered by the active organization.
              </p>
            </div>
          </div>

          <form onSubmit={inviteMember} className="mt-6 grid gap-3 lg:grid-cols-[1fr_180px_170px]">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!can(role, "members:manage")}
              placeholder="Registered user email"
              className="h-12 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
            />
            <select
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as Role)}
              disabled={!can(role, "members:manage")}
              className="h-12 rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
            >
              <option className="bg-slate-950 text-white" value="ADMIN">Admin</option>
              <option className="bg-slate-950 text-white" value="MANAGER">Manager</option>
              <option className="bg-slate-950 text-white" value="MEMBER">Team Member</option>
            </select>
            <PermissionAction role={role} permission="members:manage" type="submit">
              <UserPlus size={16} />
              {saving ? "Saving..." : "Invite member"}
            </PermissionAction>
          </form>

          {!can(role, "members:manage") && (
            <div className="mt-5">
              <RoleNotice text="Only Admins can invite users, change roles, or disable members." />
            </div>
          )}

          {members.length === 0 && !loading ? (
            <div className="mt-6">
              <EmptyState
                title="No members found"
                description="The active tenant has no visible members yet."
              />
            </div>
          ) : (
            <div className="mt-6 overflow-hidden rounded-3xl border border-white/10">
              <div className="grid grid-cols-[1.4fr_0.9fr_1fr_220px] bg-white/[0.04] px-4 py-3 text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                <span>Person</span>
                <span>Role</span>
                <span>Status</span>
                <span className="text-right">Action</span>
              </div>
              {members.map((member) => (
                <div
                  key={member.id}
                  className="grid grid-cols-[1.4fr_0.9fr_1fr_220px] items-center border-t border-white/10 px-4 py-4 transition-colors hover:bg-white/[0.035]"
                >
                  <div>
                    <p className="text-sm font-semibold text-white">{member.user.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{member.user.email}</p>
                  </div>
                  <div>
                    <span className="rounded-full bg-teal-300/10 px-3 py-1 text-xs font-semibold text-teal-100">
                      {roleLabel(member.role)}
                    </span>
                    <p className="mt-2 text-xs text-slate-500">{roleDescription(member.role)}</p>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-300">
                    <ShieldCheck size={15} className="text-teal-300" />
                    {member.status}
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <select
                      value={member.role}
                      disabled={!can(role, "members:manage") || managingMemberId === member.id}
                      onChange={(event) => {
                        const nextRole = event.target.value as Role;
                        if (nextRole !== member.role) {
                          void updateMemberRole(member.id, nextRole);
                        }
                      }}
                      className="h-10 rounded-xl border border-white/10 bg-white/[0.04] px-3 text-xs text-white outline-none transition-all focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
                    >
                      <option className="bg-slate-950 text-white" value="ADMIN">Admin</option>
                      <option className="bg-slate-950 text-white" value="MANAGER">Manager</option>
                      <option className="bg-slate-950 text-white" value="MEMBER">Team Member</option>
                    </select>
                    <button
                      type="button"
                      disabled={!can(role, "members:manage") || managingMemberId === member.id}
                      onClick={() => void disableMember(member.id)}
                      className="rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-200 transition-all hover:bg-rose-400/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/[0.03] disabled:text-slate-600"
                    >
                      Disable
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}
    </AppShell>
  );
}
