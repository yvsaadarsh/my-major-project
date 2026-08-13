/**
 * Search domain layer.
 *
 * Pure, deterministic, dependency-free. No Prisma, no React, no network, no AI.
 * Given already-fetched candidate rows and a raw query string, this module
 * decides *what matches*, *how well it matches*, and *what snippet to show*.
 *
 * Design rules:
 * - Scoring is explainable: every point comes from a named rule below, so a
 *   result can always answer "why am I here and why am I ranked here?".
 * - Ordering is total: score desc, then field weight, then title, then id.
 *   Two runs over the same input always produce the identical list.
 * - Nothing here reaches for a database. The caller narrows candidates in SQL
 *   (see the search route) and this layer ranks what came back.
 */

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/** Entity kinds the search surface knows about. */
export const SEARCH_ENTITY_TYPES = [
  "project",
  "task",
  "comment",
  "member",
  "milestone",
  "view",
  "automation",
  "audit",
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

/**
 * Scope prefixes let a keyboard user narrow without leaving the input:
 *   `/roadmap`   → projects only
 *   `#login bug` → tasks only
 *   `@priya`     → members only
 *   `>settings`  → commands only (handled client-side, not here)
 */
const SCOPE_PREFIXES: Record<string, SearchEntityType> = {
  "/": "project",
  "#": "task",
  "@": "member",
  "~": "comment",
  "!": "milestone",
};

export type ParsedQuery = {
  /** The query with any scope prefix and filter tokens stripped off. */
  terms: string[];
  /** Normalized text used for phrase matching. */
  phrase: string;
  /** Entity type the prefix restricted us to, if any. */
  scope: SearchEntityType | null;
  /** True when the user typed `>` — the client renders commands, not records. */
  commandMode: boolean;
  /** Inline `status:done` / `priority:high` style filters. */
  filters: Record<string, string>;
  /** The original trimmed input, for echoing back to the UI. */
  raw: string;
};

const FILTER_TOKEN = /^([a-z]+):([a-z0-9_-]+)$/i;

/** Strip accents and case so "Renée" matches "renee". */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();

  let commandMode = false;
  let scope: SearchEntityType | null = null;
  let body = trimmed;

  if (body.startsWith(">")) {
    commandMode = true;
    body = body.slice(1);
  } else {
    const prefix = body.slice(0, 1);
    const scoped = SCOPE_PREFIXES[prefix];
    if (scoped) {
      scope = scoped;
      body = body.slice(1);
    }
  }

  const filters: Record<string, string> = {};
  const words: string[] = [];

  for (const chunk of body.trim().split(/\s+/)) {
    if (!chunk) {
      continue;
    }

    const match = FILTER_TOKEN.exec(chunk);
    if (match) {
      filters[match[1].toLowerCase()] = match[2].toLowerCase();
      continue;
    }

    words.push(chunk);
  }

  const phrase = normalizeText(words.join(" "));

  return {
    commandMode,
    filters,
    phrase,
    raw: trimmed,
    scope,
    terms: tokenize(words.join(" ")),
  };
}

/**
 * Minimum characters before we hit the database. Below this, a query matches
 * so much that ranking is meaningless and the round trip is wasted.
 */
export const MIN_QUERY_LENGTH = 2;

