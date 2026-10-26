"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  DEFAULT_VIEW_CONFIG,
  isViewType,
  normalizeViewConfig,
  type ViewConfig,
  type ViewType,
} from "@/lib/domain/view-engine";

const changed = "project-os:view-changed";
// Also retains edits when browser storage is unavailable (private/embedded mode).
const memory = new Map<string, string>();
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changed, listener);
  };
}
const serverSnapshot = () => null;

export function useProjectView(projectId: string | null) {
  const key = projectId ? `project-os:view:${projectId}` : null;
  const read = useCallback(() => {
    if (!key) return null;
    if (memory.has(key)) return memory.get(key)!;
    try {
      return window.localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  }, [key]);
  const raw = useSyncExternalStore(subscribe, read, serverSnapshot);
  const view = useMemo(() => {
    try {
      const value = JSON.parse(raw ?? "null") as {
        viewType?: unknown;
        config?: unknown;
      } | null;
      return {
        viewType:
          value && isViewType(value.viewType)
            ? value.viewType
            : ("BOARD" as ViewType),
        config: normalizeViewConfig(value?.config),
      };
    } catch {
      return { viewType: "BOARD" as ViewType, config: DEFAULT_VIEW_CONFIG };
    }
  }, [raw]);
  function write(next: typeof view) {
    if (!key) return;
    const value = JSON.stringify({
      viewType: next.viewType,
      config: next.config,
    });
    try {
      window.localStorage.setItem(key, value);
      memory.delete(key);
    } catch {
      memory.set(key, value);
    }
    window.dispatchEvent(new Event(changed));
  }
  return {
    viewType: view.viewType,
    viewConfig: view.config,
    setViewType: (viewType: ViewType) => write({ ...view, viewType }),
    setViewConfig: (config: ViewConfig) => write({ ...view, config }),
    setView: (viewType: ViewType, config: ViewConfig) =>
      write({ viewType, config }),
  };
}
