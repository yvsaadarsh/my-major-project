"use client";

import { useEffect, useState } from "react";

/**
 * Lifecycle of the trajectory forecast.
 *
 * `insufficient` is distinct from `hidden`: the project is real but too young or
 * too small to forecast, which the user should be told plainly rather than left
 * wondering why the section is empty. `hidden` still covers every failure and
 * the not-configured (501) case, so a missing key degrades to nothing at all.
 */
export type ForecastState = "loading" | "streaming" | "done" | "insufficient" | "hidden";

/**
 * Stream the trajectory forecast for one project.
 *
 * Fully independent of any other request the page runs — the deterministic
 * analysis and the AI brief both stream in parallel, and none of the three can
 * block or fail another. `refreshToken` is a bump counter: change it (from a
 * Refresh button, for example) to re-open the stream.
 *
 * Response shape: a `text/plain` token stream on success; a small JSON body
 * (`{ insufficient: true }`) when the project has too little history to
 * project from; any other non-OK status (including 501 "AI not configured")
 * collapses to `hidden`.
 */
export function useForecastStream(projectId: string | undefined, refreshToken = 0) {
  const [forecast, setForecast] = useState("");
  const [state, setState] = useState<ForecastState>("loading");

  useEffect(() => {
    if (!projectId) {
      return;
    }

    const controller = new AbortController();

    void (async () => {
      // Inside the async body rather than the effect body: a synchronous
      // setState in an effect trips react-hooks/set-state-in-effect.
      setForecast("");
      setState("loading");

      try {
        const response = await fetch(
          `/api/v1/intelligence/projects/${projectId}/forecast`,
          { cache: "no-store", credentials: "include", signal: controller.signal },
        );

        // 501 (no key) and every other failure collapse to the same outcome: the
        // section is not rendered.
        if (!response.ok || !response.body) {
          setState("hidden");
          return;
        }

        // A JSON body is the "not enough history" signal, never a stream.
        if ((response.headers.get("content-type") ?? "").includes("application/json")) {
          const payload = (await response.json().catch(() => null)) as
            | { insufficient?: boolean }
            | null;
          setState(payload?.insufficient ? "insufficient" : "hidden");
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";

        setState("streaming");

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          // `stream: true` so a multi-byte character split across two chunks is
          // not decoded into a replacement character.
          accumulated += decoder.decode(value, { stream: true });
          setForecast(accumulated);
        }

        accumulated += decoder.decode();
        setForecast(accumulated);
        setState(accumulated.trim().length > 0 ? "done" : "hidden");
      } catch {
        // Includes the abort below, where the component no longer exists and the
        // state setter is a no-op.
        setState("hidden");
      }
    })();

    return () => controller.abort();
  }, [projectId, refreshToken]);

  return { forecast, state };
}
