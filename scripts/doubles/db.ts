// TEST DOUBLE — in-memory Prisma. Only the surface the AI routes touch.
// `any` (not `unknown`) is deliberate and necessary here: route code under the
// test tsconfig reads arbitrary columns off returned rows (`project.id`,
// `task.status`, …). `Record<string, unknown>` would make every such access a
// type error in the real route code this double stands in for. This is the one
// value type that must stay `any` for the dynamic mock to satisfy its callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export const __store: {
  project: Row[]; milestone: Row[]; task: Row[]; activityLog: Row[];
  taskDependency: Row[]; automationRule: Row[]; organizationMember: Row[];
} = {
  project: [], milestone: [], task: [], activityLog: [], taskDependency: [],
  automationRule: [], organizationMember: [],
};

type TableName = keyof typeof __store;

/** Query/mutation arguments, typed without widening to `any`. */
type Args = { where?: Row; data?: Row; take?: number };

/**
 * Test-controllable behaviour for the write/transaction surface.
 *
 * - `insideTransaction` runs once, immediately after `$transaction` opens and
 *   before the callback body. A test uses it to land a competing mutation at
 *   that point, which is how the apply route's *in-transaction* freshness check
 *   is exercised: the old implementation checked before opening the
 *   transaction and could not see it.
 * - `failOn` makes one table/operation throw, so transaction rollback can be
 *   observed after a write has already succeeded. An optional `error` lets a
 *   test inject a specific error object (e.g. a driver-adapter serialization
 *   conflict shape) instead of the generic one, to exercise error
 *   classification in the route.
 */
export const __hooks: {
  insideTransaction: (() => void) | null;
  failOn: {
    table: TableName;
    op: "create" | "updateMany" | "deleteMany";
    error?: unknown;
  } | null;
} = { insideTransaction: null, failOn: null };

let idCounter = 0;

function matches(row: Row, where: Row = {}): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") { if (!(v as Row[]).some((c) => matches(row, c))) return false; continue; }
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) { if (!(v.in as unknown[]).includes(row[k])) return false; continue; }
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function guard(name: TableName, op: "create" | "updateMany" | "deleteMany") {
  if (__hooks.failOn && __hooks.failOn.table === name && __hooks.failOn.op === op) {
    if ("error" in __hooks.failOn && __hooks.failOn.error !== undefined) {
      throw __hooks.failOn.error;
    }
    throw new Error(`injected failure: ${name}.${op}`);
  }
}

const table = (name: TableName) => ({
  async findFirst({ where }: Args = {}) { return __store[name].find((r) => matches(r, where)) ?? null; },
  async findFirstOrThrow({ where }: Args = {}) {
    const row = __store[name].find((r) => matches(r, where));
    if (!row) throw new Error(`${name}.findFirstOrThrow: no row matched`);
    return row;
  },
  async findMany({ where, take }: Args = {}) {
    const rows = __store[name].filter((r) => matches(r, where));
    return take ? rows.slice(0, take) : rows;
  },
  async count({ where }: Args = {}) { return __store[name].filter((r) => matches(r, where)).length; },

  async create({ data }: Args = {}) {
    guard(name, "create");
    idCounter += 1;
    const row: Row = { id: `gen_${idCounter}`, ...data };
    __store[name].push(row);
    return row;
  },
  async updateMany({ where, data }: Args = {}) {
    guard(name, "updateMany");
    const rows = __store[name].filter((r) => matches(r, where));
    // Prisma ignores keys whose value is `undefined`, which is how a partial
    // PATCH leaves untouched columns alone. Assigning the raw object would
    // instead overwrite those columns with undefined, so a request that only
    // flipped `enabled` would silently blank the rule's name and trigger.
    const patch: Row = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v !== undefined) patch[k] = v;
    }
    for (const row of rows) Object.assign(row, patch);
    return { count: rows.length };
  },
  async deleteMany({ where }: Args = {}) {
    guard(name, "deleteMany");
    const kept: Row[] = [];
    let count = 0;
    for (const row of __store[name]) {
      if (matches(row, where)) count += 1;
      else kept.push(row);
    }
    __store[name].length = 0;
    __store[name].push(...kept);
    return { count };
  },
});

function snapshotStore(): Record<string, Row[]> {
  return structuredClone({
    project: __store.project, milestone: __store.milestone, task: __store.task,
    activityLog: __store.activityLog, taskDependency: __store.taskDependency,
    automationRule: __store.automationRule,
    organizationMember: __store.organizationMember,
  });
}

function restoreStore(snap: Record<string, Row[]>) {
  for (const key of Object.keys(snap) as TableName[]) {
    __store[key].length = 0;
    __store[key].push(...snap[key]);
  }
}

/**
 * `taskDependency` reads, with the endpoint relations resolved.
 *
 * Real queries use `DEPENDENCY_SCOPE_SELECT`, which always nests
 * `sourceTask: { projectId }` and `targetTask: { projectId }`; consumers drop
 * any edge whose endpoint is missing. Deriving those from the task store on
 * every read keeps rows written by `create` indistinguishable from fixtures —
 * without it, a freshly created edge would silently vanish from anything that
 * flattens edges, which is a property of this double rather than of the code
 * under test.
 */
function dependencyTable() {
  const base = table("taskDependency");
  const resolve = (row: Row): Row => {
    const source = __store.task.find((t) => t.id === row.sourceTaskId);
    const target = __store.task.find((t) => t.id === row.targetTaskId);
    return {
      ...row,
      sourceTask: source ? { projectId: source.projectId } : null,
      targetTask: target ? { projectId: target.projectId } : null,
    };
  };
  return {
    ...base,
    async findFirst(args: Args = {}) {
      const row = await base.findFirst(args);
      return row ? resolve(row) : null;
    },
    async findMany(args: Args = {}) {
      return (await base.findMany(args)).map(resolve);
    },
  };
}

export const prisma = {
  project: table("project"), milestone: table("milestone"), task: table("task"),
  activityLog: table("activityLog"), taskDependency: dependencyTable(),
  automationRule: table("automationRule"),
  organizationMember: table("organizationMember"),

  /**
   * Interactive transaction with real rollback semantics over the in-memory
   * store: the whole store is snapshotted on entry and restored if the callback
   * throws, so a partially-applied change cannot survive a later failure.
   *
   * The route's second argument (isolation level) is simply not read here —
   * this double cannot model Postgres serializable conflict detection, and no
   * test in this repository claims that it does.
   */
  async $transaction(fn: (client: unknown) => Promise<unknown>) {
    const snap = snapshotStore();
    if (__hooks.insideTransaction) {
      const hook = __hooks.insideTransaction;
      __hooks.insideTransaction = null;
      hook();
    }
    try {
      return await fn(prisma);
    } catch (error) {
      restoreStore(snap);
      throw error;
    }
  },
};
