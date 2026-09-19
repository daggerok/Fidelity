# ETF Watchlist UI contract

The provider applications share this interaction contract so users do not need to learn a different workflow for each data source.

## Catalog

- Search placeholder: `Search ETFs, fund names, holdings, tickers, CUSIPs, ISINs...`
- Opening the application starts with no funds selected. The user explicitly chooses funds for comparison.
- `All ETFs` and category tabs filter the catalog; they do not change the saved selection.
- Catalog columns use the common order documented in the README and preserve unavailable provider metrics as `—`.

## Selection and watchlist

- Selection is persisted per provider in `localStorage`.
- Header `Use` selects the current category/filter, excluding blacklisted funds; the `All ETFs` pill selects the entire non-blacklisted catalog without navigating. Both checked states use `.every()` over their own scope.
- The Watchlist tab aggregates holdings across selected funds and exposes the number of selected ETFs holding each security.
- Blacklisting is persisted per provider and removes a fund from the catalog and selection until restored.

## Data states

The UI distinguishes loading, unavailable, and not-applicable values. A provider limitation must be explained in a tooltip or the fund's data-provenance panel; an em dash must not imply that a request is still loading.

Each fund detail view should identify:

- source provider and URL;
- holdings and history as-of dates;
- whether returns are NAV total return or adjusted market-price return;
- whether a yield is trailing, indicated, distribution-derived, or SEC yield;
- known freshness or coverage limitations.

## Detail navigation

Provider-specific data may be unavailable, but the target information architecture is:

`Overview` · `Holdings` · `History` · `Performance` · `Allocations` · `Distributions` · `Yields` · `Price`

When a provider does not publish a dataset, retain the navigation entry and explain the limitation rather than silently changing the product layout.

## Accessibility baseline

Interactive controls should have an accessible name, active tabs should expose `aria-selected`, sortable headers should expose `aria-sort`, and loading/error status changes should be announced to assistive technology. Keyboard focus and reduced-motion preferences must remain visible/respected.

## Persistent per-tab state

- `fidelity-tab-filters` stores non-empty per-tab filters; `fidelity-searches`
  remains a read-only migration source. A present new map takes precedence,
  including an empty map, so cleared filters cannot reappear on reload.
- `fidelity-site-state` remembers `activeTab` and mirrors filters as `sheetFilter`.
- `fidelity-tab-sorts` stores only explicit header choices. Switching/reloading
  restores the tab's sort; Clear removes selection and filters, **not sorts**.
- The search-field × clears only the current tab and refocuses the input.

## Watchlist loading and identity

- Detail paging and background loading share a serialized per-ticker queue.
  Background runs are serialized and use at most four concurrent fund workers.
  Navigation never discards an already fetched cache page; uploads supersede
  in-flight feed requests. Failed funds show an incomplete label and can retry
  when Watchlist is reopened.
- The Watchlist tab progresses from `Loading…` to `N+` to an exact count, even
  while viewing the catalog. Selected-count/ticker badges update immediately;
  badges in the subtitle and Watchlist open the selected fund's detail view.
- Identity uses ticker → CUSIP → ISIN → Identifier/Security ID → SEDOL/FIGI →
  name, skipping placeholders, with namespaced keys to avoid cross-tier
  collisions. Fidelity's feed currently has only the generic Identifier field;
  optional separate identifier columns do not require fabricated feed data.
- Aggregation is cached by selected funds, cache-entry identity and row counts.
  Rendering grows in 200-row chunks; exports and Copy Tickers use the full
  filtered result, independent of mounted rows.
- Catalog Use/Ticker and Watchlist Ticker are pinned on the cells themselves.
  Other detail tables have no pinned columns. Every pinned background is opaque,
  including hover/selection and headers in both themes.
