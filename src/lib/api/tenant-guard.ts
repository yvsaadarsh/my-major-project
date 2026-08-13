import type { NextRequest } from "next/server";

import { handleApiError } from "@/lib/api/http";
import {
  requireTenantContext,
  type TenantRequestContext,
} from "@/lib/auth/context";
import type { Permission } from "@/lib/rbac";

export type RouteContext<TParams extends Record<string, string> = Record<string, string>> = {
  params: Promise<TParams>;
};

type TenantHandler<TParams extends Record<string, string>> = (
  request: NextRequest,
  tenant: TenantRequestContext,
  context: RouteContext<TParams>,
) => Promise<Response>;

export function withTenantGuard<TParams extends Record<string, string> = Record<string, string>>(
  permission: Permission | undefined,
  handler: TenantHandler<TParams>,
) {
  return async (request: NextRequest, context: RouteContext<TParams>) => {
    try {
      const tenant = await requireTenantContext(permission);

      return await handler(request, tenant, context);
    } catch (error) {
      return handleApiError(error);
    }
  };
}
