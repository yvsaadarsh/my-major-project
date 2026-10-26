"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "./api-client";
import { errorMessage } from "./error-message";

/** Keyed request state: render loading immediately on a key change, and never
 * let an obsolete response overwrite the current tenant, project or search. */
export function useApiQuery<T>(
  url: string | null,
  fallback: string,
  scope = "",
) {
  const key = JSON.stringify([url, scope]);
  const [result, setResult] = useState<{
    key: string;
    data: T | null;
    error: string | null;
    pending: boolean;
  } | null>(null);
  const request = useRef<AbortController | null>(null);

  const read = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!url) return;
    return apiRequest<T>(url, { cache: "no-store", signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ key, data, error: null, pending: false });
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            key,
            data: null,
            error: errorMessage(caught, fallback),
            pending: false,
          });
        }
      });
  }, [url, key, fallback]);

  useEffect(() => {
    void read();
    return () => request.current?.abort();
  }, [read]);

  const reload = useCallback(async () => {
    setResult((previous) => ({
      key,
      data: previous?.key === key ? previous.data : null,
      error: null,
      pending: true,
    }));
    await read();
  }, [key, read]);

  const current = url && result?.key === key ? result : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: Boolean(url && (!current || current.pending)),
    reload,
  };
}
