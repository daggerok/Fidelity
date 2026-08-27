# Fidelity

Fidelity ETF holdings to Watchlist. A single-file client-side tool that reads the generated `./api/fidelity` static feed (SEC EDGAR N-PORT-P holdings, Yahoo Finance daily history and distributions) into a searchable ETF/category catalog with per-fund tabs, watchlist aggregation, ticker copy and CSV/TXT export — the same look and feel as the sibling applications.

## Shared UI contract

The common interaction and data-state rules are documented in [`docs/ui-contract.md`](./docs/ui-contract.md). New provider-specific behavior should preserve this contract.

## Sibling applications

| Application | Data provider | Repository |
| --- | --- | --- |
| Amplify ETF Holdings to Watchlist | Amplify ETFs (Firestore data feed) | [daggerok/Amplify](https://github.com/daggerok/Amplify) · [published app](https://daggerok.github.io/Amplify/) |
| iShares Excel .xls to Watchlist | iShares (BlackRock) product workbooks | [daggerok/iShares](https://github.com/daggerok/iShares) · [published app](https://daggerok.github.io/iShares/) |
| SPDR ETF Holdings to Watchlist | SSGA / State Street public feeds | [daggerok/SPDR](https://github.com/daggerok/SPDR) · [published app](https://daggerok.github.io/SPDR/) |
| Fidelity ETF Holdings to Watchlist | SEC EDGAR N-PORT-P + Yahoo Finance | [daggerok/Fidelity](https://github.com/daggerok/Fidelity) · [published app](https://daggerok.github.io/Fidelity/) |

## Using Bun

```
bunx degit daggerok/Fidelity#main ./12345 && cd $_
bunx serve . -p 1234
open http://0:1234
```

The published application is available at [https://daggerok.github.io/Fidelity/](https://daggerok.github.io/Fidelity/).

## Updating the static Fidelity data

Run the updater with Bun:

```
bun test scripts/update-data.test.ts
./scripts/update-data.ts
```

`./scripts/update-data.ts --backfill-tickers` re-stamps real exchange tickers from the
`scripts/held-tickers.ts` seed into already generated holdings data without any network
access (use it right after the ticker seed grows).

Run `./scripts/update-data.ts -h` (or `--help`) to print every configuration variable with its default and usage examples.

The **Update Fidelity ETF data** GitHub Actions workflow exposes the same settings as manual inputs. All supplied filters use **AND** logic.

### Data sources

Fidelity publishes no public fund-data API (the retired `screener.fidelity.com` CSV downloads now redirect to a login-walled SPA), so this feed is built from two fully public sources:

| Block | Source |
| --- | --- |
| Catalog + holdings + net assets | SEC EDGAR **Form N-PORT-P** filings of the Fidelity ETF trusts: [Fidelity Covington Trust](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000945908&type=NPORT-P) (equity ETFs), [Fidelity Merrimack Street Trust](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001562565&type=NPORT-P) (bond ETFs), plus the Fidelity Wise Origin Bitcoin Fund (FBTC) and Fidelity Ethereum Fund (FETH) registrants |
| History (daily close / adjusted close), NAV, distributions, inception | Yahoo Finance public chart API (`/v8/finance/chart/{TICKER}?range=max&interval=1d&events=div`) |
| Ticker ↔ series seed (`scripts/fidelity-funds.ts`) | EDGAR submissions + N-CEN verified once against Yahoo (instrumentType, longName, firstTradeDate, expense ratio) |
| Holding tickers (`scripts/held-tickers.ts`) | Name → ticker seed: SEC EDGAR `company_tickers.json` + Nasdaq / NYSE / NYSE American symbol directories, extended live by the Yahoo Finance symbol search (strict name match; new mappings are written back into the seed) |

Each N-PORT document provides the fund's legal name, series ID, report period and every position (`name`, `cusip`/`identifier`, `balance`, `valUSD`, `pctVal`, `assetCat`). Net Assets are the sum of reported position values. SEC access requires a **declared User-Agent** (see `SEC_UA`); the updater keeps at most 10 requests/second with `REQUEST_SLEEP` and bounded retries.

Known value limitations (documented honestly, like the sibling feeds):

- **Holdings cadence is quarterly-ish, not daily** — N-PORT-P filings appear roughly 60 days after each quarter end (some series file monthly). The *Holdings As Of* column always shows the N-PORT report period.
- **YTD / TR / CAGR returns are derived from adjusted market-price closes** (Yahoo), *not* official NAV total returns. Multi-year cumulative TR columns are derived exactly as `(1 + CAGR nY)^n − 1`.
- **SEC Yield (30-day)** — no source; shown as `—`.
- **Dividend Yield** is *indicated*: latest distribution × inferred payments per year ÷ market price.
- **Expense Ratio** comes from the verified seed (Yahoo fund profiles at build time); 8 funds (mostly 2026 launches) have no published profile yet and show `—`.
- **FBTC / FETH file no N-PORT** (commodity-fund registrants): they are full catalog entries with history and distributions, but no holdings.
- N-PORT positions publish **no exchange tickers**, so the updater resolves them: each holding name is matched against the `scripts/held-tickers.ts` seed (SEC EDGAR company tickers + exchange symbol directories), and names the seed does not cover yet are resolved live through the Yahoo Finance symbol search with a strict name match — new mappings are persisted into the seed. Positions without an exchange ticker (bonds, private CLO/ABS debt, SPVs) keep `Ticker: "-"` and are identified by CUSIP/ISIN (`Identifier`); the Watchlist deduplicates by `Ticker` when present, falling back to `Identifier` — the same convention as SPDR bond funds.
- **Fidelity mutual funds are out of scope** (FNILX and the ZERO funds are not ETFs).

### Update controls

| Environment variable | Default | Meaning |
| --- | --: | --- |
| `MAX_FETCHES` | all | Maximum eligible fund update attempts per run. With a positive value, the updater continues after the committed cursor in `api/fidelity/update-state.json`; empty or `0` means all. The legacy `FIDELITY_LIMIT` name remains supported. |
| `REQUEST_SLEEP` | `1` | Minimum delay in seconds between outgoing request starts, including retries. Decimal values are accepted. SEC allows 10 req/s; Yahoo throttles hard — keep ≥ 1. |
| `CONCURRENCY` | `2` | Number of parallel fund update workers. Request starts are still globally spaced by `REQUEST_SLEEP`. |
| `AUM` | `:` | Net Assets range. Each bound may be a USD amount or `nano`, `micro`, `small`, `mid`, or `large` (whole-value presets). Evaluated against previously published values. |
| `TER` | `:` | Expense ratio range in % (strict `min:max`). |
| `DIVIDEND_YIELD` | `:` | Indicated dividend-yield percentage range. |
| `PERFORMANCE_YTD` … `PERFORMANCE_10Y` | `:` | Annualized market-price return ranges (YTD, 1Y, 3Y, 5Y, 10Y). |
| `TOTAL_RETURN_YTD` … `TOTAL_RETURN_10Y` | `:` | Cumulative market-price return ranges. |
| `TICKERS` | all | Space-, comma-, or semicolon-separated ticker allowlist, for example `FDIS FTEC FBTC`. |
| `HOLDINGS_PAGE_SIZE` | `250` | Rows in each generated current-holdings JSON page. |
| `HISTORY_PAGE_SIZE` | `1000` | Rows in each generated daily-history JSON page. `HISTORICAL_PAGE_SIZE` remains supported as an alias. |
| `STORE_RAW_DOWNLOADS` | off | Store the source N-PORT XML under `api/fidelity/raw`. Values `1`, `true`, `yes`, `y`, and `on` enable it. The legacy `FIDELITY_STORE_RAW_DOWNLOADS` name remains supported. |
| `HISTORY_RANGE` | `max` | Yahoo chart range for history rows (`max`, `10y`, `5y`, …). |
| `MAX_RETRIES` | `2` | Retries after the initial request. Only network errors and HTTP 403/408/425/429/5xx responses are retried with bounded exponential backoff. |
| `SEC_UA` | declared UA | Override the SEC User-Agent. SEC policy requires automated tools to declare a contact. |
| `SKIP_YAHOO` | off | Update EDGAR holdings only, keeping previously published history. |
| `REFRESH_CATALOG` | on | Scan EDGAR submissions for N-PORT filings newer than the seed accessions and pick them up automatically. |

`TICKERS` combines with AUM, TER, dividend-yield and return filters using AND logic; it does not override them. Funds not selected for a successful update keep their prior published metadata and data files.

### Resuming bounded runs

A positive `MAX_FETCHES` is a batch size, not a permanent first-page limit. Eligible funds are processed in alphabetical ticker order, and the cursor in `api/fidelity/update-state.json` remembers where the last run stopped; the next run continues after it and wraps around at the end.

### Strict range syntax

All range variables use `min:max` — both bounds are inclusive and optional, but the **colon is required**: `15:`, `:0.5`, `0.1:0.5`, `:`. A missing colon is an error (this strictness matches the sibling repos). Percent and dollar signs are optional.

### AUM ranges and presets

Bounds accept plain USD amounts or `K`/`M`/`B`/`T` suffixes (`10M:2B`). A whole value may be one of the size presets: `nano` (< $10M), `micro` ($10M–$300M), `small` ($300M–$2B), `mid` ($2B–$10B), `large` (> $10B).

### Return ranges

`PERFORMANCE_*` filters match annualized figures (CAGR for multi-year periods), `TOTAL_RETURN_*` filters match cumulative ones — the same pairing the sibling apps expose. Values come from adjusted market-price closes.

### Examples

```
MAX_FETCHES=10 ./scripts/update-data.ts
TICKERS="FDIS FTEC" ./scripts/update-data.ts
AUM="1B:" TER=":0.5" ./scripts/update-data.ts
PERFORMANCE_1Y="15:" ./scripts/update-data.ts
STORE_RAW_DOWNLOADS=1 ./scripts/update-data.ts
SKIP_YAHOO=1 ./scripts/update-data.ts
```

## Uploading N-PORT files in the browser

The header toolbar includes the same integrated drag-and-drop upload as `daggerok/iShares`, N-PORT flavored: drop or pick a **Form N-PORT-P `primary_doc.xml`** (any Fidelity ETF filing from EDGAR) and the app parses it entirely in your browser — no network — merging the fund (and overriding its holdings when the ticker is already in the feed) into the catalog, detail tabs and Watchlist. Uploads live for the current browser session only.

## Developer notes

- `scripts/update-data.ts` — Bun updater, zero runtime dependencies (`node:fs/promises` + `fetch` only): EDGAR submissions scan, N-PORT XML reader (in the same hand-rolled spirit as SPDR's ZIP/OOXML workbook reader), Yahoo chart reader, derived-metric helpers (`annualizedToTotal`, `totalToAnnualized`, `indicatedYield`, `priceReturns`, `inferDistributionFrequency`), strict range parsers, bounded-run cursor, retries with 403/429 back-off, deterministic content-only writes.
- `scripts/fidelity-funds.ts` — the verified seed: ticker ↔ SEC seriesId ↔ trust CIK map with categories, accessions, inceptions, exchange names and expense ratios.
- `scripts/update-data.test.ts` — `bun test` suite: range parsers, N-PORT fixtures (equity, N/A-CUSIP fallback, empty body), chart fixtures (null closes, adjusted closes, dividend ordering), price-return derivations incl. young-fund nulls, quarter anchoring, catalog metric derivations.
- `api/fidelity/**` — the generated static feed: `index.json`, `funds/{TICKER}/meta.json`, paginated `holdings/` + `history/` pages, `update-state.json`.
- Verification before every publish — Bun only, no tsconfig (same as daggerok/iShares and daggerok/SPDR): `bun install --frozen-lockfile`, `bun test`, the inline `bunx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler --types bun,node --skipLibCheck scripts/update-data.ts scripts/update-data.test.ts` type-check, `node --check` on the transpiled inline script, jsdom e2e against the real feed.

## TypeScript

The browser app is intentionally single-file: `index.html` contains inline TypeScript compiled in the browser with Babel standalone, following the `daggerok/youtube` no-src-files approach (same as daggerok/Amplify and daggerok/SPDR).

## Brands table

| Бренд | Фонды | Где брать данные |
|---|---|---|
| **Fidelity** (5) ✅ | FTEC, FDVV, FDIS, FCOM + весь каталог Fidelity ETF (~74) | [fidelity.com/etfs](https://www.fidelity.com/etfs) · holdings: [SEC EDGAR N-PORT](https://efts.sec.gov/LATEST/search-index?q=%22fidelity%22&forms=NPORT-P) — весь каталог Fidelity ETF уже интегрирован в наше приложение [daggerok/Fidelity](https://github.com/daggerok/Fidelity) |
| **SPDR / State Street** ✅ | SPYM, SPYG, SPYD, SDY, XLK, XLF… | [daggerok/SPDR](https://github.com/daggerok/SPDR) — весь каталог SSGA (179 фондов) |
| **iShares / BlackRock** ✅ | IVV, SGOV, DGRO, SOXX… | [daggerok/iShares](https://github.com/daggerok/iShares) — весь каталог, XLS-экспорт |
| **Amplify** ✅ | DIVO, IDVO, SILJ… | [daggerok/Amplify](https://github.com/daggerok/Amplify) — Firestore-фид данных |

*FNILX и прочие фонды ZERO — взаимные фонды, а не ETF, и в приложение не входят.

## Brands list

#	Бренд	Фонды из списка (кол-во)	Официальный сайт / страницы фондов
1	Fidelity — 5 ✅	FTEC, FDVV, FDIS, FCOM (FNILX* не ETF)	https://www.fidelity.com/etfs · holdings: SEC EDGAR N-PORT (Fidelity Covington Trust CIK 0000945908, Fidelity Merrimack Street Trust CIK 0001562565) — весь каталог Fidelity ETF (~74 фонда) уже интегрирован в наше приложение https://github.com/daggerok/Fidelity
