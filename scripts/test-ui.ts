import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

async function main() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { renderHook, render, fireEvent, act, cleanup } = await import(
    "@testing-library/react"
  );
  const { useApiQuery } = await import("../src/lib/ui/use-api-query");
  const pending: {
    url: string;
    signal: AbortSignal;
    resolve: (r: Response) => void;
  }[] = [];
  globalThis.fetch = ((url: string, options: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({ url, signal: options.signal as AbortSignal, resolve });
    })) as typeof fetch;
  let passed = 0;
  function check(value: unknown, message: string) {
    assert.ok(value, message);
    passed++;
  }
  async function answer(index: number, body: unknown, status = 200) {
    await act(async () =>
      pending[index].resolve(new Response(JSON.stringify(body), { status })),
    );
  }
  const { result, rerender, unmount } = renderHook(
    ({ url, scope }) =>
      useApiQuery<{ name: string }>(url, "Unavailable", scope),
    { initialProps: { url: "/a" as string | null, scope: "tenant-a" } },
  );
  check(result.current.loading, "initial request loads");
  await answer(0, { name: "A" });
  check(
    result.current.data?.name === "A" && !result.current.loading,
    "completed request renders",
  );
  rerender({ url: "/b", scope: "tenant-a" });
  check(
    result.current.loading && result.current.data === null,
    "key change immediately hides old data",
  );
  rerender({ url: "/c", scope: "tenant-a" });
  check(pending[1].signal.aborted, "obsolete request aborted");
  await answer(2, { name: "C" });
  await answer(1, { name: "B" });
  check(
    result.current.data?.name === "C",
    "late obsolete response cannot replace current result",
  );
  rerender({ url: "/c", scope: "tenant-b" });
  check(
    result.current.data === null && result.current.loading,
    "tenant change invalidates identical URL",
  );
  await answer(3, { error: { message: "Forbidden", code: "forbidden" } }, 403);
  check(
    result.current.error === "Forbidden" && !result.current.loading,
    "failure displayed",
  );
  let reload: Promise<void>;
  act(() => {
    reload = result.current.reload();
  });
  check(
    result.current.loading && result.current.error === null,
    "retry clears error and loads",
  );
  await answer(4, { name: "Recovered" });
  await reload!;
  check(
    result.current.data?.name === "Recovered",
    "retry resolves with new data",
  );
  rerender({ url: null, scope: "tenant-b" });
  check(
    !result.current.loading && result.current.data === null,
    "disabled query hides stale data",
  );
  rerender({ url: "/d", scope: "tenant-b" });
  unmount();
  check(pending[5].signal.aborted, "unmount cancels outstanding request");
  await answer(5, { name: "late" });
  cleanup();
  const { useProjectView } = await import("../src/lib/ui/use-project-view");
  const view = renderHook(({ id }) => useProjectView(id), {
    initialProps: { id: "alpha" },
  });
  check(view.result.current.viewType === "BOARD", "default project view");
  act(() => view.result.current.setViewType("TABLE"));
  check(
    view.result.current.viewType === "TABLE",
    "view change updates immediately",
  );
  view.rerender({ id: "beta" });
  check(
    view.result.current.viewType === "BOARD",
    "project switch uses independent preferences",
  );
  view.rerender({ id: "alpha" });
  check(
    view.result.current.viewType === "TABLE",
    "project preferences restored",
  );
  act(() => {
    window.localStorage.setItem("project-os:view:alpha", "broken");
    window.dispatchEvent(new Event("storage"));
  });
  check(
    view.result.current.viewType === "BOARD",
    "corrupt storage recovers to defaults",
  );
  act(() =>
    view.result.current.setView("LIST", {
      ...view.result.current.viewConfig,
      groupBy: "priority",
    }),
  );
  check(
    view.result.current.viewType === "LIST" &&
      view.result.current.viewConfig.groupBy === "priority",
    "saved view type and config updated atomically",
  );
  const storagePrototype = Object.getPrototypeOf(window.localStorage);
  const originalSetItem = storagePrototype.setItem;
  storagePrototype.setItem = () => {
    throw new Error("Quota exceeded");
  };
  try {
    act(() => view.result.current.setViewType("TIMELINE"));
    check(
      view.result.current.viewType === "TIMELINE",
      "storage write failure preserves current session edits",
    );
  } finally {
    storagePrototype.setItem = originalSetItem;
  }
  cleanup();
  const React = await import("react");
  const { CreateTaskForm } = await import(
    "../src/components/projects/create-task-form"
  );
  const props = {
    role: "ADMIN" as const,
    project: {
      id: "p",
      name: "Project",
      description: null,
      startDate: null,
      endDate: null,
      status: "ACTIVE" as const,
      createdAt: "",
      updatedAt: "",
    },
    members: [],
    onCreated: () => {},
    onError: () => {},
  };
  const form = render(
    React.createElement(CreateTaskForm, { ...props, initialTitle: "" }),
  );
  form.rerender(
    React.createElement(CreateTaskForm, { ...props, initialTitle: "AI draft" }),
  );
  const input = form.getByRole("textbox", {
    name: "Task title",
  }) as HTMLInputElement;
  check(input.value === "AI draft", "late AI draft prefills title");
  fireEvent.change(input, { target: { value: "User edit" } });
  form.rerender(
    React.createElement(CreateTaskForm, { ...props, initialTitle: "" }),
  );
  check(input.value === "User edit", "cleared draft does not erase edits");
  form.rerender(
    React.createElement(CreateTaskForm, {
      ...props,
      initialTitle: "New draft",
    }),
  );
  check(input.value === "New draft", "fresh draft replaces old handoff");
  cleanup();
  Object.assign(globalThis, {sessionStorage: dom.window.sessionStorage});
  const {saveTaskDraft, readTaskDraft} = await import("../src/lib/ui/task-draft");
  const draft = {title: "Review", description: "Keep details", priority: "HIGH" as const, dueDate: "2026-11-06", notes: ""};
  const draftId = saveTaskDraft("p", draft);
  check(readTaskDraft(draftId, "p")?.description === draft.description, "draft handoff preserves description");
  check(readTaskDraft(draftId, "other") === null, "draft cannot cross projects");
  dom.window.sessionStorage.setItem(`projectos:task-draft:${draftId}`, "invalid json");
  check(readTaskDraft(draftId, "p") === null, "malformed draft rejected");
  const {SimulationResultPanel} = await import("../src/components/simulation/SimulationDiff");
  const simulation = {
    status: "simulated" as const, interpretedIntent: "Review task", narration: "Deterministic summary.",
    aiProvenance: {interpretation: "fallback" as const, narration: "fallback" as const},
    change: {type: "task_status" as const, taskId: "t", status: "DONE" as const},
    changeDescription: {action: "Update task", fields: []}, snapshotToken: "token",
    diff: {baseline: {score: 80, band: "Healthy" as const}, modified: {score: 80, band: "Healthy" as const}, healthDelta: 0, severity: "none" as const, verdict: "safe" as const, bandChanged: false, affectedTaskCount: 1, signalChanges: []},
  };
  const panel = render(React.createElement(SimulationResultPanel, {result: simulation, role: "ADMIN", applying: false, applyError: null, staleError: null, onApply() {}, onDiscard() {}}));
  check(panel.queryByText("AI narration", {exact: true}) === null, "fallback never labeled AI narration");
  check(Boolean(panel.getByText("Deterministic summary — AI narration unavailable")), "fallback visibly explained");
  cleanup();
  console.log(`${passed} UI regression checks passed`);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
