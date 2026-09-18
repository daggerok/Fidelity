# Catalog UI implementation plan: distribution frequency column + pinned columns

This is a concrete, self-contained implementation plan for two features on the
Fidelity ETF catalog table (`renderFundsTable()` in `app.tsx`, rendered into
`#table-scroll` in `index.html`). It is written for an implementing agent with
no access to prior conversations or sibling repos - every instruction below
names the exact file, function, line-area, and code to paste in. Follow it
mechanically; the investigation and design decisions are already made.

Both features apply only to the main "All ETFs" / category catalog table
produced by `renderFundsTable()`. The Watchlist, Holdings, History, Overview,
and Distributions tables reuse the same `#table-head` / `#table-body` /
`#table-scroll` DOM nodes but are rendered by other functions
(`renderWatchlistTable`-style code near line 1041, `renderSheetTable()`,
`renderOverviewTable()`, `renderDistributionsTable()`) - do not touch those,
and do not use selectors that would leak into them.

## Current repo state (investigated 2026-09-17)

- `app.tsx` is 1854 lines, `index.html` is 212 lines. No build step; Babel
  standalone compiles the inline TypeScript in the browser.
- The catalog header row is built by `renderFundsTable()` (starts at line 864)
  using `indexHeader()` (825), `useHeader()` (829), and repeated calls to
  `sortHeader(label, key, numeric)` (817) for the rest of the columns.
- The catalog body rows are built in the same function, in the
  `el.tableBody.innerHTML = rows.map((fund, index) => ...)` block starting
  around line 900.
- Fund rows are objects normalized by `normalizeFundRow(fund: IndexFund): FundRow`
  (line 388), which flattens `fund.returns.monthEnd` and `fund.metrics` onto
  the row so the generic sort/compare code (`sortValue`, `compareValues`) can
  read a plain field.
- CSV/TXT export column order for the catalog view comes from the final
  (fallback) branch of `currentExportRows()` (around line 1484), which is
  independent code from the on-screen table and must be kept in sync by hand.
- No column pinning exists anywhere in this repo today. `grep -n "sticky"`
  across `app.tsx` and `index.html` only matches the whole-header
  `sticky top-0 z-20` on `<thead id="table-head">` (index.html line 190) and an
  unrelated code comment about scroll containment. There is no
  `catalog-sticky-*` class, no `left:` offset, nothing to fix - this is a
  from-scratch addition, not a bug fix.
- `docs/ui-contract.md` only says "Catalog columns use the common order
  documented in the README" - the README has no explicit column-order table
  beyond prose, so there is no existing contract to violate by inserting a
  new column between SEC Yield and YTD Return.

---

## 1. Distribution frequency column

### Current state: gap, not yet implemented in the catalog

Fidelity already computes a distribution-cadence value, but it is only
displayed in the per-fund Overview detail table, never in the catalog:

- The raw field is `fund.distributions.frequency`, produced by
  `inferDistributionFrequency()` in `scripts/update-data.ts` (line 872). It
  returns one of exactly these literal strings, confirmed against the live
  `api/fidelity/index.json` (current distribution: `Monthly` x15, `Quarterly`
  x48, `Semiannually` x2, `Annually` x1, `Unknown` x6, `None` x2 - `Irregular`
  is a possible but currently unseen value): `'Monthly'`, `'Quarterly'`,
  `'Semiannually'`, `'Annually'`, `'None'`, `'Unknown'`, `'Irregular'`. A
  seed/placeholder path (around app.tsx line 1714) can also set it to `'—'`
  before real data loads.
- Today this raw value is only surfaced in `COLUMN_TOOLTIPS['Frequency']`
  (line 167, plain text with no codes or source) and in
  `renderOverviewTable()` (line 1200: `{ section: 'Distributions', metric:
  'Frequency', value: fund.distributions ? fund.distributions.frequency : null }`).
  Leave that Overview row exactly as it is - it should keep showing the raw
  label (`Monthly`, `Quarterly`, ...), not the coded value.
