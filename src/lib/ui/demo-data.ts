import type { Role } from "@/lib/ui/permissions";

export const workspace = {
  name: "Northstar Labs",
  slug: "northstar-labs",
  tenantId: "org_tenant_northstar",
  plan: "Academic Free Tier",
};

export const metrics = [
  { label: "Active projects", value: "6", change: "+2 this week" },
  { label: "Open tasks", value: "38", change: "12 assigned to you" },
  { label: "Done this sprint", value: "19", change: "82% on schedule" },
  { label: "Members", value: "14", change: "3 roles active" },
];

export const projects = [
  {
    id: "proj-launch",
    name: "Client Launch Room",
    status: "Active",
    progress: 72,
    accent: "teal",
    owner: "Maya Rao",
    tasks: [
      { title: "Finalize QA checklist", status: "In progress", assignee: "You" },
      { title: "Publish release notes", status: "Todo", assignee: "Aadarsh" },
      { title: "Confirm tenant smoke test", status: "Blocked", assignee: "Sushanth" },
    ],
  },
  {
    id: "proj-mobile",
    name: "Mobile Workflow Upgrade",
    status: "Planning",
    progress: 46,
    accent: "blue",
    owner: "Shreyas M",
    tasks: [
      { title: "Map onboarding states", status: "Done", assignee: "You" },
      { title: "Refine task board gestures", status: "In progress", assignee: "Yathin" },
      { title: "Review API permissions", status: "Todo", assignee: "Maya Rao" },
    ],
  },
  {
    id: "proj-security",
    name: "Tenant Isolation Audit",
    status: "Review",
    progress: 88,
    accent: "emerald",
    owner: "Yathin B.S",
    tasks: [
      { title: "Cross-tenant API probes", status: "Done", assignee: "You" },
      { title: "RBAC matrix review", status: "In progress", assignee: "Shreyas M" },
      { title: "Migration constraint check", status: "Todo", assignee: "Sushanth" },
    ],
  },
];

export const taskDetail = {
  id: "task-tenant-guard",
  title: "Validate tenant guard on task update",
  project: "Tenant Isolation Audit",
  status: "In progress",
  priority: "High",
  assignee: "You",
  due: "Apr 30",
  description:
    "Confirm every task mutation uses the session-derived organization context and never trusts a tenant id supplied by the browser.",
  activity: [
    "Tenant context resolved from secure cookie",
    "Task lookup scoped by task id and organization id",
    "Member status update path separated from manager edit path",
  ],
};

export const members: Array<{
  name: string;
  email: string;
  role: Role;
  status: string;
}> = [
  { name: "Maya Rao", email: "maya@northstar.test", role: "ADMIN", status: "Online" },
  { name: "Shreyas M", email: "shreyas@northstar.test", role: "MANAGER", status: "In review" },
  { name: "Aadarsh Y", email: "aadarsh@northstar.test", role: "MEMBER", status: "Focused" },
  { name: "Sushanth K", email: "sushanth@northstar.test", role: "MEMBER", status: "Away" },
];

export const walkthrough = [
  "Dashboard shows tenant-scoped health, assigned work, and sprint velocity.",
  "Project board organizes tasks by project without exposing other organizations.",
  "Task view separates manager edits from member status updates.",
  "Members page makes role permissions visible before actions are attempted.",
];