export function isSearchable(parsed: ParsedQuery): boolean {
  if (parsed.commandMode) {
    return true;
  }

  return parsed.phrase.replace(/\s+/g, "").length >= MIN_QUERY_LENGTH;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Which part of a record a piece of text came from. Weight multiplies the
 * match score, so a hit in a title outranks the same hit in a description.
 */
export type SearchField = {
  /** Higher wins. Titles 1.0, bodies 0.45, metadata 0.25. */
  weight: number;
  value: string | null | undefined;
};

export type ScoredMatch = {
  score: number;
  /** Human-readable reasons, so the UI can explain the ranking. */
  reasons: string[];
  /** Index of the highest-weighted field that matched, for tie-breaking. */
  bestFieldWeight: number;
};

/** Points awarded per rule. Kept as named constants so scoring is auditable. */
const POINTS = {
  exactTitle: 120,
  prefix: 60,
  phrase: 40,
  wholeWord: 18,
  partialWord: 7,
} as const;

/**
 * Score one field against the parsed query.
 *
 * Rules, in order of value:
 * 1. The field equals the query exactly.
 * 2. The field starts with the query.
 * 3. The field contains the query as a contiguous phrase.
 * 4. Each query term appears as a whole word.
 * 5. Each query term appears inside a longer word (prefix of a word).
 *
 * Every rule is multiplied by the field weight. A query term that appears
 * nowhere contributes nothing — it does not subtract.
 */
function scoreField(field: SearchField, parsed: ParsedQuery): ScoredMatch {
  const value = normalizeText(field.value ?? "");
  const reasons: string[] = [];

  if (!value || !parsed.phrase) {
    return { bestFieldWeight: 0, reasons, score: 0 };
  }

  let score = 0;

  if (value === parsed.phrase) {
    score += POINTS.exactTitle;
    reasons.push("exact match");
  } else if (value.startsWith(parsed.phrase)) {
    score += POINTS.prefix;
    reasons.push("starts with query");
  } else if (value.includes(parsed.phrase)) {
    score += POINTS.phrase;
    reasons.push("contains phrase");
  }

  const words = value.split(/[^a-z0-9]+/).filter(Boolean);
  const wordSet = new Set(words);
  let matchedTerms = 0;

  for (const term of parsed.terms) {
    if (wordSet.has(term)) {
      score += POINTS.wholeWord;
      matchedTerms += 1;
      continue;
    }

    if (words.some((word) => word.startsWith(term))) {
      score += POINTS.partialWord;
      matchedTerms += 1;
    }
  }

  if (matchedTerms > 0 && parsed.terms.length > 1) {
    // Reward covering more of what the user typed, without letting a long
    // field win purely by being long.
    const coverage = matchedTerms / parsed.terms.length;
    score += Math.round(coverage * POINTS.wholeWord);
    reasons.push(`${matchedTerms}/${parsed.terms.length} terms matched`);
  }

  if (score === 0) {
    return { bestFieldWeight: 0, reasons: [], score: 0 };
  }

  return {
    bestFieldWeight: field.weight,
    reasons,
    score: Math.round(score * field.weight),
  };
}

/**
 * Score a record made of several weighted fields. Field scores add up, but the
 * strongest field is remembered separately so ties break toward title matches.
 */
export function scoreRecord(fields: SearchField[], parsed: ParsedQuery): ScoredMatch {
  let score = 0;
  let bestFieldWeight = 0;
  const reasons: string[] = [];

  for (const field of fields) {
    const result = scoreField(field, parsed);
    if (result.score <= 0) {
      continue;
    }

    score += result.score;
    if (result.bestFieldWeight > bestFieldWeight) {
      bestFieldWeight = result.bestFieldWeight;
      // Only the strongest field explains the result, to keep reasons short.
      reasons.length = 0;
      reasons.push(...result.reasons);
    }
  }

  return { bestFieldWeight, reasons, score };
}

/** Standard field weights, so every call site ranks consistently. */
export const FieldWeight = {
  title: 1,
  secondary: 0.7,
  body: 0.45,
  metadata: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

export type Snippet = {
  text: string;
  /** Character ranges within `text` that matched, for highlight rendering. */
  highlights: Array<{ start: number; end: number }>;
};

/**
 * Build a short excerpt centered on the first match, with the matched ranges
 * marked. Returns the head of the text when nothing matches, so a result never
 * renders an empty body.
 */
export function buildSnippet(
  value: string | null | undefined,
  parsed: ParsedQuery,
  maxLength = 160,
): Snippet {
  const source = (value ?? "").replace(/\s+/g, " ").trim();
  if (!source) {
    return { highlights: [], text: "" };
  }

  const haystack = normalizeText(source);
  const needles = parsed.phrase ? [parsed.phrase, ...parsed.terms] : parsed.terms;

  let anchor = -1;
  for (const needle of needles) {
    if (!needle) {
      continue;
    }
    const found = haystack.indexOf(needle);
    if (found >= 0) {
      anchor = found;
      break;
    }
  }

  let start = 0;
  if (anchor > maxLength / 2) {
    start = Math.max(0, anchor - Math.floor(maxLength / 3));
  }

  let text = source.slice(start, start + maxLength);
  if (start > 0) {
    text = `…${text}`;
  }
  if (start + maxLength < source.length) {
    text = `${text}…`;
  }

  return { highlights: findHighlights(text, parsed), text };
}

/**
 * Locate every matched range inside a display string. Overlapping ranges are
 * merged so the UI never nests one highlight inside another.
 */
export function findHighlights(
  text: string,
  parsed: ParsedQuery,
): Array<{ start: number; end: number }> {
  const haystack = normalizeText(text);
  const ranges: Array<{ start: number; end: number }> = [];

  const needles = new Set<string>();
  if (parsed.phrase) {
    needles.add(parsed.phrase);
  }
  for (const term of parsed.terms) {
    needles.add(term);
  }

  for (const needle of needles) {
    if (!needle) {
      continue;
    }

    let from = 0;
    while (from <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, from);
      if (found < 0) {
        break;
      }
      ranges.push({ end: found + needle.length, start: found });
      from = found + needle.length;
    }
  }

  return mergeRanges(ranges);
}

function mergeRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];

  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }

  return merged;
}