- The catalog table (`renderFundsTable()`) has no Frequency column at all:
  none of the `sortHeader(...)` calls between line 870 and 891 reference
  frequency, and none of the `<td>` cells between line 911 and 932 render it.
- Do not add a second data source or recompute cadence in the browser - reuse
  `fund.distributions.frequency` exactly as `inferDistributionFrequency()`
  already produced it server-side.

### What to add

**Placement.** Fidelity's catalog already has adjacent `SEC Yield` and
`YTD Return` columns, in that exact order (`sortHeader('SEC Yield',
'secYield', true)` at line 877, immediately followed by `sortHeader('YTD
Return', 'ytd', true)` at line 878). Insert the new `Frequency` column
between them, matching the required "after SEC Yield, before YTD Return"
contract with no other change of order needed.

**1. Type additions** - in the `FundRow` type block (app.tsx, lines 58-93),
add a field next to the other derived metrics:

```ts
      dividendYield?: number | null;
      secYield?: number | null;
      distFrequency?: string;
      returnAsOf: string;
```

**2. New formatting helper** - add this next to the other `format*` helpers
(app.tsx, right after `formatMoney`, which ends at line 307):

```ts
    // Normalizes the raw fund.distributions.frequency string from the Yahoo
    // dividend-history feed (inferDistributionFrequency() in
    // scripts/update-data.ts) into a two-digit numeric-prefixed label so the
    // catalog column sorts by cadence instead of alphabetically.
    function formatDistributionFrequency(value: unknown): string {
      const raw = String(value ?? '').trim();
      const normalized = raw.toLowerCase().replace(/[‐‑‒–—]/g, '-').replace(/\s+/g, ' ');
      if (!normalized || normalized === '-' || normalized === '—') return '00 - —';
      if (normalized === 'monthly') return '01 - Monthly';
      if (normalized === 'quarterly') return '04 - Quarterly';
      if (normalized === 'semiannually' || normalized === 'semiannual' || normalized === 'semi-annual' || normalized === 'semi-annually') return '06 - Semi-annually';
      if (normalized === 'annually' || normalized === 'annual') return '12 - Annually';
      if (normalized === 'none') return '00 - None';
      if (normalized === 'unknown') return '00 - Unknown';
      if (normalized === 'irregular') return '99 - Irregular';
      return raw;
    }
```

The `semiannual`/`semi-annual` branches are defensive normalization for
spelling variants the feed does not currently produce (today it only emits
`Semiannually`), kept for forward compatibility exactly like the other
`format*` helpers tolerate messy input.

**3. Populate the field in `normalizeFundRow()`** (app.tsx, function starts
line 388) - add one line next to `secYield`:

```ts
        dividendYield: metrics.dividendYield ?? null,
        secYield: null, // Fidelity publishes no 30-day SEC yield feed.
        distFrequency: formatDistributionFrequency(fund.distributions && fund.distributions.frequency),
        returnAsOf: monthEnd.asOfDate ?? null,
```

**4. Update the tooltip** - replace the existing `Frequency` entry in
`COLUMN_TOOLTIPS` (app.tsx line 167) so it states the source feed and
explains the codes, matching the em-dash style already used by every other
entry in that object:

```ts
      Frequency: 'Distribution Frequency — Cadence inferred from the Yahoo dividend-history feed (inferDistributionFrequency() in scripts/update-data.ts), coded for sorting: 01 Monthly, 04 Quarterly, 06 Semi-annually, 12 Annually, 00 Unknown/None/—, 99 Irregular.',
```

**5. Add the header** - in `renderFundsTable()`, insert between the existing
`SEC Yield` and `YTD Return` header calls (app.tsx lines 877-878):

```ts
          ${sortHeader('SEC Yield', 'secYield', true)}
          ${sortHeader('Frequency', 'distFrequency')}
          ${sortHeader('YTD Return', 'ytd', true)}
```

