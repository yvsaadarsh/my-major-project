import { prisma } from "@/lib/db";

export function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");

  return slug || "organization";
}

export async function uniqueOrganizationSlug(name: string) {
  const baseSlug = slugify(name);
  let candidate = baseSlug;
  let suffix = 2;

  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}
