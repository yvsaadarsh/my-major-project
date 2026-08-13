# Keyboard shortcuts & search

The in-app reference lives at `/shortcuts` (press `?` from anywhere). This file
is the implementation-side companion: what exists, where it lives, and why it
behaves the way it does.

## Design rules

1. **Never steal a keystroke from a field.** Every global handler bails out when
   the event target is an `input`, `textarea`, `select`, or `contenteditable`
   element, and when any modifier other than the one it wants is held. Typing a
   `/` inside a task description must insert a slash, not open a dialog.
2. **One source of truth per shortcut.** `GOTO_SHORTCUTS` in
   `src/lib/ui/commands.ts` is read by both the key handler
   (`useGotoShortcuts`) and the `/shortcuts` page, so documentation cannot drift
   from behaviour.
3. **No mystery ranking.** Search results carry the reasons they matched and
   their relevance score, and `/search` renders both.
4. **Permissions decide visibility, the server decides access.** Hiding a
   command or a result type is a courtesy to the user. Every mutation and every
   query is still authorized server-side.

## Global

| Keys | Action |
| --- | --- |
| `Ctrl`/`⌘` + `K` | Open the command palette |
| `/` | Open the palette (search-first) |
| `?` | Open `/shortcuts` |
| `g` then a key | Jump to a section (see below) |

## Inside the palette

| Keys | Action |
| --- | --- |
| `↑` `↓` | Move through the flat row list (crosses group headers) |
| `Ctrl` + `P` / `Ctrl` + `N` | Same, without leaving the home row |
| `Enter` | Open the highlighted row |
| `Enter` (nothing highlighted) | Fall through to `/search?q=…` |
| `Home` / `End` | First / last row |
| `Esc` | Close and restore focus to wherever it was |

Arrow keys walk `rows`, which is derived from the same `sections` array the DOM
renders. The highlighted row and the row `Enter` opens therefore cannot diverge.

## Go to

`g` arms a prefix, then a second key navigates. The prefix expires after 1.2s so
a stray `g` cannot lie in wait and hijack the next keystroke.

| Keys | Destination | Permission |
| --- | --- | --- |
| `g` `d` | Dashboard | — |
| `g` `p` | Projects | — |
| `g` `a` | Analytics | `dashboard:read` |
| `g` `w` | Work OS | — |
| `g` `y` | Your Progress | — |
| `g` `n` | Notifications | `notifications:read` |
| `g` `m` | Members | `members:read` |
| `g` `s` | Search | — |

## Search prefixes

Typed as the **first character** of a query.

| Prefix | Scope | Example |
| --- | --- | --- |
| `>` | Commands only (client-side; never hits the API) | `> new task` |
| `#` | Tasks | `#login bug` |
| `/` | Projects | `/roadmap` |
| `@` | People | `@priya` |
| `~` | Comments | `~needs review` |
| `!` | Milestones | `!beta launch` |

Inline `field:value` tokens are parsed into `ParsedQuery.filters` and stripped
from the match text, so `status:done migration` searches for "migration" with a
status filter available to the caller.

## How search works

```
query string
  → parseSearchQuery()            pure: prefix, filters, terms, phrase
  → isSearchable()                2-char floor, or command mode
  → Postgres narrowing            ILIKE per entity type, tenant-scoped
  → scoreRecord()                 pure: weighted fields → score + reasons
  → buildSnippet / findHighlights pure: excerpt + match ranges
  → rankResults / groupResults    pure: total order, fixed group order
```

### Scoring

Every point comes from a named rule in `src/lib/domain/search.ts`, multiplied by
the weight of the field it matched:

| Rule | Points |
| --- | --- |
| Field equals the query | 120 |
| Field starts with the query | 60 |
| Field contains the query as a phrase | 40 |
| A query term appears as a whole word | 18 each |
| A query term prefixes a longer word | 7 each |
| Coverage bonus (share of terms matched) | up to 18 |

Field weights: title `1.0`, secondary `0.7`, body `0.45`, metadata `0.25`.

Ordering is a **total order** — score, then title, then id — so two runs over
the same data always produce the identical list, and no result depends on the
JS engine's sort stability.

### Per-entity permissions

`ENTITY_PERMISSION` in the search route maps each type to the permission needed
to see it. A role missing that permission does not trigger the query at all: the
row is not fetched, not scored, and not counted in `total`. A blanket
`dashboard:read` would have leaked audit-log contents to any member who could
guess at them.

| Type | Permission |
| --- | --- |
| Project, Milestone, Saved view | `projects:read` |
| Task, Comment | `tasks:read` |
| Member | `members:read` |
| Automation | `automations:read` |
| Activity (audit) | `audit:read` |

### Highlighting

Snippets are returned as text plus match **ranges**. The client turns ranges
into `<mark>` spans via `splitHighlighted()`. Nothing ever goes through
`dangerouslySetInnerHTML`, so a task titled `<script>` renders as text.

### Candidate caps

Postgres returns at most `CANDIDATE_LIMIT` (40) rows per type before ranking.
When any type hits that ceiling the response sets `truncated: true` and both
surfaces say so, rather than silently presenting a partial list as complete.

## Adding a shortcut or command

- **A command:** append to `PALETTE_COMMANDS` in `src/lib/ui/commands.ts`. Set
  `permission` if it should hide for some roles. Use `href` for navigation or
  `action` for one of the named client actions — the palette cannot execute
  arbitrary strings.
- **A `g` destination:** append to `GOTO_SHORTCUTS`. The `/shortcuts` page picks
  it up automatically.
- **A searchable entity:** add it to `SEARCH_ENTITY_TYPES`, give it a label in
  `TYPE_LABELS`, a slot in `GROUP_ORDER`, a permission in `ENTITY_PERMISSION`,
  and a query + `push()` call in the route. Missing any of these fails to
  compile rather than silently omitting the type.
