"use client";

import { ComponentType, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";

import { AppShell, RoleNotice } from "@/components/app-shell";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { CreateProjectForm } from "@/components/projects/create-project-form";
import { CreateTaskForm } from "@/components/projects/create-task-form";
import { DependenciesPanel } from "@/components/projects/dependencies-panel";
import { MilestonesPanel } from "@/components/projects/milestones-panel";
import { RetrospectiveModal } from "@/components/projects/retrospective-modal";
import { BoardView } from "@/components/views/board-view";
import { ListView } from "@/components/views/list-view";
import { TableView } from "@/components/views/table-view";
import { TimelineView } from "@/components/views/timeline-view";
import type { ViewProps } from "@/components/views/shared";
import { ViewToolbar } from "@/components/views/view-toolbar";
import {
  applyView,
  DEFAULT_VIEW_CONFIG,
  filterTasks,
  isViewType,
  normalizeViewConfig,
  sortTasks,
  type ViewConfig,
  type ViewType,
} from "@/lib/domain/view-engine";
import {
  apiRequest,
  type Dependency,
  type Member,
  type Milestone,
  type Project,
  type SavedView,
  type Task,
} from "@/lib/ui/api-client";
import { can } from "@/lib/ui/permissions";
import { useAuthSession } from "@/lib/ui/use-auth-session";

const viewComponents: Record<ViewType, ComponentType<ViewProps>> = {
  BOARD: BoardView,
  LIST: ListView,
  TABLE: TableView,
  TIMELINE: TimelineView,
};

function viewStorageKey(projectId: string) {
  return `project-os:view:${projectId}`;
}

function formatDate(value?: string | null) {
  if (!value) {
    return "Not set";
  }
  return new Date(value).toLocaleDateString();
}

export default function ProjectsPage() {
  const { auth, error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [viewType, setViewType] = useState<ViewType>("BOARD");
  const [viewConfig, setViewConfig] = useState<ViewConfig>(DEFAULT_VIEW_CONFIG);
  const [hydratedProjectId, setHydratedProjectId] = useState<string | null>(null);
  // A title handed over from the "Create task with AI → Edit first" flow,
  // pushed into CreateTaskForm as its initial value.
  const [draftTaskTitle, setDraftTaskTitle] = useState("");
  // A project id handed over from the same flow, applied once its project has loaded.
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);
  // The closed milestone whose AI retrospective is open, if any.
  const [retroMilestone, setRetroMilestone] = useState<Milestone | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  );

  const selectedView = useMemo(
    () => savedViews.find((view) => view.id === selectedViewId) ?? null,
    [savedViews, selectedViewId],
  );

  const canManageSelectedView = useMemo(() => {
    if (!selectedView) {
      return false;
    }

    return (
      selectedView.ownerUserId === auth?.user.id ||
      (selectedView.isShared && can(role, "projects:update"))
    );
  }, [auth?.user.id, role, selectedView]);

  const viewTasks = useMemo(
    () =>
      sortTasks(
        filterTasks(tasks, viewConfig.filter),
        viewConfig.sortField,
        viewConfig.sortDirection,
      ),
    [tasks, viewConfig],
  );

  // The domain layer groups by raw id (it has no name data); the presentation
  // layer resolves those ids into human labels.
  const viewGroups = useMemo(() => {
    const groups = applyView(tasks, viewConfig);

    if (viewConfig.groupBy === "milestone") {
      return groups.map((group) => ({
        ...group,
        label: milestones.find((milestone) => milestone.id === group.key)?.name ?? group.label,
      }));
    }

    if (viewConfig.groupBy === "assignee") {
      return groups.map((group) => ({
        ...group,
        label:
          members.find((member) => member.user.id === group.key)?.user.name ?? group.label,
      }));
    }

    return groups;
  }, [members, milestones, tasks, viewConfig]);

  const ActiveView = viewComponents[viewType];

  async function loadWorkspace() {
    setError(null);
    setLoading(true);

    try {
      const [projectsResponse, membersResponse] = await Promise.all([
        apiRequest<{ projects: Project[] }>("/api/v1/projects"),
        apiRequest<{ members: Member[] }>("/api/v1/members"),
      ]);

      setProjects(projectsResponse.projects);
      setMembers(membersResponse.members.filter((member) => member.status === "ACTIVE"));
      const project =
        projectsResponse.projects.find((item) => item.id === selectedProjectId) ??
        projectsResponse.projects[0] ??
        null;
      setSelectedProjectId(project?.id ?? null);

      if (project?.id) {
        const tasksResponse = await apiRequest<{ tasks: Task[] }>(
          `/api/v1/projects/${project.id}/tasks`,
        );
        setTasks(tasksResponse.tasks);
      } else {
        setTasks([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load project board.");
    } finally {
      setLoading(false);
    }
  }

  const loadSavedViews = useCallback(async (projectId: string) => {
    const response = await apiRequest<{ views: SavedView[] }>(
      `/api/v1/views?projectId=${encodeURIComponent(projectId)}`,
    );

    setSavedViews(response.views);

    return response.views;
  }, []);

  useEffect(() => {
    if (organization) {
      queueMicrotask(() => {
        void loadWorkspace();
      });
    }
  }, [organization]);

  // One-time hand-off from the command center's "Create task with AI → Edit
  // first". Reads the draft off the URL (client-only, so no Suspense boundary is
  // needed) and pre-fills the standard create-task form.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "task") {
      return;
    }

    const title = params.get("title");
    const projectId = params.get("projectId");

    queueMicrotask(() => {
      if (title) {
        setDraftTaskTitle(title);
      }
      if (projectId) {
        setPendingProjectId(projectId);
      }
    });
  }, []);

  // Apply the handed-over project once it appears in the loaded list; loadWorkspace
  // otherwise defaults selection to the newest project.
  useEffect(() => {
    if (!pendingProjectId) {
      return;
    }
    if (projects.some((project) => project.id === pendingProjectId)) {
      queueMicrotask(() => {
        setSelectedProjectId(pendingProjectId);
        setPendingProjectId(null);
      });
    }
  }, [pendingProjectId, projects]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDependencies([]);
      setMilestones([]);
      return;
    }

    let mounted = true;

    Promise.all([
      apiRequest<{ tasks: Task[] }>(`/api/v1/projects/${selectedProjectId}/tasks`),
      apiRequest<{ dependencies: Dependency[] }>(
        `/api/v1/projects/${selectedProjectId}/dependencies`,
      ),
      apiRequest<{ milestones: Milestone[] }>(
        `/api/v1/projects/${selectedProjectId}/milestones`,
      ),
    ])
      .then(([tasksResponse, dependenciesResponse, milestonesResponse]) => {
        if (mounted) {
          setTasks(tasksResponse.tasks);
          setDependencies(dependenciesResponse.dependencies);
          setMilestones(milestonesResponse.milestones);
        }
      })
      .catch((caught) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : "Unable to load tasks.");
        }
      });

    return () => {
      mounted = false;
    };
  }, [selectedProjectId]);

  // Saved views visible to this user for the selected project (plus org-level ones).
  useEffect(() => {
    if (!selectedProjectId) {
      setSavedViews([]);
      return;
    }

    let mounted = true;

    loadSavedViews(selectedProjectId).catch((caught) => {
      if (mounted) {
        setError(caught instanceof Error ? caught.message : "Unable to load saved views.");
      }
    });

    return () => {
      mounted = false;
    };
  }, [loadSavedViews, selectedProjectId]);

  // Restore the last-used view type/config for this project from localStorage.
  useEffect(() => {
    if (!selectedProjectId) {
      setHydratedProjectId(null);
      return;
    }

    let nextViewType: ViewType = "BOARD";
    let nextConfig: ViewConfig = DEFAULT_VIEW_CONFIG;

    try {
      const raw = window.localStorage.getItem(viewStorageKey(selectedProjectId));

      if (raw) {
        const stored = JSON.parse(raw) as { viewType?: unknown; config?: unknown };

        if (isViewType(stored.viewType)) {
          nextViewType = stored.viewType;
        }
        nextConfig = normalizeViewConfig(stored.config);
      }
    } catch {
      // Corrupt or unavailable storage simply falls back to the defaults.
    }

    setViewType(nextViewType);
    setViewConfig(nextConfig);
    setSelectedViewId(null);
    setHydratedProjectId(selectedProjectId);
  }, [selectedProjectId]);

  // Persist it again on every change, once this project has been hydrated.
  useEffect(() => {
    if (!selectedProjectId || hydratedProjectId !== selectedProjectId) {
      return;
    }

    try {
      window.localStorage.setItem(
        viewStorageKey(selectedProjectId),
        JSON.stringify({ config: viewConfig, viewType }),
      );
    } catch {
      // Storage may be disabled; the view still works for this session.
    }
  }, [hydratedProjectId, selectedProjectId, viewConfig, viewType]);

  function handleSelectView(viewId: string) {
    if (!viewId) {
      setSelectedViewId(null);
      return;
    }

    const view = savedViews.find((entry) => entry.id === viewId);

    if (!view) {
      return;
    }

    setSelectedViewId(view.id);
    setViewType(view.viewType);
    setViewConfig(normalizeViewConfig(view.config));
  }

  function handleResetConfig() {
    setSelectedViewId(null);
    setViewConfig(DEFAULT_VIEW_CONFIG);
  }

  async function handleCreateView(name: string) {
    if (!selectedProject || !name) {
      return;
    }

    setError(null);

    try {
      const response = await apiRequest<{ view: SavedView }>("/api/v1/views", {
        method: "POST",
        body: {
          config: viewConfig,
          isShared: false,
          name,
          projectId: selectedProject.id,
          viewType,
        },
      });

      setSavedViews((current) =>
        [...current, response.view].sort((left, right) => left.name.localeCompare(right.name)),
      );
      setSelectedViewId(response.view.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save this view.");
    }
  }

  async function patchSelectedView(body: Record<string, unknown>, failure: string) {
    if (!selectedView) {
      return;
    }

    setError(null);

    try {
      const response = await apiRequest<{ view: SavedView }>(
        `/api/v1/views/${selectedView.id}`,
        { method: "PATCH", body },
      );

      setSavedViews((current) =>
        current.map((view) => (view.id === response.view.id ? response.view : view)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : failure);
    }
  }

  async function handleUpdateView() {
    await patchSelectedView(
      { config: viewConfig, viewType },
      "Unable to update this saved view.",
    );
  }

  async function handleToggleShared() {
    if (!selectedView) {
      return;
    }

    await patchSelectedView(
      { isShared: !selectedView.isShared },
      "Unable to change sharing for this view.",
    );
  }

  async function handleDeleteView() {
    if (!selectedView) {
      return;
    }

    setError(null);

    try {
      await apiRequest(`/api/v1/views/${selectedView.id}`, { method: "DELETE" });
      setSavedViews((current) => current.filter((view) => view.id !== selectedView.id));
      setSelectedViewId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete this view.");
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
      eyebrow="Project board"
      organizationName={organization?.name}
      role={role}
      title="Work moves through a focused tenant board."
      description="Projects and tasks are loaded from the tenant-scoped backend, with restricted actions locked by role."
    >
      {error && <InlineError message={error} />}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 rounded-2xl border border-teal-300/20 bg-teal-300/10 px-4 py-3 text-sm font-medium text-teal-100">
          <ShieldCheck size={17} />
          Queries use session tenant context
        </div>
        <button
          onClick={() => void loadWorkspace()}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 text-sm font-semibold text-white transition-all hover:bg-white/[0.1]"
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <CreateProjectForm
            role={role}
            onCreated={(project) => {
              setProjects((current) => [project, ...current]);
              setSelectedProjectId(project.id);
            }}
            onError={setError}
          />

          <CreateTaskForm
            role={role}
            project={selectedProject}
            members={members}
            initialTitle={draftTaskTitle}
            onCreated={(task) => setTasks((current) => [task, ...current])}
            onError={setError}
          />

          {!can(role, "tasks:create") && (
            <RoleNotice text="Team Members can update assigned task status, but cannot create or assign tasks." />
          )}
        </div>

        <SectionCard>
          {selectedProject && (
            <div className="mb-5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Timeline / Deadline
              </p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-slate-500">Start date</p>
                  <p className="text-sm font-semibold text-white">
                    {formatDate(selectedProject.startDate)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-slate-500">End date</p>
                  <p className="text-sm font-semibold text-white">
                    {formatDate(selectedProject.endDate)}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => setSelectedProjectId(project.id)}
                aria-pressed={selectedProject?.id === project.id}
                className={`rounded-2xl px-4 py-2 text-sm font-semibold transition-all ${
                  selectedProject?.id === project.id
                    ? "bg-teal-300 text-slate-950"
                    : "bg-white/[0.05] text-slate-300 hover:bg-white/[0.09]"
                }`}
              >
                {project.name}
              </button>
            ))}
          </div>

          {projects.length === 0 && !loading && (
            <div className="mt-6">
              <EmptyState
                title="No project board yet"
                description="Create your first project to unlock task lanes."
              />
            </div>
          )}
        </SectionCard>
      </div>

      {selectedProject && (
        <SectionCard className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-white">Views</h2>
              <p className="mt-1 text-xs text-slate-500">
                Filter, sort, group and save the way you look at this project&apos;s work. Saved
                views are personal until a manager shares them with the organization.
              </p>
            </div>
            <span className="rounded-full bg-white/8 px-3 py-1 text-xs text-slate-400">
              {viewTasks.length} of {tasks.length} tasks
            </span>
          </div>

          <div className="mt-5 space-y-5">
            <ViewToolbar
              canManageSelected={canManageSelectedView}
              config={viewConfig}
              members={members}
              milestones={milestones}
              onConfigChange={setViewConfig}
              onCreateView={(name) => void handleCreateView(name)}
              onDeleteView={() => void handleDeleteView()}
              onResetConfig={handleResetConfig}
              onSelectView={handleSelectView}
              onToggleShared={() => void handleToggleShared()}
              onUpdateView={() => void handleUpdateView()}
              onViewTypeChange={setViewType}
              role={role}
              savedViews={savedViews}
              selectedView={selectedView}
              viewType={viewType}
            />

            <ActiveView
              config={viewConfig}
              groups={viewGroups}
              members={members}
              milestones={milestones}
              onConfigChange={setViewConfig}
              tasks={viewTasks}
            />
          </div>
        </SectionCard>
      )}

      {selectedProject && (
        <div className="mt-6 grid gap-4 xl:grid-cols-2">
          <DependenciesPanel dependencies={dependencies} />
          <MilestonesPanel milestones={milestones} onOpenRetro={setRetroMilestone} />
        </div>
      )}

      {retroMilestone && selectedProject && (
        <RetrospectiveModal
          milestone={retroMilestone}
          projectId={selectedProject.id}
          onClose={() => setRetroMilestone(null)}
        />
      )}
    </AppShell>
  );
}
