# Design rules

How Launch's screens look and read. `.claude/rules/ui.md` covers the mechanics (tokens, themes,
DaisyUI); this file covers the judgement. The app page (`apps/web/src/ui/pages/apps/app/`) is the
reference implementation, and a new screen follows it.

## Layout

- **No card-in-card, and no panel around every section.** Group with a heading, whitespace and a
  hairline divider (`divide-y divide-base-300`, `border-y border-base-300`). A `SectionPanel` is
  for a self-contained block at the top level of a page, never inside another one.
- **Lists are rows or tables, not tiles.** Environments, releases, sessions and activity are one
  row each, so they scan top to bottom and line up. The exception is a list whose items are
  best recognised by sight: Home's apps are cards led by each app's screenshot, in a grid, each
  card one link, with the cards themselves the surface (no panel around them).
- **No left-border accent stripes** (`border-l-4 border-l-*`). State is a small dot and a word
  (`.status-badge`, `HealthDot`), not a coloured edge.
- **Pages use the full width.** Lists, tables, logs and detail pages take the whole main area — no
  `max-w-*` on the page root. Only a form or running prose keeps a reading width (`max-w-2xl` /
  `max-w-3xl`: Profile, Request access, the prompt editor, a not-found sentence), set on that block.

## Actions

- **One hero action per view.** `.btn-flame` (on `btn btn-primary`) marks the single thing the
  view exists for — on the app page, Ship when changes are waiting and Change it otherwise.
  Everything else is a plain or ghost button, or sits in the row's or header's ⋯ menu.
- **Labels say what happens.** "Ship v1.4.2 live", "Request approval", "Deploy main to Live…" —
  never "Submit", "OK" or "Go". A button that leaves Launch is marked ↗.
- **Hide what the reader cannot use; do not disable it.** Everybody sees the same page, minus the
  actions the server would refuse them. A disabled control is for something that will become
  possible on this page (a tab before the first deploy), with the reason in its `title`.

## Words and colour

- **Colour carries meaning only.** `error`, `warning` and `success` mark state. Nothing is coloured
  for decoration; an attention list is a plain list under a heading, never a tinted alert box.
- **At most one status per row.** No badge soup: if a row needs two facts, one of them is a word.
- **No icons in tinted circles, no emoji, no decorative gradients, glows or oversized rounded
  corners.** The flame gradient is the one exception, and it is the hero button.
- **No marketing copy and no exclamation marks.** Say what is true and what happens next.
- **Environments are Staging and Live** in the UI. "Preview" is a coding session's preview host;
  GitHub and wrangler keep the names `staging` / `production`.

## Numbers and time

- **Versions and numbers in tabular monospace** (`font-mono tabular-nums`): `v1.4.2`, `#41`.
- **Times are relative, with the absolute time in `title`**: `<time title="2 Oct 2026, 14:05">3
  minutes ago</time>` (`Ago` in `pages/apps/app/bits.tsx`).

## Empty states

- **One sentence and at most one action.** "No sessions running." No illustrations on internal
  tabs; `EmptyState` with an icon is for a whole page that has nothing yet.
