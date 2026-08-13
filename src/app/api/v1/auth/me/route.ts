import { handleApiError, json } from "@/lib/api/http";
import { requireAuthenticatedUser } from "@/lib/auth/context";

export async function GET() {
  try {
    const auth = await requireAuthenticatedUser();

    return json({
      activeOrganizationId: auth.activeOrganizationId,
      memberships: auth.memberships,
      user: auth.user,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
