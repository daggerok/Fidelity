# Fidelity parity recheck

Rechecked against the full UI parity plan, Fidelity catalog plan, and static-data
plan on 2026-09-19. This audit supersedes the earlier claim of complete parity.
Scope: Fidelity only; no sibling repository or generated feed was modified.

## Gaps found and corrected

- Clear incorrectly erased sort memory. It now preserves all remembered sorts.
- Legacy filter storage had not migrated; added `fidelity-tab-filters`, site-state
  filter mirror/active-tab restore, sanitized migration, and one-click search clear.
- All ETFs pill checked state used counts instead of membership; now `.every()`.
- Detail paging bypassed the background load serialization. Both now share a
  per-ticker page queue; metadata requests are deduplicated, background workers
  remain bounded, errors are isolated/retryable, and uploads win over stale loads.
- Watchlist lacked progressive loading labels outside its own tab and aggregation
  memoization. Added both, plus selected-count/clickable fund badges.
- Dedupe lacked namespaces and several placeholder cases. Added tiered identity
  while retaining numeric ticker codes, ticker-less holdings and zero weights.
- Blacklist collapse now starts immediately rather than waiting for inline-height
  cleanup before beginning its max-height transition.
- Static writers compared run timestamps as content. Timestamp-only changes no
  longer rewrite index/cursor files; actual data and cursor changes still write.

## Verification

- `bun run test`: **60 passed**, including 10 new UI logic regressions and a
  timestamp-only write regression (existing updater tests remain green).
- Headless Chromium: **100 checks passed** across six suites: frequency and
  CSV/TXT parity, independent filters/sorts with reload, selection scopes,
  catalog/Watchlist full-right scroll in light/dark, header/body stacking,
  no pin leakage to detail tables, chunks, identifier fallbacks, rapid multi-fund
  selection with independently recomputed counts/weights, blacklist animation,
  reduced motion, search clear, active-tab restoration, badges and loading labels.
- Negative control: making catalog pins transparent exposes magenta probes in
  scrolled-behind cells in both themes; opaque pins completely occlude them.
- Static feed integrity: **74 funds, 286 pages, 22,962 holdings rows, 109,252
  history rows**; manifest page sizes/counts, catalog totals and index totals agree.
- No live SEC/Yahoo update was run; upstream availability was not verified.

## References / adaptations

The supplied macOS sibling paths are unavailable in this sandbox. Current
`daggerok/WisdomTree/app.tsx` and its full `docs/ui-contract.md` were retrieved
through GitHub for the storage, loader, badge and identity mechanisms.
Fidelity uses the existing SEC/Yahoo pipeline and generic Identifier column;
no separate CUSIP/ISIN feed columns or missing SEC-yield data were invented.
The newer master plan intentionally adds a Watchlist pin beyond the older
catalog-only plan. Canonical Fidelity colors and existing frequency work were
retained rather than reimplemented.

Browser tooling and screenshots were session-local (`/tmp/pwtest`); permanent
logic regressions are in `scripts/ui-parity.test.ts` and run via `bun run test`.
