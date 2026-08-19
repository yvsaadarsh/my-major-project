"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Flag,
  FolderKanban,
  Layers,
  MessageSquare,
  Search as SearchIcon,
  ShieldCheck,
  UserRound,
  Zap,
} from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { Highlighted } from "@/components/highlighted-text";
import { EmptyState, InlineError, LoadingState } from "@/components/page-state";
import { SectionCard } from "@/components/section-card";
import { apiRequest } from "@/lib/ui/api-client";
import { useAuthSession } from "@/lib/ui/use-auth-session";
import {
  entityLabel,
  parseSearchQuery,
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchGroup,
  type SearchResult,
} from "@/lib/domain/search";

type SearchResponse = {
  groups: SearchGroup[];
  results: SearchResult[];
  query: string;
  scope: SearchEntityType | null;
  searchedTypes?: SearchEntityType[];
  total: number;
  truncated: boolean;
};

const TYPE_ICONS: Record<SearchEntityType, typeof SearchIcon> = {
  audit: ShieldCheck,
  automation: Zap,
  comment: MessageSquare,
  member: UserRound,
  milestone: Flag,
  project: FolderKanban,
  task: CheckCircle2,
  view: Layers,
};

/**
 * Full search page — the "see everything" companion to the ⌘K palette.
 *
 * The palette is for jumping somewhere fast; this page is for working through a
 * result set: no per-group cap, type filters, and the score/reasons visible so
 * ranking is never a black box.
 *
 * Both surfaces call the same endpoint and render with the same domain helpers,
 * so a result can never appear here but not there (or rank differently).
 */