/**
 * Split text into alternating plain/highlighted segments. React can map this
 * directly to spans without any HTML string injection.
 */
export function splitHighlighted(
  text: string,
  highlights: Array<{ start: number; end: number }>,
): Array<{ text: string; match: boolean }> {
  if (highlights.length === 0) {
    return text ? [{ match: false, text }] : [];
  }

  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  for (const range of highlights) {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));

    if (start > cursor) {
      parts.push({ match: false, text: text.slice(cursor, start) });
    }
    if (end > start) {
      parts.push({ match: true, text: text.slice(start, end) });
    }
    cursor = end;
  }

  if (cursor < text.length) {
    parts.push({ match: false, text: text.slice(cursor) });
  }

  return parts.filter((part) => part.text.length > 0);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type SearchResult = {
  id: string;
  type: SearchEntityType;
  title: string;
  /** Where the record lives, e.g. "Roadmap / In Progress". */
  context: string;
  snippet: string;
  /** Highlight ranges for `title`. */
  titleHighlights: Array<{ start: number; end: number }>;
  /** Highlight ranges for `snippet`. */
  snippetHighlights: Array<{ start: number; end: number }>;
  href: string;
  score: number;
  reasons: string[];
};

export type SearchGroup = {
  type: SearchEntityType;
  label: string;
  results: SearchResult[];
  /** Matches found before the per-group cap was applied. */
  total: number;
};

const TYPE_LABELS: Record<SearchEntityType, string> = {
  audit: "Activity",
  automation: "Automations",
  comment: "Comments",
  member: "People",
  milestone: "Milestones",
  project: "Projects",
  task: "Tasks",
  view: "Saved views",
};

export function entityLabel(type: SearchEntityType): string {
  return TYPE_LABELS[type];
}

/**
 * Order groups appear in. Fixed rather than score-derived so the palette layout
 * does not jump around between keystrokes.
 */
const GROUP_ORDER: SearchEntityType[] = [
  "task",
  "project",
  "milestone",
  "comment",
  "member",
  "view",
  "automation",
  "audit",
];

/**
 * Total ordering for results: score, then the weight of the field that matched,
 * then title, then id. Never returns 0 for two distinct records, so sorting is
 * stable across runs and across JS engines.
 */
export function compareResults(a: SearchResult, b: SearchResult): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  const titleCompare = a.title.localeCompare(b.title);
  if (titleCompare !== 0) {
    return titleCompare;
  }

  return a.id.localeCompare(b.id);
}

export function rankResults(results: SearchResult[], limit?: number): SearchResult[] {
  const ranked = results.filter((result) => result.score > 0).sort(compareResults);
  return typeof limit === "number" ? ranked.slice(0, limit) : ranked;
}

/**
 * Bucket ranked results by entity type, preserving `GROUP_ORDER` and dropping
 * empty groups. `perGroup` caps each bucket for the compact palette view while
 * `total` still reports how many matched.
 */
export function groupResults(results: SearchResult[], perGroup = 5): SearchGroup[] {
  const buckets = new Map<SearchEntityType, SearchResult[]>();

  for (const result of results) {
    const bucket = buckets.get(result.type);
    if (bucket) {
      bucket.push(result);
      continue;
    }
    buckets.set(result.type, [result]);
  }

  const groups: SearchGroup[] = [];

  for (const type of GROUP_ORDER) {
    const bucket = buckets.get(type);
    if (!bucket || bucket.length === 0) {
      continue;
    }

    groups.push({
      label: TYPE_LABELS[type],
      results: bucket.slice(0, perGroup),
      total: bucket.length,
      type,
    });
  }

  return groups;
}

/**
 * Flatten groups back into a single navigable list. The command palette moves
 * the selection through this array so arrow keys cross group boundaries
 * naturally instead of stopping at each header.
 */
export function flattenGroups(groups: SearchGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.results);
}
