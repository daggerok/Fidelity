# Fidelity — UI parity plan

Full rationale, exact CSS values, and pitfall catalog: read
`/tmp/etf-ui-parity-plan.md` (master plan) in full before starting — this
document is the Fidelity-specific action list, it does not repeat the
reasoning. Fidelity's own `docs/catalog-ui-requirements.md` already has a
written, line-numbered spec for the Frequency column and the catalog sticky
columns — read it, it's correct except one missing CSS rule (below). This
repo's code is structurally a near-identical twin of Invesco's.

## 1. Already implemented — verify, don't redo

`state.queryByTab` (per-tab search/filter persistence, master plan §5.2) is
already implemented — grep `queryByTab` in `app.tsx` to find it. Verify it
still works correctly (switch tabs with different queries, reload, confirm
independence) but do not reimplement it.

## 2. Follow the existing doc, with one fix

- Distribution/Dividend Frequency catalog column — `docs/catalog-ui-requirements.md`
  §1 (or equivalent section), follow as written. Insert between SEC Yield and
  YTD Return, coded label scheme (`01 - Monthly` etc., master plan §3),
  update tooltips/colspan/export.
- Pinned catalog Use+Ticker columns — that doc's CSS block is correct except
  it's **missing the sticky-header background rule**. Find:
  ```css
  #table-scroll thead .catalog-sticky-col{top:0;z-index:30}
  ```
  and add `background:#f8fafc` (light) plus a
  `.dark #table-scroll thead .catalog-sticky-col{background:#0f172a}` rule —
  otherwise the pinned header cell mismatches the rest of the header row
  (master plan §2.5/§4.1). The rest of that doc's colors are correct
  (Fidelity uses the common `dark:bg-slate-900`/`dark:bg-slate-800/50`/
  `dark:hover:bg-slate-700/30`/`rgba(30,64,175,.22)` stack — canonical values:
  base `#172033`, hover `#1f2a3d`, selected `#19274e`). Size the Ticker
  column's `left`/`width` by rendering the table and checking the longest
  real ticker doesn't clip.

## 3. Not covered by the existing doc — implement fresh

- **Pinned Watchlist Ticker column.** Not in the existing doc. Add
  `.watchlist-sticky-ticker` (or the two-class split, see master plan §4.1)
  with the same CSS shape/colors as the catalog pin, including its own
  explicit header-background rule (don't repeat the same missing-rule bug
  from §2 here). Find the Watchlist table's header/row builder (grep
  `renderWatchlistTable` and its Ticker `sortHeader(...)` call) and add the
  sticky class on the `<th>`/`<td>` directly, never a wrapper.
- **Per-tab sort memory (master plan §5.3).** Not implemented — no
  `sortByTab` in `app.tsx`. Add: `state.sortByTab: Record<ActiveTab,
  {key, dir}>`, a `fidelity-tab-sorts` localStorage key,
  `applySortForTab()`/`rememberSortForCurrentTab()` functions (tab switch /
  explicit header click respectively), and confirm no other control (Clear,
  blacklist, exports, theme toggle) mutates sort state as a side effect.
- **Selection scopes (master plan §5.4).** Verify the three scopes are
  correctly distinct: row toggle, catalog header "select all" (current tab +
  filter + blacklist exclusion, `.every()`-based), "All ETFs" pill (entire
  non-blacklisted catalog, any tab, no navigation).
- **Race-free Watchlist aggregation + chunked rendering + dedup fallback
  order (master plan §5.5-§5.8).** Read
  `/Users/maksim.kostromin/Documents/code/private/WisdomTree/docs/ui-contract.md`
  §6-§9 for the mechanism (per-ticker serialized load chain, capped
  concurrency, chunked rendering with a "load more" sentinel, dedup fallback
  ticker→CUSIP→ISIN→Identifier→SEDOL/FIGI→name with placeholder detection).
  Adapt to Fidelity's own fetch/state code and field names. Note Fidelity has
  extra data scripts (`held-tickers.ts`, `fidelity-funds.ts`) — irrelevant to
  this UI work, don't touch them.
- **Blacklist panel smooth expand/collapse (master plan §6).** Fidelity
  already has the `#selected-tabs-panel.is-visible` animation contract for
  the detail-tabs panel (per repo audit) — reuse that same max-height/
  opacity/transform/padding/border-color transition shape for
  `#blacklist-panel` (JS-measured `scrollHeight` instead of a fixed rem value
  since the chip list is unbounded). Remove the `hidden` utility class,
  change `p-4`→`px-4`, swap the JS toggle to `classList.toggle('is-visible')`
  + a `syncBlacklistPanelHeight()` helper called at the end of whatever
  re-renders the blacklist chips.

## 4. Implementation order

Frequency column → sticky columns (catalog then Watchlist) → shared UI
contract (sort memory, selection scopes, race-free Watchlist, chunked
rendering) → blacklist animation (independent, any time).

## 5. Verification checklist

- Run `bun test` if a test script exists.
- Real/headless browser: scroll catalog and Watchlist tables fully right in
  both light and dark theme — pinned columns stay opaque, no bleed-through,
  header cell matches header row color.
- Switch tabs with different search queries and sorts, reload, confirm both
  are independently remembered per tab.
- Exercise all three selection scopes, confirm each behaves as specified.
- Select many ETFs rapidly and confirm the Watchlist count/aggregate ends up
  correct with no duplicate/missing rows.
- Open/close the Blacklist panel — animates smoothly; add/remove a
  blacklisted ticker while open — panel resizes smoothly.