export default function SearchPage() {
  const { error: authError, loading: authLoading, organization, role } = useAuthSession({
    requireOrganization: true,
  });

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeTypes, setActiveTypes] = useState<SearchEntityType[]>([]);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => parseSearchQuery(debounced), [debounced]);

  // Seed from ?q= so the palette's "Search everything" hand-off keeps the query.
  // Read once on mount rather than via useSearchParams to avoid forcing this
  // page into a Suspense boundary.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) {
      setInput(initial);
      setDebounced(initial);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), 220);
    return () => clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (parsed.phrase.replace(/\s+/g, "").length < 2) {
      setResponse(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ q: parsed.raw });
    if (activeTypes.length > 0) {
      params.set("types", activeTypes.join(","));
    }

    apiRequest<SearchResponse>(`/api/v1/command/search?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(setResponse)
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        setResponse(null);
        setError(caught instanceof Error ? caught.message : "Search failed.");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [activeTypes, parsed.phrase, parsed.raw]);

  /**
   * Group the flat result list ourselves rather than using the response's
   * `groups`, which are capped at five per type for the palette. Here we want
   * every match.
   */
  const grouped = useMemo(() => {
    const results = response?.results ?? [];
    if (results.length === 0) {
      return [];
    }

    const buckets = new Map<SearchEntityType, SearchResult[]>();
    for (const result of results) {
      const bucket = buckets.get(result.type);
      if (bucket) {
        bucket.push(result);
        continue;
      }
      buckets.set(result.type, [result]);
    }

    // Largest bucket first, so the most productive type is nearest the top.
    return [...buckets.entries()]
      .map(([type, items]) => ({ items, type }))
      .sort((a, b) => b.items.length - a.items.length || a.type.localeCompare(b.type));
  }, [response]);

  function toggleType(type: SearchEntityType) {
    setActiveTypes((current) =>
      current.includes(type) ? current.filter((entry) => entry !== type) : [...current, type],
    );
  }

  if (authLoading) {
    return <LoadingState label="Loading search" />;
  }

  const searchable = parsed.phrase.replace(/\s+/g, "").length >= 2;
  const searchedTypes = response?.searchedTypes ?? [];

  return (
    <AppShell
      description="Search across projects, tasks, comments, milestones, people, saved views and automations — scoped to your tenant and filtered by what your role can read."
      eyebrow="Find anything"
      organizationName={organization?.name}
      role={role}
      title="Search"
    >
      <div className="space-y-6">
        {authError && <InlineError message={authError} />}
        {error && <InlineError message={error} />}

        <SectionCard>
          <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 focus-within:border-teal-300/40">
            <SearchIcon className="shrink-0 text-teal-300" size={18} />
            <input
              autoFocus
              className="h-14 min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-slate-600"
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search everything you have access to…"
              value={input}
            />
            {loading && <span className="shrink-0 text-xs text-slate-500">Searching…</span>}
          </label>

          <div className="mt-4 flex flex-wrap gap-2">
            {SEARCH_ENTITY_TYPES.map((type) => {
              const enabled = activeTypes.includes(type);
              // Types the role cannot read are shown disabled rather than
              // hidden, so the absence of results is explained, not mysterious.
              const permitted = searchedTypes.length === 0 || searchedTypes.includes(type);
              const Icon = TYPE_ICONS[type];

              return (
                <button
                  aria-pressed={enabled}
                  className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                    enabled
                      ? "border-teal-300/40 bg-teal-300/15 text-teal-100"
                      : "border-white/10 bg-white/[0.04] text-slate-400 hover:text-white"
                  } ${permitted ? "" : "opacity-40"}`}
                  key={type}
                  onClick={() => toggleType(type)}
                  type="button"
                >
                  <Icon size={13} />
                  {entityLabel(type)}
                </button>
              );
            })}
            {activeTypes.length > 0 && (
              <button
                className="rounded-xl px-3 py-2 text-xs text-slate-500 underline-offset-4 hover:text-white hover:underline"
                onClick={() => setActiveTypes([])}
                type="button"
              >
                Clear filters
              </button>
            )}
          </div>

          <p className="mt-4 text-xs leading-5 text-slate-500">
            Prefixes narrow without filters:{" "}
            <code className="text-slate-400">#</code> tasks,{" "}
            <code className="text-slate-400">/</code> projects,{" "}
            <code className="text-slate-400">@</code> people,{" "}
            <code className="text-slate-400">~</code> comments,{" "}
            <code className="text-slate-400">!</code> milestones. Press{" "}
            <kbd className="rounded border border-white/10 px-1 text-slate-400">Ctrl</kbd>{" "}
            <kbd className="rounded border border-white/10 px-1 text-slate-400">K</kbd> anywhere for
            the command palette.
          </p>
        </SectionCard>

        {!searchable ? (
          <EmptyState
            description="Type at least two characters. Results only ever include records inside your organization that your role is allowed to read."
            title="Search your workspace"
          />
        ) : response && response.results.length === 0 && !loading ? (
          <EmptyState
            description={`Nothing matched “${parsed.raw}” in the ${
              activeTypes.length > 0 ? "selected types" : "types your role can read"
            }.`}
            title="No matches"
          />
        ) : (
          <div className="space-y-6">
            {response && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
                <p>
                  <span className="font-semibold text-white">{response.results.length}</span>{" "}
                  {response.results.length === 1 ? "result" : "results"} for{" "}
                  <span className="text-teal-200">“{response.query}”</span>
                  {response.scope && <span className="text-slate-500"> · scoped to {response.scope}s</span>}
                </p>
                {response.truncated && (
                  <p className="rounded-xl border border-amber-300/25 bg-amber-300/10 px-3 py-1.5 text-xs text-amber-100">
                    Top matches only — narrow the query for a complete list.
                  </p>
                )}
              </div>
            )}

            {grouped.map((group) => {
              const Icon = TYPE_ICONS[group.type];

              return (
                <SectionCard key={group.type}>
                  <div className="flex items-center gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.06] text-teal-200">
                      <Icon size={16} />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-white">{entityLabel(group.type)}</p>
                      <p className="text-xs text-slate-500">
                        {group.items.length} {group.items.length === 1 ? "match" : "matches"}
                      </p>
                    </div>
                  </div>

                  <ul className="mt-4 space-y-2">
                    {group.items.map((result) => (
                      <li key={`${result.type}-${result.id}`}>
                        <Link
                          className="block rounded-2xl border border-white/5 bg-white/[0.02] px-4 py-3 transition-all hover:border-white/15 hover:bg-white/[0.05]"
                          href={result.href}
                        >
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="text-sm font-semibold text-white">
                              <Highlighted
                                highlights={result.titleHighlights}
                                text={result.title}
                              />
                            </p>
                            <p className="text-[11px] text-slate-500">{result.context}</p>
                          </div>

                          {result.snippet && (
                            <p className="mt-1.5 text-xs leading-5 text-slate-400">
                              <Highlighted
                                highlights={result.snippetHighlights}
                                text={result.snippet}
                              />
                            </p>
                          )}

                          {result.reasons.length > 0 && (
                            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                              {result.reasons.map((reason) => (
                                <span
                                  className="rounded-lg bg-white/[0.05] px-2 py-0.5 text-[10px] text-slate-400"
                                  key={reason}
                                >
                                  {reason}
                                </span>
                              ))}
                              <span className="text-[10px] text-slate-600">
                                relevance {result.score}
                              </span>
                            </div>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}

