"use client";

import { FormEvent, useState } from "react";
import { Plus } from "lucide-react";

import { PermissionAction } from "@/components/permission-action";
import { SectionCard } from "@/components/section-card";
import { apiRequest, type Project } from "@/lib/ui/api-client";
import { can, type Role } from "@/lib/ui/permissions";

/**
 * Owns the project-name input, the "saving" flag, and the create call.
 * The parent adds the returned project to its list via `onCreated`; any
 * failure is surfaced through `onError` so the page's single error banner
 * remains the source of truth.
 */
export function CreateProjectForm({
  role,
  onCreated,
  onError,
}: {
  role: Role;
  onCreated: (project: Project) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const allowed = can(role, "projects:create");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!allowed || !name.trim()) {
      return;
    }

    setSaving(true);

    try {
      const response = await apiRequest<{ project: Project }>("/api/v1/projects", {
        method: "POST",
        body: { name, description: "Created from the integrated project board." },
      });

      onCreated(response.project);
      setName("");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : "Unable to create project.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard>
      <h2 className="text-lg font-semibold text-white">Create project</h2>
      <form onSubmit={submit} className="mt-4 space-y-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={!allowed}
          placeholder="Project name"
          aria-label="Project name"
          className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition-all placeholder:text-slate-600 focus:border-teal-300/60 disabled:cursor-not-allowed disabled:text-slate-600"
        />
        <PermissionAction role={role} permission="projects:create" type="submit">
          <Plus size={16} />
          {saving ? "Saving..." : "Create project"}
        </PermissionAction>
      </form>
    </SectionCard>
  );
}
