// TEST DOUBLE — controllable tenant context. Real ApiError semantics preserved.
import { ApiError } from "@/lib/api/http";
import { assertPermission, type Permission } from "@/lib/rbac";
export const __session: { tenantId: string | null; role: any } = { tenantId: "org_a", role: "ADMIN" };
export async function requireTenantContext(permission?: Permission): Promise<any> {
  if (!__session.tenantId) throw new ApiError(401, "unauthorized", "Authentication is required.");
  if (permission) assertPermission(__session.role, permission);
  const organization = { id: __session.tenantId, name: "Test Org", slug: "test", createdAt: new Date(), updatedAt: new Date() };
  return { membership: { id: "m1", organizationId: __session.tenantId, role: __session.role, status: "ACTIVE", createdAt: new Date(), updatedAt: new Date(), organization },
    organization, role: __session.role, tenantId: __session.tenantId,
    user: { id: "u1", name: "Tester", email: "t@example.com", createdAt: new Date(), updatedAt: new Date() } };
}
export async function requireAuthenticatedUser(): Promise<any> { throw new ApiError(401, "unauthorized", "n/a"); }
