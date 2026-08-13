// TEST DOUBLE — in-memory Prisma. Only the surface the AI routes touch.
type Row = Record<string, any>;
export const __store: {
  project: Row[]; milestone: Row[]; task: Row[]; activityLog: Row[];
  taskDependency: Row[];
} = { project: [], milestone: [], task: [], activityLog: [], taskDependency: [] };

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as Row[]).some((c) => matches(row, c))) return false; continue; }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) { if (!(v.in as any[]).includes(row[k])) return false; continue; }
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}
const table = (name: keyof typeof __store) => ({
  async findFirst({ where }: any = {}) { return __store[name].find((r) => matches(r, where)) ?? null; },
  async findMany({ where, take }: any = {}) {
    const rows = __store[name].filter((r) => matches(r, where));
    return take ? rows.slice(0, take) : rows;
  },
  async count({ where }: any = {}) { return __store[name].filter((r) => matches(r, where)).length; },
});
export const prisma: any = {
  project: table("project"), milestone: table("milestone"), task: table("task"),
  activityLog: table("activityLog"), taskDependency: table("taskDependency"),
};