Note `numeric` is left `false` (the third argument defaults to `false`)
because the column displays a text label (`"04 - Quarterly"`), not a
right-aligned number - this matches how `sortHeader('Ticker', 'ticker')` and
`sortHeader('Inception', 'inceptionDate')` are already called without the
`numeric` flag. Sorting still works correctly because the two-digit numeric
prefix makes plain string comparison (`compareValues()`, line 795) order the
codes correctly.

**6. Add the body cell** - in the same function's row template, insert
between the SEC Yield cell and the YTD Return cell (app.tsx lines 918-919):

```ts
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">—</td>
              <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.distFrequency || '00 - —')}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.ytd)}</td>
```

Use the plain (non-right-aligned) text styling shown above
(`text-slate-600 dark:text-slate-400`, no `text-right`), matching how the
other text-label columns (`Return As Of`, `Inception`, `As Of`) are styled in
this same table, since this is a label, not a number.

**7. Bump the empty-state colspan** - the "no rows" placeholder in the same
function currently hardcodes the column count (app.tsx line 898):

```ts
        el.tableBody.innerHTML = `<tr><td colspan="24" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
```

Change `colspan="24"` to `colspan="25"` (23 existing catalog columns + `#` +
`Use`, plus the new Frequency column = 25 total `<th>`/`<td>` per row).

**8. Export parity** - in `currentExportRows()` (app.tsx, fallback branch
around line 1484), insert a matching header and value between `'SEC Yield (%)'`
and `'YTD Return (%)'`:

```ts
        headers: ['Selected', 'Ticker', 'Fund Name', 'Type', 'NAV', 'Net Assets ($)', 'Expense (%)', 'Dividend Yield (%)', 'SEC Yield (%)', 'Frequency', 'YTD Return (%)', 'TR 1Y (%)', 'TR 3Y (%)', 'TR 5Y (%)', 'TR 10Y (%)', 'CAGR 3Y (%)', 'CAGR 5Y (%)', 'CAGR 10Y (%)', 'SI Ann. (%)', 'Return As Of', 'Inception', 'Holdings', 'History', 'As Of'],
        rows: filterRows(visibleFunds()).map(fund => [
          state.selected.has(fund.ticker) ? 'yes' : 'no',
          fund.ticker,
          fund.name,
          fund.category,
          fund.nav || '',
          numberCell(fund.aumValue),
          numberCell(fund.terValue),
          numberCell(fund.dividendYield),
          numberCell(null), // SEC yield: not published by Fidelity
          fund.distFrequency || '00 - —',
          numberCell(fund.ytd),
```

(leave the rest of that array and the `rows.map` body unchanged - this only
inserts one header string and one value line in the middle of the existing
lists, keeping every other column exactly where it is).

This keeps CSV/TXT export column order and values identical to the on-screen
catalog table, per the shared contract.

---

## 2. Horizontally pinned catalog columns

### Current state: does not exist yet (from scratch, no regression to fix)

As noted above, there is no sticky-column CSS or markup anywhere in this
repo. This section is a from-scratch addition, built directly on the safe
"sticky on the cell itself" technique - do not introduce a nested wrapper
`<span>`/`<div>` inside the pinned `<td>`/`<th>`, since a sticky element can
never escape a `position: static` parent and would silently stop pinning the
moment the column scrolls far enough to leave the viewport.

### Columns to pin

- **Use** column: header is `useHeader()` (app.tsx line 829), already `w-20`
  (5rem / 80px) with a checkbox + `Use` label. Body cell is the first `<td>`
  after the `#` index cell (app.tsx line 905), currently `class="py-2.5 px-4
  text-center"` with no explicit width - it must get an explicit width so its
  actual rendered size matches its `left` offset math.
- **Ticker** column: header comes from `sortHeader('Ticker', 'ticker')`
  (app.tsx line 870), no explicit width today. Body cell is the following
  `<td>` (app.tsx line 911), `class="py-2.5 px-4 font-mono font-semibold
  text-blue-600 dark:text-blue-400"`, also no explicit width. All 74 current
  Fidelity tickers are exactly 4 characters (`FAAA`, `FBCG`, ... - verified
  against `api/fidelity/index.json`), so `6rem` (96px) comfortably fits the
  ticker text plus the sort arrow glyph (`↑`/`↓`) that `sortHeader()` appends
  when this column is the active sort key.
