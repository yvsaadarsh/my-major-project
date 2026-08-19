"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  activeMembership,
  apiRequest,
  ClientApiError,
  type AuthMe,
} from "@/lib/ui/api-client";
import { errorMessage } from "@/lib/ui/error-message";

export function useAuthSession(options: { requireOrganization?: boolean } = {}) {
  const router = useRouter();
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    apiRequest<AuthMe>("/api/v1/auth/me", { cache: "no-store" })
      .then((data) => {
        if (!mounted) {
          return;
        }

        setAuth(data);
        const membership = activeMembership(data);

        if (options.requireOrganization && !membership) {
          router.replace("/onboarding");
        }
      })
      .catch((caught: unknown) => {
        if (!mounted) {
          return;
        }

        if (caught instanceof ClientApiError && caught.status === 401) {
          router.replace("/");
          return;
        }

        setError(errorMessage(caught, "Unable to load session."));
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [options.requireOrganization, router]);

  const membership = useMemo(() => activeMembership(auth), [auth]);

  return {
    auth,
    error,
    loading,
    membership,
    organization: membership?.organization ?? null,
    role: membership?.role ?? "MEMBER",
  };
}
