"use client";

import { can, type Permission, type Role } from "@/lib/ui/permissions";

type PermissionActionProps = {
  children: React.ReactNode;
  permission: Permission;
  role: Role;
  lockedLabel?: string;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  type?: "button" | "submit" | "reset";
};

export function PermissionAction({
  children,
  permission,
  role,
  lockedLabel = "Restricted for this role",
  variant = "primary",
  onClick,
  type = "button",
}: PermissionActionProps) {
  const allowed = can(role, permission);
  const base =
    "inline-flex h-11 items-center justify-center gap-2 rounded-2xl px-4 text-sm font-semibold transition-all duration-200";
  const variants = {
    danger: allowed
      ? "bg-rose-400 text-slate-950 hover:bg-rose-300 hover:shadow-lg hover:shadow-rose-950/30"
      : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-slate-500",
    primary: allowed
      ? "bg-teal-300 text-slate-950 hover:bg-teal-200 hover:shadow-lg hover:shadow-teal-950/30"
      : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-slate-500",
    secondary: allowed
      ? "border border-white/10 bg-white/[0.06] text-white hover:bg-white/[0.1]"
      : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-slate-500",
  };

  if (!allowed) {
    return null;
  }

  return (
    <button type={type} onClick={onClick} className={`${base} ${variants[variant]}`}>
      {children}
    </button>
  );
}