- Do **not** pin the `#` row-number column (`indexHeader()` / the first
  `<td>` at line 904) - it stays an ordinary scrolling column, it just
  happens to render before `Use`.
- Pinned order, left to right: `#` (not pinned, scrolls away) -> `Use`
  (pinned, `left: 0`) -> `Ticker` (pinned, `left: 5rem`) -> `Fund Name`
  onward (ordinary scrolling columns, unchanged).

### CSS-critical detail specific to this repo

The `<table>` element in `index.html` (line 189) currently has
`class="w-full text-left border-collapse whitespace-nowrap"` - the Tailwind
utility `border-collapse` sets `border-collapse: collapse`, which must become
`separate` for sticky cells to paint correctly (collapsed borders cause
sticky-cell rendering glitches at the seam). The `#table-scroll table{...}`
ID-selector rule below overrides that class safely: an ID + type selector
`(1,0,1)` beats a single class selector `(0,1,0)` regardless of CSS source
order, so no edit to the `<table>` tag's own `class` attribute is required.

The catalog table's default (non-hover, non-selected) row background is not
a plain white/slate rectangle in dark mode - it is whatever shows through
the translucent card behind it. The card `<div>` wrapping `#table-scroll`
(`index.html` line 187) is `class="bg-white dark:bg-slate-800/50 ..."`, i.e.
in dark mode the table sits on `slate-800` at 50% opacity over the page body
background `dark:bg-slate-900` (`index.html` line 32 sets
`document.documentElement.style.backgroundColor` and the `<body>` tag
carries `dark:bg-slate-900`). A pinned cell needs a fully opaque background
for every state, so these translucent layers must be pre-blended into solid
hex colors ahead of time - reusing the raw Tailwind token (e.g. plain
`#1e293b`, i.e. `slate-800` alone) would be visibly lighter than the actual
composited table background and create a seam at the pinned-column boundary.
Computed composites (Tailwind slate-800 = `rgb(30,41,59)`, slate-900 =
`rgb(15,23,42)`, slate-700 = `rgb(51,65,85)`, and the existing
`.selected-row` dark rule `rgba(30,64,175,.22)`, all from `index.html` lines
30-52):

| State | Source rule | Composited over | Solid result |
| --- | --- | --- | --- |
| Default (dark) | `slate-800` at 50% (card bg) | `slate-900` (body) | `#172033` |
| Row hover (dark) | `slate-700` at 30% (`dark:hover:bg-slate-700/30`, line 903) | `#172033` default | `#1f2a3d` |
| Row selected (dark) | `.dark .selected-row` = `rgba(30,64,175,.22)` (line 52) | `#172033` default | `#19274e` |
| Default (light) | card bg is solid `bg-white` | - | `#ffffff` |
| Row hover (light) | `hover:bg-slate-50` (solid, line 903) | - | `#f8fafc` |
| Row selected (light) | `.selected-row` = `#eff6ff` (solid, line 51) | - | `#eff6ff` |

The light-theme values are already solid (no `rgba`/opacity involved in the
light styling of `hover:bg-slate-50`, `.selected-row`), so only the three
dark-theme values needed blending.

### CSS to add

Add this block to `index.html`, inside the existing `<style>` tag, right
after the existing `#table-scroll{overscroll-behavior:contain}` rule (around
line 87):

