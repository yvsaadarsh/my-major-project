"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiRequest, ClientApiError } from "@/lib/ui/api-client";

/** Fields the AI parse route returns. Model output, already validated server-side. */
export type ParsedTask = {
  title: string;
  description: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueDate: string | null;
  notes: string;
};

export type AiProject = { id: string; name: string };

/** Phases of the inline "Create task with AI" flow. */
export type AiPhase = "input" | "loading" | "preview";

export type UseAiComposeOptions = {
  /** Fully close the surrounding palette (dialog + AI state reset lives at the caller). */
  onClose: () => void;
  /** Whether the surrounding palette is open. Governs auto-focus of the compose box. */
  open: boolean;
};

/**
 * Owns every piece of state and every callback the inline "Create task with AI"
 * flow needs. The palette component keeps the render tree; this hook keeps the
 * state machine, so the two can evolve without stepping on each other.
 */
export function useAiCompose({ onClose, open }: UseAiComposeOptions) {
  const router = useRouter();

  const [aiMode, setAiMode] = useState(false);
  const [aiPhase, setAiPhase] = useState<AiPhase>("input");
  const [aiText, setAiText] = useState("");
  const [aiProjects, setAiProjects] = useState<AiProject[]>([]);
  const [aiProjectId, setAiProjectId] = useState("");
  const [aiParsed, setAiParsed] = useState<ParsedTask | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);

  const aiInputRef = useRef<HTMLTextAreaElement>(null);

  const openAiCompose = useCallback(() => {
    setAiError(null);
    setAiParsed(null);
    setAiText("");
    setAiPhase("input");
    setAiMode(true);

    apiRequest<{ projects: AiProject[] }>("/api/v1/projects")
      .then((data) => {
        setAiProjects(data.projects);
        setAiProjectId((current) => current || data.projects[0]?.id || "");
      })
      .catch(() => setAiError("Could not load your projects. Close and try again."));
  }, []);

  /** Reset just the AI state — used when the palette is dismissed. */
  const discardAiCompose = useCallback(() => {
    setAiMode(false);
    setAiPhase("input");
    setAiText("");
    setAiParsed(null);
    setAiError(null);
    setAiBusy(false);
  }, []);

  const submitAiParse = useCallback(async () => {
    const text = aiText.trim();
    if (!text || !aiProjectId) {
      return;
    }

    setAiPhase("loading");
    setAiError(null);

    try {
      const parsed = await apiRequest<ParsedTask>("/api/v1/ai/parse-task", {
        method: "POST",
        body: { text, projectId: aiProjectId },
      });
      setAiParsed(parsed);
      setAiPhase("preview");
    } catch (caught) {
      setAiError(
        caught instanceof ClientApiError
          ? caught.message
          : "Could not parse that. Try rephrasing the task.",
      );
      setAiPhase("input");
    }
  }, [aiProjectId, aiText]);

  const createParsedTask = useCallback(async () => {
    if (!aiParsed || !aiProjectId) {
      return;
    }

    setAiBusy(true);
    setAiError(null);

    try {
      await apiRequest(`/api/v1/projects/${aiProjectId}/tasks`, {
        method: "POST",
        body: {
          title: aiParsed.title,
          description: aiParsed.description || undefined,
          priority: aiParsed.priority,
          status: "TODO",
          // The task endpoint expects a full ISO datetime; the parser returns a
          // bare calendar date. Anchor it to midnight UTC so validation passes.
          dueDate: aiParsed.dueDate
            ? new Date(`${aiParsed.dueDate}T00:00:00.000Z`).toISOString()
            : null,
        },
      });
      onClose();
      router.refresh();
    } catch (caught) {
      setAiBusy(false);
      setAiPhase("preview");
      setAiError(
        caught instanceof ClientApiError ? caught.message : "Could not create the task.",
      );
    }
  }, [aiParsed, aiProjectId, onClose, router]);

  const editParsedTask = useCallback(() => {
    if (!aiParsed) {
      return;
    }

    // Hand the draft to the standard task form. Only the fields that form
    // actually exposes (project + title) are carried; the rest would be dropped.
    const params = new URLSearchParams({ new: "task" });
    if (aiProjectId) {
      params.set("projectId", aiProjectId);
    }
    if (aiParsed.title) {
      params.set("title", aiParsed.title);
    }

    onClose();
    router.push(`/projects?${params.toString()}`);
  }, [aiParsed, aiProjectId, onClose, router]);

  const backToInput = useCallback(() => {
    setAiPhase("input");
    setAiParsed(null);
    setAiError(null);
  }, []);

  // Focus the compose box the moment AI mode takes over the dialog.
  useEffect(() => {
    if (open && aiMode && aiPhase === "input") {
      queueMicrotask(() => aiInputRef.current?.focus());
    }
  }, [open, aiMode, aiPhase]);

  return {
    aiMode,
    aiPhase,
    aiText,
    aiProjects,
    aiProjectId,
    aiParsed,
    aiError,
    aiBusy,
    aiInputRef,
    setAiText,
    setAiProjectId,
    openAiCompose,
    discardAiCompose,
    submitAiParse,
    createParsedTask,
    editParsedTask,
    backToInput,
  } as const;
}