```css
    /* Pinned catalog columns (Use + Ticker). Sticky is applied directly to
       the th/td, never to a nested wrapper - a nested wrapper's containing
       block is its own (non-sticky) parent cell, so it would stop pinning
       the moment that parent cell scrolls out of view. */
    #table-scroll table{min-width:max-content;border-collapse:separate;border-spacing:0;isolation:isolate}
    #table-scroll tbody{position:relative;z-index:0}
    #table-scroll tbody tr{position:relative;z-index:0}
    #table-scroll .catalog-sticky-col{position:sticky;background:#fff;background-clip:padding-box}
    #table-scroll thead .catalog-sticky-col{top:0;z-index:30}
    #table-scroll tbody .catalog-sticky-col{z-index:20}
    #table-scroll .catalog-sticky-use{left:0;width:5rem;min-width:5rem}
    #table-scroll .catalog-sticky-ticker{left:5rem;width:6rem;min-width:6rem;box-shadow:4px 0 6px -6px rgba(15,23,42,.7)}
    .dark #table-scroll .catalog-sticky-col{background:#172033}
    #table-scroll tbody tr:hover .catalog-sticky-col{background:#f8fafc}
    #table-scroll tbody tr.selected-row .catalog-sticky-col{background:#eff6ff}
    .dark #table-scroll tbody tr:hover .catalog-sticky-col{background:#1f2a3d}
    .dark #table-scroll tbody tr.selected-row .catalog-sticky-col{background:#19274e}
```

`.catalog-sticky-col` / `.catalog-sticky-use` / `.catalog-sticky-ticker` are
plain classes scoped only to cells that opt in - not `:nth-child()` selectors
scoped to `#table-scroll` - because that container is reused by the
Watchlist, Holdings, History, Overview, and Distributions tables
(`renderSheetTable`, `renderOverviewTable`, `renderDistributionsTable`,
etc.), none of which have pinned columns of their own. A positional selector
would silently reach into those tables too.

### Markup changes in `app.tsx`

**1. `useHeader()`** (line 829) - add the two sticky classes to the existing
`<th>`:

```ts
    function useHeader(): string {
      const candidates = visibleFunds();
      const allSelected = candidates.length > 0 && state.selected.size === candidates.length;
      return `<th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(getHeaderTooltip('Use'))}">
        <div class="inline-flex items-center justify-center gap-1">
          <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
          <span>Use</span>
        </div>
      </th>`;
    }
```

**2. `sortHeader()`** (line 817) - add an optional fourth parameter so the
Ticker header (the only sorted column that also needs to be pinned) can carry
the sticky classes without a one-off duplicate of the whole function:

```ts
    function sortHeader(label: string, key: string, numeric = false, stickyClass = ''): string {
      const active = state.sortKey === key;
      const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
      const align = numeric ? ' text-right' : '';
      const tooltip = getHeaderTooltip(label);
      const sticky = stickyClass ? `${stickyClass} ` : '';
      return `<th class="${sticky}py-3.5 px-4${align}" title="${escapeHtml(tooltip)}"><button data-sort="${escapeHtml(key)}" title="${escapeHtml(tooltip)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(label)}${arrow}</button></th>`;
    }
```

Then update the Ticker call in `renderFundsTable()` (line 870):

```ts
          ${sortHeader('Ticker', 'ticker', false, 'catalog-sticky-col catalog-sticky-ticker w-24 min-w-24')}
```

Leave every other `sortHeader(...)` call in the file unchanged - the new
fourth parameter defaults to `''` so no other column is affected.

**3. Body cells** - in `renderFundsTable()`'s row template, add the sticky
classes and matching widths to the Use and Ticker `<td>`s (lines 905 and
911):

```ts
              <td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 w-20 text-center">
                <div class="inline-flex items-center justify-center gap-1.5">
                  <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected ? 'checked' : ''} class="w-4 h-4 accent-blue-600" aria-label="Use ${escapeHtml(fund.ticker)}" />
                  <button data-blacklist="${escapeHtml(fund.ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(fund.ticker)} — hide it from All ETFs">✕</button>
                </div>
              </td>
              <td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 w-24 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(fund.ticker)}</td>
```

Every other `<td>` in this row template (Fund Name onward, including the new
Frequency cell from section 1) is untouched - same padding/typography
classes as today, no wrapper element, no negative margins. The only visual
difference for a pinned cell versus an ordinary one is the sticky
positioning, background, z-index, and (for Ticker) the boundary shadow.

### Why the checkbox and blacklist button keep working

No overlay is placed above the pinned cells; `position: sticky` does not
remove elements from normal event flow, so `data-checkbox` and
`data-blacklist` click handlers (already bound elsewhere in `app.tsx`,
delegated on `el.tableBody`) keep working after horizontal scroll with no
further changes.

---

## Acceptance checklist

- [ ] `Frequency` column header appears in the catalog between `SEC Yield`
      and `YTD Return`, sortable via `distFrequency`.
- [ ] Values render as `01 - Monthly`, `04 - Quarterly`, `06 -
      Semi-annually`, `12 - Annually`, `00 - Unknown`, `00 - None`, `00 -
      —`, or `99 - Irregular`, matching the current 6 distinct raw values
      seen in `api/fidelity/index.json` (`Monthly`, `Quarterly`,
      `Semiannually`, `Annually`, `Unknown`, `None`) plus the `Irregular` and
      placeholder `—` cases.
  - [ ] Sorting the column ascending/descending groups by cadence, not
      alphabetically (verifies the numeric prefix works).
  - [ ] The header tooltip (hover, native `title`) names the Yahoo
      dividend-history feed and lists the numeric codes.
  - [ ] CSV export and TXT export both include a `Frequency` column in the
      same position with the same coded value as the on-screen cell.
  - [ ] The Overview detail tab's `Frequency` row (under Distributions)
      still shows the raw label (e.g. `Quarterly`), unchanged.
  - [ ] The "no rows match your search" placeholder still spans the full
      row width (`colspan="25"`).
- [ ] `Use` and `Ticker` columns stay visible when scrolling `#table-scroll`
      all the way to the right, verified in an actual (or headless)
      browser, not just by reading the CSS.
  - [ ] The `#` row-number column is not pinned and scrolls away normally.
  - [ ] `Use` sits at `left: 0`, `Ticker` at `left: 5rem`, both cells have
      explicit `width`/`min-width` matching those offsets.
  - [ ] Scrolling right, no other column's text is visible bleeding through
      a pinned cell, in either theme, on a hovered row, and on a selected
      row.
  - [ ] Scrolling down and right at the same time, the sticky header cell
      for `Use`/`Ticker` stays above the sticky body cells of rows
      scrolling underneath it.
  - [ ] The checkbox, blacklist button (`✕`), and ticker text remain
      clickable/readable after scrolling right.
  - [ ] The Watchlist, Holdings, History, Overview, and Distributions tables
      (all rendered into the same `#table-scroll`) are visually unaffected -
      no stray sticky columns, no leaked `.catalog-sticky-*` styling.
  - [ ] Existing behavior is preserved: sticky header-on-top-scroll, lazy
      sheet loading, search, sorting, row selection/highlight, dark theme
      toggle (`fidelity-theme` in `localStorage`).

## Handoff summary

Fidelity has no pinned columns today (from-scratch addition) and no catalog
Frequency column today (gap, though the underlying `fund.distributions
.frequency` data and its Overview-tab display already exist). Both features
touch only `renderFundsTable()`, `normalizeFundRow()`, `sortHeader()`,
`useHeader()`, `COLUMN_TOOLTIPS`, and the fallback branch of
`currentExportRows()` in `app.tsx`, plus one new CSS block in `index.html`'s
`<style>` tag. The frequency column is a small, low-risk insertion between
two already-adjacent columns. The pinned-column CSS carries the real risk:
its dark-mode backgrounds must be the pre-blended opaque hex values above
(`#172033` / `#1f2a3d` / `#19274e`), not the raw Tailwind slate token, and
the `<table>` element's existing `border-collapse` Tailwind class must be
overridden via the `#table-scroll table{border-collapse:separate}` ID rule.
Verify the pinned columns by actually scrolling to the far right in a
running browser before calling this done.
