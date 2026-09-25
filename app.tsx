/**
 * @file Fidelity Watchlist Application
     * Client-side static feed viewer for api/fidelity/** with multi-ETF Watchlist
     * aggregation. Same single-file approach as daggerok/Amplify: the paginated
     * static API and lazy sheet loading follow daggerok/iShares.
     *
     * Babel standalone note: the inline pipeline strips type annotations, but it
     * does not accept every TypeScript-only expression. Follow the Amplify dev
     * style — plain `byId()` instead of DOM casts, no `as` casts, no non-null
     * `!`, no interfaces or enums.
     */

    // =========================================================================
    // 1. Types, constants & column tooltips
    // =========================================================================

    type ActiveTab = string;
    type SortDirection = 'asc' | 'desc';
    type TabSort = { key: string; dir: SortDirection };
    type TableRow = Record<string, unknown> & { searchIndex?: string };
    type TabInfo = { id: ActiveTab; label: string; count: number | string };

    type IndexFund = {
      ticker: string;
      name: string;
      category: string;
      fundPage: string;
      dataFile: string;
      ter: string;
      terValue: number;
      nav: string;
      navValue: number;
      aum: string;
      aumValue: number;
      asOfDate: string;
      inceptionDate: string;
      exchange: string;
      closePrice: string;
      premiumDiscount: string;
      distributions: { frequency: string; exDate: string; dividend: string };
      returns: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
      metrics?: {
        tr1y?: number | null;
        tr3y?: number | null;
        tr5y?: number | null;
        tr10y?: number | null;
        cagr3y?: number | null;
        cagr5y?: number | null;
        cagr10y?: number | null;
        siAnn?: number | null;
        dividendYield?: number | null;
        dividendYieldText?: string | null;
        secYield?: number | null;
      };
      holdings: number;
      history: number;
    };

    type FundRow = TableRow & {
      ticker: string;
      name: string;
      category: string;
      fundPage: string;
      ter: string;
      terValue: number;
      nav: string;
      navValue: number;
      aum: string;
      aumValue: number;
      asOfDate: string;
      inceptionDate: string;
      exchange: string;
      closePrice: string;
      premiumDiscount: string;
      ytd: number;
      yr1: number;
      yr3: number;
      yr5: number;
      yr10: number;
      si: number;
      tr3y?: number | null;
      tr5y?: number | null;
      tr10y?: number | null;
      cagr3y?: number | null;
      cagr5y?: number | null;
      cagr10y?: number | null;
      dividendYield?: number | null;
      secYield?: number | null;
      distFrequency?: string;
      returnAsOf: string;
      returns?: { monthEnd: Record<string, any>; quarterEnd: Record<string, any> };
      distributions?: { frequency: string; exDate: string; dividend: string };
      holdings: number;
      history: number;
    };

    type WatchlistRow = TableRow & {
      symbol: string;
      name: string;
      funds: string[];
      fundCount: number;
      weightSum: number;
      maxWeight: number;
      cusips: string[];
      identifier: string;
    };

    const INDEX_URL = './api/fidelity/index.json';
    const THEME_KEY = 'fidelity-theme';
    const SELECTED_KEY = 'fidelity-selected-etfs';
    const BLACKLIST_KEY = 'fidelity-blacklisted-etfs';
    const ACTIVE_FUND_KEY = 'fidelity-active-fund';
    const SEARCHES_KEY = 'fidelity-searches'; // read-only legacy migration
    const FILTERS_KEY = 'fidelity-tab-filters';
    const SITE_STATE_KEY = 'fidelity-site-state';
    const SORTS_KEY = 'fidelity-tab-sorts';
    const DEFAULT_SELECTED_TICKERS: string[] = []; // start clean: no pre-selected funds

    const DETAIL_TABS: Array<{ key: string; label: string }> = [
      { key: 'overview', label: 'Overview' },
      { key: 'holdings', label: 'Holdings' },
      { key: 'history', label: 'History' },
      { key: 'distributions', label: 'Distributions' },
    ];

    const NUMERIC_SHEET_HEADERS = ['Weight', 'Shares Held', 'Shares Outstanding', 'Total Net Assets', 'Par Value', 'Market Value', 'Coupon', 'NAV'];

    // Hover explanations for table headers. Native `title` tooltips, same pattern as daggerok/iShares.
    const COLUMN_TOOLTIPS: Record<string, string> = {
      '#': 'Row index in current table view.',
      Use: 'Use / Multi-ETF Selection — Check this box to include this ETF\'s underlying holdings in the combined Watchlist tab.',
      Ticker: 'Ticker Symbol — Unique stock market identifier. For holdings: the exchange ticker resolved from public SEC / exchange data at data-build time. "—" when the position has no exchange ticker (bond, private debt) — then the Identifier is the key.',
      'Fund Name': 'Fund Name — Official legal name of the Fidelity exchange-traded fund (ETF), as filed on Form N-PORT.',
      Category: 'Category — Fidelity ETF mandate family (Sector, US Equity, Factor, International, Thematic, Bond, Digital Assets).',
      Name: 'Security Name — Full registered legal name of the company or underlying financial asset.',
      Identifier: 'CUSIP / ISIN — Security identifier from the N-PORT filing. Positions without an exchange ticker (bonds, private debt) are identified in the Watchlist by this.',
      SEDOL: 'SEDOL — Stock Exchange Daily Official List identifier.',
      TER: 'Gross Expense Ratio — Total annual fund operating expenses as a % of assets.',
      NAV: 'NAV (Net Asset Value) — Per-share dollar value of the fund.',
      'Net Assets': 'Net Assets (AUM) — Total market value of all fund assets minus liabilities.',
      Weight: 'Weight — Position weight as a percentage of the fund\'s total net assets.',
      'Weight Sum': 'Weight Sum — Summed weight of this holding across all selected ETFs (%).',
      'Max Weight': 'Max Weight — Highest single-fund weight for this holding across selected ETFs (%).',
      '# ETFs': 'Number of selected ETFs that currently hold this security.',
      ETFs: 'Selected ETFs holding this security.',
      Type: 'Category — Fidelity ETF mandate family (Sector, US Equity, Factor, International, Thematic, Bond, Digital Assets). Same source as the category tabs.',
      Expense: 'Gross Expense Ratio — Total annual fund operating expenses as a % of assets.',
      'Dividend Yield': 'Dividend Yield (indicated) — Latest distribution per share x payments per year divided by market price, derived from Yahoo dividend history. Not a trailing-12-month yield.',
      'SEC Yield': 'SEC Yield (30-Day) — Not published in any public Fidelity data feed; shown as "—" (data limitation).',
      'YTD Return': 'YTD Return — Market-price total return since the start of the year, computed from adjusted closes (Yahoo). Not an official NAV return.',
      'TR 1Y': 'TR 1Y (1-Year Total Return) — NAV total return over the past year, including reinvested distributions.',
      'TR 3Y': 'TR 3Y (3-Year Total Return) — Cumulative market-price return over 3 years, derived exactly from the 3Y CAGR: (1 + CAGR 3Y)^3 - 1 (adjusted closes).',
      'TR 5Y': 'TR 5Y (5-Year Total Return) — Cumulative market-price return over 5 years, derived exactly from the 5Y CAGR: (1 + CAGR 5Y)^5 - 1 (adjusted closes).',
      'TR 10Y': 'TR 10Y (10-Year Total Return) — Cumulative market-price return over 10 years, derived exactly from the 10Y CAGR: (1 + CAGR 10Y)^10 - 1 (adjusted closes).',
      'CAGR 3Y': 'CAGR 3Y (3-Year Compound Annual Growth Rate) — Annualized market-price return over 3 years, computed from adjusted closes.',
      'CAGR 5Y': 'CAGR 5Y (5-Year Compound Annual Growth Rate) — Annualized market-price return over 5 years, computed from adjusted closes.',
      'CAGR 10Y': 'CAGR 10Y (10-Year Compound Annual Growth Rate) — Annualized market-price return over 10 years, computed from adjusted closes.',
      YTD: 'YTD market-price total return, last trading day (adjusted closes).',
      '1Y': '1-year NAV return, month-end series.',
      '3Y': '3-year average annual NAV return (CAGR), month-end series.',
      '5Y': '5-year average annual NAV return (CAGR), month-end series.',
      '10Y': '10-year average annual NAV return (CAGR), month-end series.',
      'SI Ann.': 'Since-inception annualized NAV return, month-end series.',
      'Return As Of': 'As-of date of the month-end return series.',
      Inception: 'Fund inception date.',
      Exchange: 'Primary listing exchange.',
      Close: 'Most recent closing market price.',
      'Prem/Disc': 'Premium / Discount — Closing price versus NAV (%).',
      Holdings: 'Rows in the fund\'s latest daily holdings file.',
      History: 'Rows in the fund\'s NAV history file.',
      'As Of': 'NAV / AUM as-of date.',
      Frequency: 'Distribution Frequency — Cadence inferred from the Yahoo dividend-history feed (inferDistributionFrequency() in scripts/update-data.ts), coded for sorting: 01 Monthly, 04 Quarterly, 06 Semi-annually, 12 Annually, 00 Unknown/None/—, 99 Irregular.',
      'Ex-Date': 'Ex-dividend date of the latest distribution.',
      Dividend: 'Latest dividend per share.',
      Coupon: 'Bond annual coupon rate (%).',
      Maturity: 'Bond maturity date.',
      'Market Value': 'Position market value in local currency.',
      Section: 'Section — Grouping of the overview metric (Fund, Cost, Price, Assets, Returns, Distributions, Holdings).',
      Metric: 'Metric — Overview metric name.',
      Value: 'Overview metric value.',
      Date: 'NAV history date.',
      'Shares Outstanding': 'Fund shares outstanding on that date.',
      'Total Net Assets': 'Fund total net assets on that date (USD).',
    };

    // =========================================================================
    // 2. DOM references, application state & lazy fund data
    // =========================================================================

    function byId(id: string): any {
      const element = document.getElementById(id);
      if (!element) throw new Error(`Missing element #${id}`);
      return element;
    }

    const dropzone = document.getElementById('dropzone');
    const dropzoneText = document.getElementById('dropzone-text');
    const fileInput = document.getElementById('file-input');

    const el = {
      themeToggle: byId('theme-toggle'),
      tickerCount: byId('ticker-count'),
      subtitle: byId('app-subtitle'),
      searchInput: byId('search-input'),
      searchClear: byId('search-clear-btn'),
      tabsBar: byId('tabs-bar'),
      selectedTabsPanel: byId('selected-tabs-panel'),
      selectedTabsBar: byId('selected-tabs-bar'),
      copyBtn: byId('copy-btn'),
      exportCsvBtn: byId('export-csv-btn'),
      exportTxtBtn: byId('export-txt-btn'),
      resetBtn: byId('reset-btn'),
      blacklistBtn: byId('blacklist-btn'),
      blacklistPanel: byId('blacklist-panel'),
      blacklistInput: byId('blacklist-input'),
      blacklistAddBtn: byId('blacklist-add-btn'),
      blacklistClearBtn: byId('blacklist-clear-btn'),
      blacklistChips: byId('blacklist-chips'),
      blacklistEmpty: byId('blacklist-empty'),
      tableHead: byId('table-head'),
      tableBody: byId('table-body'),
      tableScroll: byId('table-scroll'),
      staticLoadSentinel: byId('static-load-sentinel'),
      staticLoadStatus: byId('static-load-status'),
    };

    type AppState = {
      funds: FundRow[];
      selected: Set<string>;
      blacklist: Set<string>;
      activeTab: ActiveTab;
      activeFundTicker: string | null;
      queryByTab: Record<string, string>;
      sortByTab: Record<ActiveTab, TabSort>;
      sortKey: string;
      sortDir: SortDirection;
      generatedAt: string | null;
      counts: { funds: number; holdings: number; history: number } | null;
    };

    const state: AppState = {
      funds: [],
      selected: new Set(),
      blacklist: new Set(),
      activeTab: 'All',
      activeFundTicker: null,
      queryByTab: {},
      sortByTab: {},
      sortKey: 'rank',
      sortDir: 'asc',
      generatedAt: null,
      counts: null,
    };

    // Lazy per-fund data: meta.json plus accumulated sheet pages (iShares-style).
    type SheetEntry = {
      headers: string[];
      rows: string[][];
      nextPage: number;
      manifest: any;
      loading: boolean;
    };

    const fundMetaCache: Map<string, any> = new Map();
    const sheetState: Map<string, SheetEntry> = new Map();
    let sheetGeneration = 0;

    init();

    // =========================================================================
    // 3. Theme & small helpers
    // =========================================================================

    function applyTheme(dark: boolean): void {
      document.documentElement.classList.toggle('dark', dark);
      el.themeToggle.textContent = dark ? '☀️' : '🌙';
    }

    function escapeHtml(value: unknown): string {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
      }[char] || char));
    }

    function numberOrNull(value: unknown): number | null {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value !== 'string' || value.trim() === '' || value.trim() === '-') return null;
      const parsed = Number(value.replace(/[$,%\s,]/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    }

    function numberCell(value: unknown): string {
      const parsed = numberOrNull(value);
      return parsed === null ? '' : String(parsed);
    }

    function formatPercent(value: unknown): string {
      const parsed = numberOrNull(value);
      return parsed === null ? '—' : `${parsed.toFixed(2)}%`;
    }

    function formatInteger(value: unknown): string {
      const parsed = numberOrNull(value);
      return parsed === null || parsed === 0 ? '—' : parsed.toLocaleString('en-US');
    }

    function formatMoney(value: unknown): string {
      const parsed = numberOrNull(value);
      if (parsed === null) return '—';
      if (Math.abs(parsed) >= 1e12) return `$${(parsed / 1e12).toFixed(2)}T`;
      if (Math.abs(parsed) >= 1e9) return `$${(parsed / 1e9).toFixed(2)}B`;
      if (Math.abs(parsed) >= 1e6) return `$${(parsed / 1e6).toFixed(2)}M`;
      if (Math.abs(parsed) >= 1e3) return `$${(parsed / 1e3).toFixed(2)}K`;
      return `$${parsed.toFixed(2)}`;
    }

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

    function sanitizeTicker(value: unknown): string {
      return String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }

    function normalizeSearchText(value: string): string {
      return value.trim().toLowerCase();
    }

    function getHeaderTooltip(header: string): string {
      if (!header) return '';
      if (COLUMN_TOOLTIPS[header]) return COLUMN_TOOLTIPS[header];
      const clean = String(header).trim();
      const keys = Object.keys(COLUMN_TOOLTIPS);
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (key.toLowerCase() === clean.toLowerCase()) return COLUMN_TOOLTIPS[key];
      }
      return clean;
    }

    async function copyText(text: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the legacy path.
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }

    function downloadText(text: string, fileName: string, mime: string): void {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    }

    function toCsv(rows: string[][]): string {
      return rows
        .map(row => row.map(cell => {
          const value = String(cell ?? '');
          return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        }).join(','))
        .join('\n');
    }

    function exportFileName(scope: string, extension: string): string {
      const stamp = new Date().toISOString().slice(0, 10);
      return `fidelity-${scope.toLowerCase().replace(/\s+/g, '-')}-${stamp}.${extension}`;
    }

    function setStatus(message: string, tone: 'info' | 'success' | 'error'): void {
      console.debug(`[${tone}] ${message}`);
    }

    // =========================================================================
    // 4. Static API loading & paginated sheets (api/fidelity/**, iShares-style)
    // =========================================================================

    async function fetchJson(url: string): Promise<any> {
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response.json();
    }

    /** Flattens index.json month-end metrics onto the row so sorting works. */
    function normalizeFundRow(fund: IndexFund): FundRow {
      const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
      const metrics = fund.metrics || {};
      const row: any = {
        ...fund,
        ytd: monthEnd.ytd ?? null,
        yr1: metrics.tr1y ?? monthEnd.yr1 ?? null,
        yr3: monthEnd.yr3 ?? null,
        yr5: monthEnd.yr5 ?? null,
        yr10: monthEnd.yr10 ?? null,
        si: metrics.siAnn ?? monthEnd.sinceInception ?? null,
        tr3y: metrics.tr3y ?? null,
        tr5y: metrics.tr5y ?? null,
        tr10y: metrics.tr10y ?? null,
        cagr3y: metrics.cagr3y ?? monthEnd.yr3 ?? null,
        cagr5y: metrics.cagr5y ?? monthEnd.yr5 ?? null,
        cagr10y: metrics.cagr10y ?? monthEnd.yr10 ?? null,
        dividendYield: metrics.dividendYield ?? null,
        secYield: null, // Fidelity publishes no 30-day SEC yield feed.
        distFrequency: formatDistributionFrequency(fund.distributions && fund.distributions.frequency),
        returnAsOf: monthEnd.asOfDate ?? null,
        searchIndex: '',
      };
      row.searchIndex = [
        fund.ticker, fund.name, fund.category, fund.ter, fund.nav, fund.aum,
        fund.exchange, fund.inceptionDate, fund.asOfDate, monthEnd.asOfDate,
        fund.distributions && fund.distributions.frequency, metrics.dividendYieldText,
      ].map(value => String(value ?? '').toLowerCase()).join(' ');
      return row;
    }

    async function loadCatalog(): Promise<void> {
      setStatus('Loading Fidelity ETF data from api/fidelity/index.json…', 'info');
      const data = await fetchJson(INDEX_URL);
      state.funds = (data.funds || [])
        .map((fund: IndexFund) => normalizeFundRow(fund))
        .sort((a: FundRow, b: FundRow) => a.ticker.localeCompare(b.ticker));
      state.generatedAt = data.generatedAt || null;
      state.counts = data.counts || null;

      // A restored selection/blacklist must reference known funds only.
      state.blacklist = new Set([...state.blacklist].filter(ticker => state.funds.some(fund => fund.ticker === ticker)));
      state.selected = new Set([...state.selected].filter(ticker => state.funds.some(fund => fund.ticker === ticker) && !state.blacklist.has(ticker)));
      if (!state.activeFundTicker && state.selected.size) state.activeFundTicker = [...state.selected][0] || null;
      if (state.activeFundTicker && !state.selected.has(state.activeFundTicker)) {
        state.activeFundTicker = [...state.selected][0] || null;
      }

      el.searchInput.disabled = false;
      [el.copyBtn, el.exportCsvBtn, el.exportTxtBtn, el.resetBtn].forEach(button => { button.disabled = false; });
      applyRestoredTab();
      render();
      void ensureHoldingsForSelection();
      const activeTicker = state.activeFundTicker;
      if (activeTicker) {
        void loadFundMeta(activeTicker).then(meta => {
          if (meta && state.activeTab === 'detail:holdings') void ensureSheet('holdings', meta.holdings);
        });
      }
    }

    const metaInFlight = new Map<string, Promise<any>>();
    async function loadFundMeta(ticker: string): Promise<any> {
      if (metaInFlight.has(ticker)) return metaInFlight.get(ticker);
      const request = fetchFundMeta(ticker);
      metaInFlight.set(ticker, request);
      try { return await request; }
      finally { metaInFlight.delete(ticker); }
    }

    async function fetchFundMeta(ticker: string): Promise<any> {
      const cached = fundMetaCache.get(ticker);
      if (cached) return cached;
      const known = state.funds.find(fund => fund.ticker === ticker);
      if (known && !known.holdings && !known.history) return null; // catalog-only fund: no workbook exists
      try {
        const meta = await fetchJson(`./api/fidelity/funds/${encodeURIComponent(ticker)}/meta.json`);
        // Preserve a session upload that arrived while the request was in flight.
        if (!fundMetaCache.has(ticker)) fundMetaCache.set(ticker, meta);
        return fundMetaCache.get(ticker);
      } catch (error) {
        console.warn(`Failed to load meta.json for ${ticker}:`, error);
        return null;
      }
    }

    function sheetKey(sheet: string): string {
      return `${state.activeFundTicker}:${sheet}`;
    }

    function resetSheetPaging(): void {
      sheetGeneration += 1;
    }

    async function fetchPage(ticker: string, pagePath: string): Promise<{ headers: string[]; rows: string[][] }> {
      const path = String(pagePath).replace(/^\.?\//, '');
      const page = await fetchJson(`./api/fidelity/funds/${encodeURIComponent(ticker)}/${path}`);
      const headers: string[] = Array.isArray(page.headers) ? page.headers : [];
      const rows: any[] = Array.isArray(page.rows) ? page.rows : [];
      return { headers, rows: rows.map(row => headers.map(header => String(row[header] ?? ''))) };
    }

    /** Loads the first page of a paginated sheet and prepares lazy appending. */
    async function ensureSheet(sheet: 'holdings' | 'history', manifest: any): Promise<void> {
      const key = sheetKey(sheet);
      if (sheetState.has(key) || !manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) return;
      sheetState.set(key, { headers: [], rows: [], nextPage: 0, manifest, loading: false });
      await loadNextSheetPage(sheet);
    }

    // Both detail paging and background aggregation use the same per-ticker
    // queue. Read nextPage inside the lock; navigation never discards cache data.
    const pageChains = new Map<string, Promise<unknown>>();
    function withTickerChain<T>(ticker: string, work: () => Promise<T>): Promise<T> {
      const next = (pageChains.get(ticker) || Promise.resolve()).then(work, work);
      const settled = next.catch(() => undefined);
      pageChains.set(ticker, settled);
      void settled.then(() => { if (pageChains.get(ticker) === settled) pageChains.delete(ticker); });
      return next;
    }

    async function appendSheetPage(ticker: string, sheet: string): Promise<void> {
      await withTickerChain(ticker, async () => {
        const key = `${ticker}:${sheet}`;
        const entry = sheetState.get(key);
        if (!entry || entry.nextPage >= entry.manifest.pages.length) return;
        entry.loading = true;
        try {
          const page = await fetchPage(ticker, entry.manifest.pages[entry.nextPage]);
          // A user upload can replace this cache entry while the request runs.
          if (sheetState.get(key) !== entry) return;
          if (!entry.headers.length) entry.headers = page.headers;
          entry.rows = entry.rows.concat(page.rows);
          entry.nextPage += 1;
        } finally {
          entry.loading = false;
        }
      });
    }

    async function loadNextSheetPage(sheet: 'holdings' | 'history'): Promise<void> {
      const ticker = state.activeFundTicker;
      const entry = sheetState.get(sheetKey(sheet));
      if (!ticker || !entry || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
      try {
        await appendSheetPage(ticker, sheet);
        if (state.activeFundTicker === ticker && state.activeTab === `detail:${sheet}`) render();
        else renderTabs();
      } catch (error) {
        console.error(`Failed to load ${ticker} ${sheet} page:`, error);
      } finally {
        renderStaticLoadSentinel();
      }
    }

    const WATCHLIST_LOAD_CONCURRENCY = 4;
    let watchlistLoadChain: Promise<void> = Promise.resolve();
    const holdingsUnavailable = new Set<string>();
    const holdingsErrors = new Set<string>();

    function isHoldingsLoading(): boolean {
      return [...state.selected].some(ticker => {
        if (holdingsUnavailable.has(ticker) || holdingsErrors.has(ticker)) return false;
        const entry = sheetState.get(`${ticker}:holdings`);
        return !entry || entry.nextPage < entry.manifest.pages.length;
      });
    }

    let holdingsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    function refreshHoldingsUI(): void {
      if (holdingsRefreshTimer !== null) return;
      holdingsRefreshTimer = setTimeout(() => {
        holdingsRefreshTimer = null;
        if (state.activeTab === 'watchlist') render();
        else renderTabs();
      }, 100);
    }

    async function loadFundHoldingsForWatchlist(ticker: string): Promise<void> {
      if (!state.selected.has(ticker)) return;
      const meta = await loadFundMeta(ticker);
      if (!meta) {
        const fund = state.funds.find(fund => fund.ticker === ticker);
        if (fund && !fund.holdings && !fund.history) holdingsUnavailable.add(ticker);
        else holdingsErrors.add(ticker);
        return;
      }
      if (!meta.holdings || !Array.isArray(meta.holdings.pages) || !meta.holdings.pages.length) {
        holdingsUnavailable.add(ticker);
        return;
      }
      const key = `${ticker}:holdings`;
      if (!sheetState.has(key)) {
        sheetState.set(key, { headers: [], rows: [], nextPage: 0, manifest: meta.holdings, loading: false });
      }
      while (state.selected.has(ticker)) {
        const entry = sheetState.get(key);
        if (!entry || entry.nextPage >= entry.manifest.pages.length) break;
        await appendSheetPage(ticker, 'holdings');
        refreshHoldingsUI();
      }
    }

    async function ensureHoldingsForSelection(): Promise<void> {
      const run = watchlistLoadChain.then(async () => {
        const tickers = [...state.selected];
        let cursor = 0;
        const workers = Array.from({ length: Math.min(WATCHLIST_LOAD_CONCURRENCY, tickers.length) }, async () => {
          while (cursor < tickers.length) {
            const ticker = tickers[cursor++];
            holdingsErrors.delete(ticker);
            try {
              await loadFundHoldingsForWatchlist(ticker);
            } catch (error) {
              holdingsErrors.add(ticker);
              console.error(`Failed to load ${ticker} holdings:`, error);
            } finally {
              refreshHoldingsUI();
            }
          }
        });
        await Promise.all(workers);
      });
      watchlistLoadChain = run.catch(() => {});
      await run;
    }

    function activeSheetTab(): 'holdings' | 'history' | null {
      if (state.activeTab === 'detail:holdings') return 'holdings';
      if (state.activeTab === 'detail:history') return 'history';
      return null;
    }

    function maybeLoadMoreRows(): void {
      if (state.activeTab === 'watchlist') {
        if (watchlistHasMore) {
          watchlistChunk += WATCHLIST_CHUNK_SIZE;
          render();
        }
        return;
      }
      const sheet = activeSheetTab();
      if (!sheet) return;
      void loadNextSheetPage(sheet);
    }

    function renderStaticLoadSentinel(): void {
      if (state.activeTab === 'watchlist') {
        el.staticLoadSentinel.classList.toggle('hidden', !watchlistHasMore);
        el.staticLoadStatus.textContent = watchlistHasMore
          ? `Showing ${watchlistShownCount} of ${watchlistTotalCount} tickers — scroll or click to load more…`
          : '';
        return;
      }
      const sheet = activeSheetTab();
      if (!sheet || !state.activeFundTicker) {
        el.staticLoadSentinel.classList.add('hidden');
        return;
      }
      const entry = sheetState.get(sheetKey(sheet));
      if (!entry) {
        el.staticLoadSentinel.classList.add('hidden');
        return;
      }
      const more = entry.nextPage < entry.manifest.pages.length;
      el.staticLoadSentinel.classList.toggle('hidden', !more);
      el.staticLoadStatus.textContent = entry.loading ? 'Loading more rows…' : more ? 'Scroll or click to load more rows…' : '';
    }

    // =========================================================================
    // 5. Navigation tabs & tab switching
    // =========================================================================

    function categoryLabel(category: string): string {
      return category || 'ETF';
    }

    function uniqueCategories(): string[] {
      const categories = [...new Set(state.funds.map(fund => fund.category).filter(Boolean))];
      return categories.sort((a, b) => b.length - a.length || a.localeCompare(b));
    }

    function visibleFunds(): FundRow[] {
      const tab = isEtfCatalogTab(state.activeTab) ? state.activeTab : 'All';
      return state.funds.filter(fund => (tab === 'All' || fund.category === tab) && !state.blacklist.has(fund.ticker));
    }

    function getTabs(): TabInfo[] {
      const tabs: TabInfo[] = [];
      tabs.push({ id: 'All', label: 'All ETFs', count: state.funds.filter(fund => !state.blacklist.has(fund.ticker)).length });
      uniqueCategories().forEach(category => {
        tabs.push({
          id: category,
          label: categoryLabel(category),
          count: state.funds.filter(fund => fund.category === category && !state.blacklist.has(fund.ticker)).length,
        });
      });
      return tabs;
    }

    function getSelectedTabs(): TabInfo[] {
      const tabs: TabInfo[] = [];
      const activeFund = getActiveFund();

      if (activeFund) {
        DETAIL_TABS.forEach(tab => {
          tabs.push({
            id: `detail:${tab.key}`,
            label: tab.key === 'overview' ? `${activeFund.ticker} ${tab.label}` : tab.label,
            count: getDetailCount(tab.key),
          });
        });
      }

      if (state.selected.size > 0) {
        const count = getDedupedWatchlistRows().length;
        const failed = [...state.selected].some(ticker => holdingsErrors.has(ticker));
        tabs.push({ id: 'watchlist', label: 'Watchlist', count: isHoldingsLoading() ? (count ? `${count}+` : 'Loading…') : failed ? `${count}, incomplete` : count });
      }

      return tabs;
    }

    function getAllTabIds(): ActiveTab[] {
      return [...getTabs(), ...getSelectedTabs()].map(tab => tab.id);
    }

    function getActiveFund(): FundRow | null {
      if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) return null;
      return state.funds.find(fund => fund.ticker === state.activeFundTicker) || null;
    }

    function getDetailCount(key: string): number {
      const activeFund = getActiveFund();
      if (!activeFund) return 0;
      if (key === 'holdings') return activeFund.holdings || 0;
      if (key === 'history') return activeFund.history || 0;
      if (key === 'distributions') {
        const meta = fundMetaCache.get(activeFund.ticker);
        return meta && meta.distributions && Array.isArray(meta.distributions.rows) ? meta.distributions.rows.length : 0;
      }
      return 0;
    }

    function ensureValidTab(): void {
      const tabIds = getAllTabIds();
      if (!tabIds.includes(state.activeTab)) {
        state.activeTab = 'All';
        applySortForTab(state.activeTab);
      }
    }

    function applyRestoredTab(): void {
      const tabIds = getAllTabIds();
      if (!tabIds.includes(state.activeTab)) state.activeTab = 'All';
      applySortForTab(state.activeTab);
      syncSearchInput();
    }

    function renderTabs(): void {
      renderTabButtons(el.tabsBar, getTabs());
      const selectedTabs = getSelectedTabs();
      el.selectedTabsPanel.classList.toggle('is-visible', selectedTabs.length > 0);
      renderTabButtons(el.selectedTabsBar, selectedTabs);
    }

    function renderTabButtons(container: any, tabs: TabInfo[]): void {
      container.classList.toggle('hidden', tabs.length <= 1);
      const candidates = state.funds.filter(fund => !state.blacklist.has(fund.ticker));
      const allSelected = candidates.length > 0 && candidates.every(fund => state.selected.has(fund.ticker));
      container.innerHTML = tabs.map(tab => {
        const isActive = tab.id === state.activeTab;
        const activeClasses = 'bg-blue-600 text-white font-medium border-blue-500 shadow-sm';
        const inactiveClasses = 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 border-slate-200 dark:border-slate-700';
        if (tab.id === 'All') {
          return `
            <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
              <input type="checkbox" id="select-all-toggle" ${allSelected ? 'checked' : ''} class="w-3.5 h-3.5 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
              <button data-tab="All" class="font-medium hover:underline focus:outline-none">
                ${escapeHtml(tab.label)} (${tab.count})
              </button>
            </div>
          `;
        }
        return `
          <button
            data-tab="${escapeHtml(tab.id)}"
            class="px-3.5 py-1.5 rounded-full text-xs transition border whitespace-nowrap ${isActive ? activeClasses : inactiveClasses}">
            ${escapeHtml(tab.label)} (${tab.count})
          </button>
        `;
      }).join('');

      container.querySelectorAll('button[data-tab]').forEach((button: any) => {
        button.addEventListener('click', () => {
          const destination = button.dataset.tab || 'All';
          if (destination !== state.activeTab) setCurrentQuery(el.searchInput.value);
          state.activeTab = destination;
          applySortForTab(state.activeTab);
          resetSheetPaging();
          if (state.activeTab === 'watchlist') {
            resetWatchlistChunk();
            void ensureHoldingsForSelection();
          }
          syncSearchInput();
          render();
          maybeLoadMoreRows();
        });
      });

      const selectAllToggle = container.querySelector('#select-all-toggle');
      if (selectAllToggle) {
        selectAllToggle.addEventListener('change', (event: any) => {
          event.stopPropagation();
          // The "All ETFs" pill scope is the entire non-blacklisted catalog,
          // from any tab, without navigating (ui-contract: "Select all
          // applies to the visible, non-blacklisted catalog").
          toggleSelectAll(Boolean(event.target.checked), 'catalog');
        });
        selectAllToggle.addEventListener('click', (event: any) => event.stopPropagation());
      }
    }

    function applyDefaultSortForTab(tab: ActiveTab): void {
      if (tab === 'watchlist') {
        state.sortKey = 'weightSum';
        state.sortDir = 'desc';
      } else if (tab === 'detail:overview') {
        state.sortKey = 'section';
        state.sortDir = 'asc';
      } else {
        // Holdings, History and Distributions arrive already ordered by the
        // source workbook (weight / date); keep the source order by default.
        state.sortKey = 'rank';
        state.sortDir = 'asc';
      }
    }

    /**
     * Per-tab sort memory: tab switches restore the sort last used on that
     * tab (fidelity-tab-sorts in localStorage) and only fall back to the
     * tab's default when nothing was remembered. Only an explicit header
     * click (rememberSortForCurrentTab) writes to the memory, so no other
     * control mutates it as a side effect.
     */
    function applySortForTab(tab: ActiveTab): void {
      const saved = state.sortByTab[tab];
      if (saved && typeof saved.key === 'string' && (saved.dir === 'asc' || saved.dir === 'desc')) {
        state.sortKey = saved.key;
        state.sortDir = saved.dir;
        return;
      }
      applyDefaultSortForTab(tab);
    }

    function rememberSortForCurrentTab(): void {
      state.sortByTab[state.activeTab] = { key: state.sortKey, dir: state.sortDir };
      persistSorts();
    }

    function tabLabel(tab: ActiveTab): string {
      const match = /^detail:(.+)$/.exec(tab);
      if (match) {
        const found = DETAIL_TABS.find(item => item.key === match[1]);
        return found ? found.label : tab;
      }
      return tab === 'watchlist' ? 'Watchlist' : categoryLabel(tab);
    }

    function isEtfCatalogTab(tab: ActiveTab): boolean {
      return tab === 'All' || uniqueCategories().includes(tab);
    }

    function isDetailTab(tab: ActiveTab): boolean {
      return /^detail:(overview|holdings|history|distributions)$/.test(tab);
    }

    function detailTabKey(tab: ActiveTab): string {
      const match = /^detail:(.+)$/.exec(tab);
      return match ? match[1] : 'overview';
    }

    // =========================================================================
    // 6. Table rendering, sorting & tooltips
    // =========================================================================

    function render(): void {
      ensureValidTab();
      syncSearchInput();
      persistSiteState();
      renderTabs();
      renderBlacklistPanel();
      renderSubtitle();
      animateTableUpdate();
      if (state.activeTab === 'watchlist') renderWatchlistTable();
      else if (isDetailTab(state.activeTab)) renderDetailTable(detailTabKey(state.activeTab));
      else renderFundsTable();
      fitTableHeight();
      renderStaticLoadSentinel();
    }

    function animateTableUpdate(): void {
      el.tableBody.classList.remove('table-content-enter');
      void el.tableBody.offsetWidth; // reflow to restart the animation
      el.tableBody.classList.add('table-content-enter');
    }

    function currentQuery(): string {
      return state.queryByTab[state.activeTab] || '';
    }

    function setCurrentQuery(value: string): void {
      if (value) state.queryByTab[state.activeTab] = value;
      else delete state.queryByTab[state.activeTab];
      persistSearches();
    }

    // Always restore the active tab, including on touch/programmatic switches
    // where the search input can retain focus. Keep raw text so typing a space
    // between words is not undone by the synchronous render.
    function syncSearchInput(): void {
      const query = currentQuery();
      if (el.searchInput.value !== query) {
        el.searchInput.value = query;
      }
      el.searchClear.classList.toggle('hidden', !query);
      el.searchInput.placeholder = isEtfCatalogTab(state.activeTab)
        ? 'Search ETFs, fund names, holdings, tickers, CUSIPs/ISINs, SEDOLs...'
        : `Search ${tabLabel(state.activeTab)}...`;
    }

    function filterRows(rows: any[]): any[] {
      const query = normalizeSearchText(currentQuery());
      if (!query) return rows;
      return rows.filter(row => String(row.searchIndex || '').includes(query));
    }

    function sortValue(row: Record<string, unknown>, key: string): unknown {
      return row[key];
    }

    function compareValues(a: unknown, b: unknown): number {
      const an = numberOrNull(a);
      const bn = numberOrNull(b);
      if (an !== null && bn !== null) return an - bn;
      const as = String(a ?? '');
      const bs = String(b ?? '');
      // History dates ("Aug 21 2026") sort chronologically.
      if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(as) || /^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(bs)) {
        const ad = Date.parse(as.replace(/-/g, ' '));
        const bd = Date.parse(bs.replace(/-/g, ' '));
        if (!Number.isNaN(ad) && !Number.isNaN(bd)) return ad - bd;
      }
      return as.localeCompare(bs, undefined, { numeric: true });
    }

    function sortRows(rows: any[]): any[] {
      if (state.sortKey === 'rank') return rows;
      const direction = state.sortDir === 'asc' ? 1 : -1;
      const key = state.sortKey;
      return [...rows].sort((a, b) => compareValues(sortValue(a, key), sortValue(b, key)) * direction);
    }

    function sortHeader(label: string, key: string, numeric = false, stickyClass = ''): string {
      const active = state.sortKey === key;
      const arrow = active ? (state.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
      const align = numeric ? ' text-right' : '';
      const tooltip = getHeaderTooltip(label);
      const sticky = stickyClass ? `${stickyClass} ` : '';
      return `<th class="${sticky}py-3.5 px-4${align}" title="${escapeHtml(tooltip)}"><button data-sort="${escapeHtml(key)}" title="${escapeHtml(tooltip)}" class="uppercase tracking-wider hover:text-blue-600 dark:hover:text-blue-400 focus:outline-none focus:text-blue-600 dark:focus:text-blue-400">${escapeHtml(label)}${arrow}</button></th>`;
    }

    function indexHeader(): string {
      return `<th class="py-3.5 px-4 w-12 text-center" title="${escapeHtml(getHeaderTooltip('#'))}">#</th>`;
    }

    function useHeader(): string {
      const candidates = headerSelectCandidates();
      const allSelected = candidates.length > 0 && candidates.every(fund => state.selected.has(fund.ticker));
      return `<th class="catalog-sticky-col catalog-sticky-use py-3.5 px-4 w-20 text-center" title="${escapeHtml(getHeaderTooltip('Use'))}">
        <div class="inline-flex items-center justify-center gap-1">
          <input type="checkbox" id="select-all-checkbox" ${allSelected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" title="Select / Deselect all ETFs" />
          <span>Use</span>
        </div>
      </th>`;
    }

    function bindSortHeaders(): void {
      el.tableHead.querySelectorAll('button[data-sort]').forEach((button: any) => {
        button.addEventListener('click', () => {
          const key = button.dataset.sort || 'rank';
          if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
          else {
            state.sortKey = key;
            state.sortDir = ['ticker', 'name', 'category', 'symbol', 'section', 'metric', 'identifier', 'label'].includes(key) ? 'asc' : 'desc';
          }
          if (state.activeTab === 'watchlist') resetWatchlistChunk();
          rememberSortForCurrentTab();
          render();
        });
      });
    }

    function bindSelectAllCheckbox(): void {
      const checkbox = el.tableHead.querySelector('#select-all-checkbox');
      if (!checkbox) return;
      checkbox.addEventListener('change', (event: any) => {
        event.stopPropagation();
        toggleSelectAll(Boolean(event.target.checked));
      });
      checkbox.addEventListener('click', (event: any) => event.stopPropagation());
    }

    function renderFundsTable(): void {
      const rows = sortRows(filterRows(visibleFunds()));
      el.tableHead.innerHTML = `
        <tr>
          ${indexHeader()}
          ${useHeader()}
          ${sortHeader('Ticker', 'ticker', false, 'catalog-sticky-col catalog-sticky-ticker w-24 min-w-24')}
          ${sortHeader('Fund Name', 'name')}
          ${sortHeader('Type', 'category')}
          ${sortHeader('NAV', 'navValue', true)}
          ${sortHeader('Net Assets', 'aumValue', true)}
          ${sortHeader('Expense', 'terValue', true)}
          ${sortHeader('Dividend Yield', 'dividendYield', true)}
          ${sortHeader('SEC Yield', 'secYield', true)}
          ${sortHeader('Frequency', 'distFrequency')}
          ${sortHeader('YTD Return', 'ytd', true)}
          ${sortHeader('TR 1Y', 'yr1', true)}
          ${sortHeader('TR 3Y', 'tr3y', true)}
          ${sortHeader('TR 5Y', 'tr5y', true)}
          ${sortHeader('TR 10Y', 'tr10y', true)}
          ${sortHeader('CAGR 3Y', 'cagr3y', true)}
          ${sortHeader('CAGR 5Y', 'cagr5y', true)}
          ${sortHeader('CAGR 10Y', 'cagr10y', true)}
          ${sortHeader('SI Ann.', 'si', true)}
          ${sortHeader('Return As Of', 'returnAsOf')}
          ${sortHeader('Inception', 'inceptionDate')}
          ${sortHeader('Holdings', 'holdings', true)}
          ${sortHeader('History', 'history', true)}
          ${sortHeader('As Of', 'asOfDate')}
        </tr>
      `;
      bindSortHeaders();
      bindSelectAllCheckbox();

      if (!rows.length) {
        el.tableBody.innerHTML = `<tr><td colspan="25" class="py-12 text-center text-slate-400 dark:text-slate-500">No ETFs match your search.</td></tr>`;
      } else {
        el.tableBody.innerHTML = rows.map((fund, index) => {
          const selected = state.selected.has(fund.ticker);
          return `
            <tr data-ticker="${escapeHtml(fund.ticker)}" class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30 ${selected ? 'selected-row' : ''}">
              <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
              <td class="catalog-sticky-col catalog-sticky-use py-2.5 px-4 w-20 text-center">
                <div class="inline-flex items-center justify-center gap-1.5">
                  <input data-checkbox="${escapeHtml(fund.ticker)}" type="checkbox" ${selected ? 'checked' : ''} class="w-4 h-4 accent-blue-600 cursor-pointer" aria-label="Use ${escapeHtml(fund.ticker)}" />
                  <button data-blacklist="${escapeHtml(fund.ticker)}" class="w-4 h-4 rounded text-slate-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 leading-none transition" title="Blacklist ${escapeHtml(fund.ticker)} — hide it from All ETFs">✕</button>
                </div>
              </td>
              <td class="catalog-sticky-col catalog-sticky-ticker py-2.5 px-4 w-24 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(fund.ticker)}</td>
              <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(fund.name)}">${escapeHtml(fund.name)}</td>
              <td class="py-2.5 px-4 text-slate-600 dark:text-slate-300">${escapeHtml(categoryLabel(fund.category))}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.nav || '—')}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatMoney(fund.aumValue)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${escapeHtml(fund.ter || '—')}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.dividendYield)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">—</td>
              <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.distFrequency || '00 - —')}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.ytd)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.yr1)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr3y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr5y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.tr10y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr3y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr5y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.cagr10y)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatPercent(fund.si)}</td>
              <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.returnAsOf || '—')}</td>
              <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.inceptionDate || '—')}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.holdings)}</td>
              <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${formatInteger(fund.history)}</td>
              <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400">${escapeHtml(fund.asOfDate || '—')}</td>
            </tr>
          `;
        }).join('');
      }

      el.tableBody.querySelectorAll('input[data-checkbox]').forEach((checkbox: any) => {
        checkbox.addEventListener('change', (event: any) => {
          event.stopPropagation();
          const ticker = checkbox.dataset.checkbox || '';
          toggleFund(ticker);
        });
        checkbox.addEventListener('click', (event: any) => event.stopPropagation());
      });

      el.tableBody.querySelectorAll('button[data-blacklist]').forEach((button: any) => {
        button.addEventListener('click', (event: any) => {
          event.stopPropagation();
          blacklistTickers([button.dataset.blacklist || '']);
        });
      });

      const selected = state.selected.size;
      const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
      const activeText = state.activeFundTicker ? ` Active ETF detail tabs are for ${state.activeFundTicker}.` : '';
      setStatus(`Showing ${rows.length} ETF${rows.length === 1 ? '' : 's'}${queryText}. Use the checkboxes in the “Use” column to select ETFs.${selected ? ` ${selected} selected.` : ' No ETFs selected yet.'}${activeText}`, selected ? 'success' : 'info');
      el.tickerCount.textContent = `${rows.length} ETFs`;
      renderSubtitle();
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    type HoldingPosition = { fund: string; key: string; symbol: string; name: string; weight: number; cusip: string };

    // Identifier cells carry "-", "—", "N/A" placeholders for missing values;
    // a fallback must skip those, not collapse every bond into one bucket.
    function cleanIdentifier(value: unknown): string {
      const raw = String(value ?? '').trim();
      return !raw || /^(?:[-—–]+|n\/a|na|none|null|0{9})$/i.test(raw) ? '' : raw;
    }

    /**
     * Dedup key fallback chain: ticker → CUSIP → ISIN → Identifier →
     * SEDOL/FIGI → name (shared UI contract). Fidelity holdings sheets carry
     * Name/Ticker/Identifier columns; CUSIP/ISIN/SEDOL/FIGI columns are
     * optional and win over Identifier when a data build emits them. A row
     * with no identifier at all falls back to its security name instead of
     * being dropped from the Watchlist.
     */
    function positionIdentity(row: string[], headers: string[]): { key: string; symbol: string } {
      const tiers: [string, RegExp][] = [
        ['T', /^(ticker|symbol)$/i], ['C', /^cusip$/i], ['I', /^isin$/i],
        ['D', /^(identifier|security[- ]?id)$/i], ['S', /^sedol$/i],
        ['S', /^figi$/i], ['N', /^(name|security name)$/i],
      ];
      for (const [prefix, pattern] of tiers) {
        for (let i = 0; i < headers.length; i++) {
          if (!pattern.test(headers[i])) continue;
          const symbol = cleanIdentifier(row[i]);
          if (symbol) return { key: `${prefix}:${symbol.toUpperCase()}`, symbol };
        }
      }
      return { key: '', symbol: '' };
    }

    function sheetPositions(ticker: string): HoldingPosition[] {
      const entry = sheetState.get(`${ticker}:holdings`);
      if (!entry || !entry.headers.length) return [];
      const headers = entry.headers;
      const nameIndex = headers.findIndex(header => /^name$/i.test(header));
      const identifierIndex = headers.findIndex(header => /^identifier$/i.test(header));
      const weightIndex = headers.findIndex(header => /^weight$/i.test(header));
      const sedolIndex = headers.findIndex(header => /^sedol$/i.test(header));
      return entry.rows
        .map(row => {
          // Holding rows carry the exchange ticker resolved at data-build
          // time; bond / private positions have no ticker ("-") and the
          // CUSIP/ISIN Identifier is the stable key for those rows.
          const identifier = identifierIndex >= 0 ? cleanIdentifier(row[identifierIndex]) : '';
          const weight = weightIndex >= 0 ? numberOrNull(row[weightIndex]) : null;
          return {
            fund: ticker,
            ...positionIdentity(row, headers),
            name: nameIndex >= 0 ? (row[nameIndex] || '').trim() : '',
            weight: weight === null ? 0 : weight,
            cusip: identifier || (sedolIndex >= 0 ? cleanIdentifier(row[sedolIndex]) : ''),
          };
        })
        .filter(position => position.symbol !== '');
    }

    function getSelectedPositions(): HoldingPosition[] {
      return [...state.selected].flatMap(ticker => sheetPositions(ticker));
    }

    let watchlistCache: { signature: string; entries: (SheetEntry | undefined)[]; rows: WatchlistRow[] } | null = null;
    function getDedupedWatchlistRows(): WatchlistRow[] {
      const tickers = [...state.selected];
      const entries = tickers.map(ticker => sheetState.get(`${ticker}:holdings`));
      const signature = tickers.map((ticker, i) => `${ticker}:${entries[i]?.rows.length || 0}`).join('|');
      if (watchlistCache && watchlistCache.signature === signature && entries.every((entry, i) => entry === watchlistCache.entries[i])) return watchlistCache.rows;
      const map: Map<string, WatchlistRow> = new Map();
      getSelectedPositions().forEach(position => {
        const symbol = position.symbol;
        if (!map.has(position.key)) {
          map.set(position.key, {
            symbol,
            name: position.name,
            funds: [],
            fundCount: 0,
            weightSum: 0,
            maxWeight: 0,
            cusips: [],
            identifier: '',
            searchIndex: '',
          });
        }
        const row = map.get(position.key);
        if (!row) return;
        if (!row.funds.includes(position.fund)) row.funds.push(position.fund);
        row.weightSum += position.weight;
        row.maxWeight = Math.max(row.maxWeight, position.weight);
        if (position.cusip && !row.cusips.includes(position.cusip)) row.cusips.push(position.cusip);
        if (position.name) row.name = position.name;
      });
      map.forEach(row => {
        row.fundCount = row.funds.length;
        row.funds.sort();
        row.cusips.sort();
        row.identifier = row.cusips[0] || '';
        row.searchIndex = [row.symbol, row.name, row.cusips.join(' '), row.funds.join(' ')].join(' ').toLowerCase();
      });
      const rows = [...map.values()];
      watchlistCache = { signature, entries, rows };
      return rows;
    }

    function getVisibleWatchlistRows(): WatchlistRow[] {
      return sortRows(filterRows(getDedupedWatchlistRows()));
    }

    // Watchlist rows render in capped chunks (shared UI contract): the first
    // paint shows WATCHLIST_CHUNK_SIZE rows and the load-more sentinel
    // appends the next chunk on scroll or click, so a 70-fund aggregation
    // never builds tens of thousands of <tr> in one innerHTML write.
    const WATCHLIST_CHUNK_SIZE = 200;
    let watchlistChunk = WATCHLIST_CHUNK_SIZE;
    let watchlistShownCount = 0;
    let watchlistTotalCount = 0;
    let watchlistHasMore = false;

    function resetWatchlistChunk(): void {
      watchlistChunk = WATCHLIST_CHUNK_SIZE;
    }

    function renderWatchlistTable(): void {
      const rows = getVisibleWatchlistRows();
      const visibleRows = rows.slice(0, watchlistChunk);
      watchlistShownCount = visibleRows.length;
      watchlistTotalCount = rows.length;
      watchlistHasMore = rows.length > visibleRows.length;
      el.tableHead.innerHTML = `
        <tr>
          ${indexHeader()}
          ${sortHeader('Ticker', 'symbol', false, 'watchlist-sticky-col watchlist-sticky-ticker')}
          ${sortHeader('Name', 'name')}
          ${sortHeader('ETFs', 'funds')}
          ${sortHeader('# ETFs', 'fundCount', true)}
          ${sortHeader('Weight Sum', 'weightSum', true)}
          ${sortHeader('Max Weight', 'maxWeight', true)}
          ${sortHeader('Identifier', 'identifier')}
        </tr>
      `;
      bindSortHeaders();

      if (!state.selected.size) {
        el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">Select ETFs in All ETFs to build the aggregated Watchlist.</td></tr>`;
      } else if (!rows.length) {
        const message = currentQuery() ? 'No holdings match your search.' : isHoldingsLoading()
          ? `Loading holdings of ${state.selected.size} selected ETFs…`
          : 'Holdings data is unavailable for the selected ETFs. See the fund Overview for source limitations.';
        el.tableBody.innerHTML = `<tr><td colspan="8" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(message)}</td></tr>`;
      } else {
        el.tableBody.innerHTML = visibleRows.map((row, index) => `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
            <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
            <td class="watchlist-sticky-col watchlist-sticky-ticker py-2.5 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">${escapeHtml(row.symbol)}</td>
            <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium" title="${escapeHtml(row.name)}">${escapeHtml(row.name || '—')}</td>
            <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300">
              <div class="flex flex-wrap gap-1 max-w-md">
                ${row.funds.map((ticker: string) => `<button data-activate-fund="${escapeHtml(ticker)}" class="font-mono text-xs bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800 rounded-full px-2 py-0.5">${escapeHtml(ticker)}</button>`).join('')}
              </div>
            </td>
            <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.fundCount}</td>
            <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.weightSum.toFixed(3)}%</td>
            <td class="py-2.5 px-4 text-right font-mono text-slate-700 dark:text-slate-300">${row.maxWeight.toFixed(3)}%</td>
            <td class="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-400 text-xs">${escapeHtml(row.identifier || '—')}</td>
          </tr>
        `).join('');
      }

      bindFundBadges(el.tableBody);
      const queryText = currentQuery() ? ` matching “${currentQuery()}”` : '';
      const chunkText = watchlistHasMore ? ` Showing first ${visibleRows.length} of ${rows.length} — scroll or click to load more.` : '';
      setStatus(`Watchlist built from ${state.selected.size} selected ETF${state.selected.size === 1 ? '' : 's'}: ${rows.length} ticker${rows.length === 1 ? '' : 's'}${queryText}. Deduplicated by ticker, identifier or security name.${isHoldingsLoading() ? ' Holdings are still loading; totals are partial.' : ''}${[...state.selected].some(ticker => holdingsErrors.has(ticker)) ? ' Some holdings failed to load; reopen Watchlist to retry.' : ''}${chunkText}`, 'success');
      el.tickerCount.textContent = `${rows.length} tickers`;
      renderSubtitle();
    }

    // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

    function renderDetailTable(key: string): void {
      const activeFund = getActiveFund();
      if (!activeFund) {
        renderEmptyDetail('Select an ETF row to see ETF details.');
        return;
      }

      if (key === 'overview') return renderOverviewTable(activeFund);
      if (key === 'distributions') return renderDistributionsTable(activeFund);
      return renderSheetTable(activeFund, key === 'history' ? 'history' : 'holdings');
    }

    function renderEmptyDetail(message: string): void {
      el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Details</th></tr>`;
      el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(message)}</td></tr>`;
      el.tickerCount.textContent = activeDetailTickerText();
    }

    function activeDetailTickerText(): string {
      return state.activeFundTicker ? `${state.activeFundTicker}` : '0 ETFs';
    }

    function renderSheetTable(fund: FundRow, sheet: 'holdings' | 'history'): void {
      const catalogCount = sheet === 'holdings' ? fund.holdings : fund.history;
      const entry = sheetState.get(sheetKey(sheet));

      if (!catalogCount) {
        el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">${escapeHtml(fund.ticker)}</th></tr>`;
        el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">${escapeHtml(fund.ticker)} publishes no ${sheet === 'holdings' ? 'holdings workbook' : 'NAV history workbook'} (catalog-only fund, e.g. a commodity trust).</td></tr>`;
        el.tickerCount.textContent = fund.ticker;
        renderSubtitle(`${fund.ticker} is catalog-only: no N-PORT ${sheet} file exists for it (crypto funds file no N-PORT).`);
        return;
      }

      if (!entry) {
        el.tableHead.innerHTML = `<tr>${indexHeader()}<th class="py-3.5 px-4">Loading…</th></tr>`;
        el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-slate-400 dark:text-slate-500">Loading ${escapeHtml(fund.ticker)} ${sheet}…</td></tr>`;
        el.tickerCount.textContent = fund.ticker;
        void loadFundMeta(fund.ticker).then(meta => {
          if (!meta) {
            el.tableBody.innerHTML = `<tr><td colspan="2" class="py-12 text-center text-rose-500">Unable to load meta.json for ${escapeHtml(fund.ticker)}</td></tr>`;
            return;
          }
          void ensureSheet(sheet, sheet === 'holdings' ? meta.holdings : meta.history).then(() => render());
        });
        return;
      }

      const headers = entry.headers;
      const rows = sortRows(filterRows(entry.rows.map((row, sourceIndex) => {
        const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase() };
        headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
        cells.rank = sourceIndex;
        return cells;
      })));

      el.tableHead.innerHTML = `
        <tr>
          ${indexHeader()}
          ${headers.map((header, index) => sortHeader(header || `Col ${index + 1}`, `col${index}`, NUMERIC_SHEET_HEADERS.includes(header))).join('')}
        </tr>
      `;
      bindSortHeaders();

      if (!rows.length) {
        el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No rows match your search${entry.loading ? ' (still loading…)' : ''}.</td></tr>`;
      } else {
        el.tableBody.innerHTML = rows.map((row, index) => {
          const values: string[] = row.values || [];
          return `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
            <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
            ${values.map((cell, columnIndex) => `
              <td class="py-2.5 px-4 ${NUMERIC_SHEET_HEADERS.includes(headers[columnIndex]) ? 'text-right font-mono text-slate-700 dark:text-slate-300' : 'text-slate-700 dark:text-slate-300'}">${escapeHtml(cell === '' ? '—' : cell)}</td>
            `).join('')}
          </tr>
        `;}).join('');
      }

      el.tickerCount.textContent = fund.ticker;
      renderSubtitle(`${fund.ticker} ${sheet === 'holdings' ? 'Holdings' : 'NAV History'} — ${entry.rows.length.toLocaleString('en-US')} of ${(entry.manifest.totalRows || 0).toLocaleString('en-US')} rows loaded${entry.manifest.asOfDate ? ` (as of ${entry.manifest.asOfDate})` : ''}.`);
    }

    function renderOverviewTable(fund: FundRow): void {
      const meta = fundMetaCache.get(fund.ticker);
      const monthEnd = (fund.returns && fund.returns.monthEnd) || {};
      const quarterEnd = (fund.returns && fund.returns.quarterEnd) || {};
      const overview: Array<{ section: string; metric: string; value: unknown }> = [
        { section: 'Fund', metric: 'Ticker', value: fund.ticker },
        { section: 'Fund', metric: 'Fund Name', value: fund.name },
        { section: 'Fund', metric: 'Asset Class', value: categoryLabel(fund.category) },
        { section: 'Fund', metric: 'Inception', value: fund.inceptionDate },
        { section: 'Fund', metric: 'Exchange', value: fund.exchange },
        { section: 'Fund', metric: 'Fund Page', value: fund.fundPage },
        { section: 'Fund', metric: 'EDGAR Filing', value: meta && meta.source ? meta.source.edgarFiling : null },
        { section: 'Fund', metric: 'N-PORT Document', value: meta && meta.source ? meta.source.nportDoc : null },
        { section: 'Cost', metric: 'TER (Gross Expense Ratio)', value: fund.ter },
        { section: 'Price', metric: 'NAV', value: fund.nav },
        { section: 'Price', metric: 'Close Price', value: fund.closePrice },
        { section: 'Price', metric: 'Premium / Discount', value: fund.premiumDiscount },
        { section: 'Price', metric: 'As Of', value: fund.asOfDate },
        { section: 'Assets', metric: 'Net Assets', value: formatMoney(fund.aumValue) },
        { section: 'Assets', metric: 'Net Assets (published)', value: fund.aum },
        { section: 'Returns', metric: 'Month-End As Of', value: monthEnd.asOfDate },
        { section: 'Returns', metric: 'YTD (ME)', value: formatPercent(monthEnd.ytd) },
        { section: 'Returns', metric: '1Y (ME)', value: formatPercent(monthEnd.yr1) },
        { section: 'Returns', metric: '3Y CAGR (ME)', value: formatPercent(monthEnd.yr3) },
        { section: 'Returns', metric: '5Y CAGR (ME)', value: formatPercent(monthEnd.yr5) },
        { section: 'Returns', metric: '10Y CAGR (ME)', value: formatPercent(monthEnd.yr10) },
        { section: 'Returns', metric: 'SI Ann. (ME)', value: formatPercent(monthEnd.sinceInception) },
        { section: 'Returns', metric: 'Quarter-End As Of', value: quarterEnd.asOfDate },
        { section: 'Returns', metric: 'YTD (QE)', value: formatPercent(quarterEnd.ytd) },
        { section: 'Returns', metric: '1Y (QE)', value: formatPercent(quarterEnd.yr1) },
        { section: 'Returns', metric: '3Y CAGR (QE)', value: formatPercent(quarterEnd.yr3) },
        { section: 'Returns', metric: '5Y CAGR (QE)', value: formatPercent(quarterEnd.yr5) },
        { section: 'Returns', metric: '10Y CAGR (QE)', value: formatPercent(quarterEnd.yr10) },
        { section: 'Returns', metric: 'SI Ann. (QE)', value: formatPercent(quarterEnd.sinceInception) },
        { section: 'Distributions', metric: 'Frequency', value: fund.distributions ? fund.distributions.frequency : null },
        { section: 'Distributions', metric: 'Ex-Date', value: fund.distributions ? fund.distributions.exDate : null },
        { section: 'Distributions', metric: 'Latest Dividend', value: fund.distributions ? fund.distributions.dividend : null },
        { section: 'Distributions', metric: 'Dividend Yield (indicated)', value: fund.dividendYield === null || fund.dividendYield === undefined ? null : `${fund.dividendYield.toFixed(2)}% (latest distribution x frequency / NAV)` },
        { section: 'Distributions', metric: 'SEC Yield (30-day)', value: 'not published in public Fidelity data feeds' },
        { section: 'Holdings', metric: 'Holdings Rows', value: fund.holdings },
        { section: 'Holdings', metric: 'Holdings As Of', value: meta && meta.holdings ? meta.holdings.asOfDate : null },
        { section: 'Holdings', metric: 'History Rows', value: fund.history },
      ];
      const rows = sortRows(filterRows(overview.map(item => ({
        section: item.section,
        metric: item.metric,
        value: item.value === null || item.value === undefined || item.value === '' ? '—' : item.value,
        searchIndex: `${item.section} ${item.metric} ${item.value}`.toLowerCase(),
      }))));

      el.tableHead.innerHTML = `
        <tr>
          ${indexHeader()}
          ${sortHeader('Section', 'section')}
          ${sortHeader('Metric', 'metric')}
          ${sortHeader('Value', 'value')}
        </tr>
      `;
      bindSortHeaders();

      if (!rows.length) {
        el.tableBody.innerHTML = `<tr><td colspan="4" class="py-12 text-center text-slate-400 dark:text-slate-500">No overview metrics match your search.</td></tr>`;
      } else {
        el.tableBody.innerHTML = rows.map((row, index) => `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
            <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
            <td class="py-2.5 px-4 text-slate-500 dark:text-slate-400">${escapeHtml(row.section)}</td>
            <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-medium">${escapeHtml(row.metric)}</td>
            <td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${
              /^https?:\/\//.test(String(row.value))
                ? `<a class="text-blue-600 dark:text-blue-400 hover:underline" href="${escapeHtml(row.value)}" target="_blank" rel="noopener noreferrer">open link</a>`
                : escapeHtml(row.value)
            }</td>
          </tr>
        `).join('');
      }

      el.tickerCount.textContent = fund.ticker;
      renderSubtitle(`${fund.ticker} overview · ${rows.length} metrics. Returns are derived from adjusted market-price closes, not official NAV returns.`);
    }

    function renderDistributionsTable(fund: FundRow): void {
      const meta = fundMetaCache.get(fund.ticker);
      const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
      const headers: string[] = Array.isArray(worksheet.headers) ? worksheet.headers : [];
      const sourceRows: string[][] = Array.isArray(worksheet.rows) ? worksheet.rows : [];
      const rows = sortRows(filterRows(sourceRows.map((row, sourceIndex) => {
        const cells: Record<string, unknown> = { values: row, searchIndex: row.join(' ').toLowerCase(), rank: sourceIndex };
        headers.forEach((header, index) => { cells[`col${index}`] = row[index] ?? ''; });
        return cells;
      })));

      el.tableHead.innerHTML = `
        <tr>
          ${indexHeader()}
          ${headers.map((header, index) => sortHeader(header, `col${index}`)).join('')}
        </tr>
      `;
      bindSortHeaders();

      if (!rows.length) {
        el.tableBody.innerHTML = `<tr><td colspan="${headers.length + 1}" class="py-12 text-center text-slate-400 dark:text-slate-500">No published distribution for ${escapeHtml(fund.ticker)}.</td></tr>`;
      } else {
        el.tableBody.innerHTML = rows.map((row, index) => {
          const values: string[] = row.values || [];
          return `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/30 transition border-b border-slate-100 dark:border-slate-700/30">
            <td class="py-2.5 px-4 text-slate-400 dark:text-slate-500 text-xs text-center font-mono">${index + 1}</td>
            ${values.map(cell => `<td class="py-2.5 px-4 text-slate-700 dark:text-slate-300 font-mono">${escapeHtml(cell || '—')}</td>`).join('')}
          </tr>
        `;}).join('');
      }

      el.tickerCount.textContent = fund.ticker;
      renderSubtitle(`${fund.ticker} distributions · dividend history from the Yahoo chart feed (ex-date, amount); frequency is inferred from the cadence.`);
    }

    // =========================================================================
    // 7. Subtitle
    // =========================================================================

    function renderSubtitle(text?: string): void {
      const generated = state.generatedAt ? new Date(state.generatedAt).toLocaleString() : '';
      const countsText = state.counts
        ? `${state.counts.funds} ETFs · ${(state.counts.holdings || 0).toLocaleString('en-US')} holdings rows · ${(state.counts.history || 0).toLocaleString('en-US')} history rows`
        : '';
      const base = text ? String(text) : 'Search Fidelity ETFs, select ETFs via the “Use” checkbox, then use the Watchlist tab.';
      const badges = [...state.selected].map(ticker => `<button data-activate-fund="${escapeHtml(ticker)}" class="font-mono rounded px-1.5 ${ticker === state.activeFundTicker ? 'bg-blue-600 text-white' : 'text-blue-600 dark:text-blue-400 hover:underline'}" title="Open ${escapeHtml(ticker)} details">${escapeHtml(ticker)}</button>`).join(' ');
      el.subtitle.innerHTML = `
        <span class="block sm:inline">${escapeHtml(base)}</span>
        <span id="selected-count"> · ${state.selected.size} selected</span> <span id="selected-ticker-chips">${badges}</span>
        <span class="block sm:inline">·${generated ? ` updated ${escapeHtml(generated)}` : ''}${countsText ? ` · ${escapeHtml(countsText)}.` : '.'} Data: <a href="./api/fidelity/index.json" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">api/fidelity/index.json</a> generated from <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000945908&type=NPORT-P" target="_blank" rel="noopener noreferrer" class="font-semibold text-blue-600 dark:text-blue-400 hover:underline">SEC EDGAR N-PORT filings</a> + Yahoo Finance</span>
      `;
      bindFundBadges(el.subtitle);
    }

    function bindFundBadges(container: any): void {
      container.querySelectorAll('[data-activate-fund]').forEach((button: any) => {
        button.addEventListener('click', () => {
          const ticker = button.dataset.activateFund;
          if (!state.selected.has(ticker)) return;
          state.activeFundTicker = ticker;
          if (!isDetailTab(state.activeTab)) state.activeTab = 'detail:overview';
          applySortForTab(state.activeTab);
          persistSelection();
          render();
        });
      });
    }

    function setStatusRow(message: string, tone: 'info' | 'error'): void {
      el.tableBody.innerHTML = `<tr><td colspan="10" class="py-12 text-center ${tone === 'error' ? 'text-rose-500 dark:text-rose-300' : 'text-slate-400 dark:text-slate-500'}">${escapeHtml(message)}</td></tr>`;
    }

    // =========================================================================
    // 8. Selection & blacklist
    // =========================================================================

    function toggleFund(ticker: string): void {
      const cleanTicker = sanitizeTicker(ticker);
      if (!cleanTicker) return;

      if (state.selected.has(cleanTicker)) {
        state.selected.delete(cleanTicker);
        if (state.activeFundTicker === cleanTicker) state.activeFundTicker = [...state.selected][0] || null;
      } else {
        state.selected.add(cleanTicker);
        state.activeFundTicker = cleanTicker;
      }

      persistSelection();
      ensureValidTab();
      resetWatchlistChunk();
      render();
      void ensureHoldingsForSelection();
      const activeTicker = state.activeFundTicker;
      if (activeTicker && state.activeTab.startsWith('detail:')) void loadFundMeta(activeTicker);
    }

    /**
     * Three distinct selection scopes (shared UI contract):
     * - row checkbox / row click: toggles one fund;
     * - header "select all" checkbox (scope 'tab', default): current tab +
     *   current search filter, blacklist-excluded;
     * - "All ETFs" pill checkbox (scope 'catalog'): the entire
     *   non-blacklisted catalog, from any tab, with no navigation.
     */
    function headerSelectCandidates(): FundRow[] {
      return filterRows(visibleFunds());
    }

    function toggleSelectAll(selectAll: boolean, scope: 'tab' | 'catalog' = 'tab'): void {
      const candidates = scope === 'catalog'
        ? state.funds.filter(fund => !state.blacklist.has(fund.ticker))
        : headerSelectCandidates();
      candidates.forEach(fund => {
        if (selectAll) state.selected.add(fund.ticker);
        else state.selected.delete(fund.ticker);
      });
      if (!state.selected.size) state.activeFundTicker = null;
      else if (!state.activeFundTicker || !state.selected.has(state.activeFundTicker)) {
        state.activeFundTicker = [...state.selected][0] || null;
      }
      persistSelection();
      ensureValidTab();
      resetWatchlistChunk();
      render();
      void ensureHoldingsForSelection();
    }

    function clearSelectionAndSearch(): void {
      state.selected.clear();
      state.activeFundTicker = null;
      state.queryByTab = {};
      state.activeTab = 'All';
      applySortForTab('All');
      resetWatchlistChunk();
      persistSelection();
      localStorage.removeItem(ACTIVE_FUND_KEY);
      el.searchInput.value = '';
      persistSearches();
      render();
    }

    function blacklistTickers(rawTickers: string[]): void {
      const known = new Set(state.funds.map(fund => fund.ticker));
      rawTickers
        .flatMap(raw => String(raw || '').split(/[\s,;]+/))
        .map(sanitizeTicker)
        .filter(Boolean)
        .filter(ticker => known.has(ticker))
        .forEach(ticker => state.blacklist.add(ticker));
      state.selected = new Set([...state.selected].filter(ticker => !state.blacklist.has(ticker)));
      if (state.activeFundTicker && state.blacklist.has(state.activeFundTicker)) {
        state.activeFundTicker = [...state.selected][0] || null;
      }
      persistBlacklist();
      persistSelection();
      ensureValidTab();
      resetWatchlistChunk();
      render();
      void ensureHoldingsForSelection();
    }

    function submitBlacklistInput(): void {
      blacklistTickers([el.blacklistInput.value || '']);
      el.blacklistInput.value = '';
      fitTableHeight();
    }

    function unblacklistTicker(ticker: string): void {
      state.blacklist.delete(sanitizeTicker(ticker));
      persistBlacklist();
      resetWatchlistChunk();
      render();
    }

    function clearBlacklist(): void {
      state.blacklist.clear();
      persistBlacklist();
      resetWatchlistChunk();
      render();
    }

    function renderBlacklistPanel(): void {
      el.blacklistChips.innerHTML = '';
      const tickers = [...state.blacklist].sort();
      tickers.forEach(ticker => {
        const chip = document.createElement('span');
        chip.className = 'inline-flex items-center gap-1.5 bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-700/50 rounded-full pl-3 pr-1.5 py-1 text-xs font-medium';
        chip.innerHTML = `${escapeHtml(ticker)}<button data-unblacklist="${escapeHtml(ticker)}" class="w-5 h-5 rounded-full hover:bg-rose-200 dark:hover:bg-rose-800 transition" title="Remove ${escapeHtml(ticker)} from blacklist">✕</button>`;
        el.blacklistChips.appendChild(chip);
      });
      el.blacklistEmpty.classList.toggle('hidden', tickers.length > 0);
      el.blacklistChips.querySelectorAll('button[data-unblacklist]').forEach((button: any) => {
        button.addEventListener('click', () => unblacklistTicker(button.dataset.unblacklist || ''));
      });
      // Keep the animated max-height in sync whenever the chip list changes.
      syncBlacklistPanelHeight();
    }

    /**
     * Blacklist panel expand/collapse — same animation contract as the
     * detail-tabs panel (#selected-tabs-panel.is-visible), but the
     * max-height is measured from the DOM (scrollHeight + padding headroom)
     * because the chip list is unbounded. The CSS transition animates from
     * the inline px value to the collapsed 0.
     */
    function toggleBlacklistPanel(force?: boolean): void {
      const panel = el.blacklistPanel;
      const show = typeof force === 'boolean' ? force : !panel.classList.contains('is-visible');
      if (show) {
        panel.classList.add('is-visible');
        syncBlacklistPanelHeight();
      } else {
        panel.style.maxHeight = `${panel.offsetHeight}px`; // start from the real height
        void panel.offsetHeight; // reflow so the collapse animates from here
        panel.classList.remove('is-visible');
        panel.style.maxHeight = '0px';
        window.setTimeout(() => {
          if (!panel.classList.contains('is-visible')) panel.style.maxHeight = '';
        }, 360);
      }
      el.blacklistBtn.setAttribute('aria-expanded', String(show));
    }

    function syncBlacklistPanelHeight(): void {
      const panel = el.blacklistPanel;
      if (!panel.classList.contains('is-visible')) return;
      // +40px headroom: padding-top/bottom animate 0 -> 1rem while
      // max-height animates, and scrollHeight is measured before they land.
      panel.style.maxHeight = `${panel.scrollHeight + 40}px`;
    }

    // =========================================================================
    // 9. Actions & exports (CSV, TXT, Copy Tickers)
    // =========================================================================

    function currentExportRows(): { headers: string[]; rows: string[][]; scope: string } {
      if (state.activeTab === 'watchlist') {
        return {
          headers: ['Ticker', 'Name', 'ETFs', '# ETFs', 'Weight Sum (%)', 'Max Weight (%)', 'Identifiers'],
          rows: getVisibleWatchlistRows().map(row => [
            row.symbol,
            row.name,
            row.funds.join('|'),
            String(row.fundCount),
            row.weightSum.toFixed(6),
            row.maxWeight.toFixed(6),
            row.cusips.join('|'),
          ]),
          scope: 'watchlist',
        };
      }

      if (state.activeTab === 'detail:overview') {
        const fund = getActiveFund();
        const monthEnd = (fund && fund.returns && fund.returns.monthEnd) || {};
        const quarterEnd = (fund && fund.returns && fund.returns.quarterEnd) || {};
        return {
          headers: ['Ticker', 'Fund Name', 'Category', 'TER', 'NAV', 'Net Assets ($)', 'YTD (ME)', '1Y (ME)', '3Y (ME)', '5Y (ME)', '10Y (ME)', 'SI Ann. (ME)', 'ME As Of', '1Y (QE)', '3Y (QE)', 'Inception', 'Holdings', 'History'],
          rows: [[
            fund ? fund.ticker : '',
            fund ? fund.name : '',
            fund ? fund.category : '',
            fund ? fund.ter : '',
            fund ? fund.nav : '',
            fund ? numberCell(fund.aumValue) : '',
            numberCell(monthEnd.ytd),
            numberCell(monthEnd.yr1),
            numberCell(monthEnd.yr3),
            numberCell(monthEnd.yr5),
            numberCell(monthEnd.yr10),
            numberCell(monthEnd.sinceInception),
            monthEnd.asOfDate || '',
            numberCell(quarterEnd.yr1),
            numberCell(quarterEnd.yr3),
            fund ? fund.inceptionDate : '',
            fund ? String(fund.holdings) : '0',
            fund ? String(fund.history) : '0',
          ]],
          scope: fund ? `${fund.ticker}-overview` : 'overview',
        };
      }

      if (state.activeTab === 'detail:distributions') {
        const fund = getActiveFund();
        const meta = fund ? fundMetaCache.get(fund.ticker) : null;
        const worksheet = meta && meta.distributions ? meta.distributions : { headers: [], rows: [] };
        return {
          headers: worksheet.headers || [],
          rows: worksheet.rows || [],
          scope: fund ? `${fund.ticker}-distributions` : 'distributions',
        };
      }

      if (state.activeTab === 'detail:holdings' || state.activeTab === 'detail:history') {
        const sheet = state.activeTab === 'detail:history' ? 'history' : 'holdings';
        const fund = getActiveFund();
        const entry = fund ? sheetState.get(sheetKey(sheet)) : null;
        if (entry) {
          return {
            headers: entry.headers,
            rows: filterRows(entry.rows.map(row => ({ values: row, searchIndex: row.join(' ').toLowerCase() }))).map((row: any) => row.values),
            scope: fund ? `${fund.ticker}-${sheet}` : sheet,
          };
        }
        return { headers: [], rows: [], scope: sheet };
      }

      return {
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
          numberCell(fund.yr1),
          numberCell(fund.tr3y),
          numberCell(fund.tr5y),
          numberCell(fund.tr10y),
          numberCell(fund.cagr3y),
          numberCell(fund.cagr5y),
          numberCell(fund.cagr10y),
          numberCell(fund.si),
          fund.returnAsOf || '',
          fund.inceptionDate || '',
          String(fund.holdings),
          String(fund.history),
          fund.asOfDate || '',
        ]),
        scope: 'etfs',
      };
    }

    function copyTickers(): void {
      let values: string[] = [];
      if (state.activeTab === 'watchlist') values = getVisibleWatchlistRows().map(row => row.symbol);
      else if (isDetailTab(state.activeTab)) values = currentExportRows().rows.map(row => String(row[0] ?? '')).filter(Boolean);
      else values = filterRows(visibleFunds()).map(fund => fund.ticker);
      values = values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!values.length) return;
      void copyText(values.join(', ')).then(() => {
        const oldText = el.copyBtn.textContent;
        el.copyBtn.textContent = 'Copied!';
        setTimeout(() => { el.copyBtn.textContent = oldText || 'Copy Tickers'; }, 1000);
      });
    }

    function exportCsv(): void {
      const exportData = currentExportRows();
      if (!exportData.rows.length) return;
      downloadText(
        toCsv([exportData.headers, ...exportData.rows.map(row => row.map(cell => String(cell ?? '')))]),
        exportFileName(exportData.scope, 'csv'),
        'text/csv;charset=utf-8;',
      );
    }

    function exportTxt(): void {
      const exportData = currentExportRows();
      if (!exportData.rows.length) return;
      downloadText(exportData.rows.map(row => row.join('\t')).join('\n'), exportFileName(exportData.scope, 'txt'), 'text/plain;charset=utf-8;');
    }

    // =========================================================================
    // 10. Scroll fix: only the table scrolls (same fix as daggerok/iShares)
    // =========================================================================

    function fitTableHeight(): void {
      const rect = el.tableScroll.getBoundingClientRect();
      const bottomPad = window.innerWidth < 640 ? 12 : 24;
      const max = Math.max(240, window.innerHeight - rect.top - bottomPad);
      el.tableScroll.style.maxHeight = `${max}px`;
    }

    // =========================================================================
    // 11. State persistence
    // =========================================================================

    function persistSelection(): void {
      localStorage.setItem(SELECTED_KEY, JSON.stringify([...state.selected]));
      if (state.activeFundTicker) localStorage.setItem(ACTIVE_FUND_KEY, state.activeFundTicker);
      else localStorage.removeItem(ACTIVE_FUND_KEY);
    }

    function persistBlacklist(): void {
      localStorage.setItem(BLACKLIST_KEY, JSON.stringify([...state.blacklist]));
    }

    function persistSearches(): void {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(state.queryByTab));
      persistSiteState();
    }

    function persistSorts(): void {
      localStorage.setItem(SORTS_KEY, JSON.stringify(state.sortByTab));
    }

    function restoreSelectedEtfs(): void {
      try {
        const saved = JSON.parse(localStorage.getItem(SELECTED_KEY) || '[]');
        state.selected = new Set((Array.isArray(saved) ? saved : []).map(sanitizeTicker).filter(Boolean));
        if (!state.selected.size && localStorage.getItem(SELECTED_KEY) === null) state.selected = new Set(DEFAULT_SELECTED_TICKERS);
      } catch {
        state.selected = new Set(DEFAULT_SELECTED_TICKERS);
      }
      const savedActive = sanitizeTicker(localStorage.getItem(ACTIVE_FUND_KEY) || '');
      state.activeFundTicker = savedActive && state.selected.has(savedActive) ? savedActive : ([...state.selected][0] || null);
    }

    function restoreBlacklist(): void {
      try {
        const saved = JSON.parse(localStorage.getItem(BLACKLIST_KEY) || 'null');
        if (Array.isArray(saved)) state.blacklist = new Set(saved.map(sanitizeTicker));
      } catch {
        // Ignore malformed storage.
      }
    }

    function persistSiteState(): void {
      let saved: any = {};
      try { saved = JSON.parse(localStorage.getItem(SITE_STATE_KEY) || '{}') || {}; } catch {}
      if (typeof saved !== 'object' || Array.isArray(saved)) saved = {};
      localStorage.setItem(SITE_STATE_KEY, JSON.stringify({ ...saved, activeTab: state.activeTab, sheetFilter: state.queryByTab }));
    }

    function restoreSearches(): void {
      const read = (key: string): any => {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
      };
      const site = read(SITE_STATE_KEY);
      if (site && typeof site.activeTab === 'string') state.activeTab = site.activeTab;
      const saved = localStorage.getItem(FILTERS_KEY) !== null ? read(FILTERS_KEY) : (read(SEARCHES_KEY) ?? site?.sheetFilter);
      state.queryByTab = {};
      if (typeof saved === 'string' && saved.trim()) state.queryByTab.All = saved;
      else if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [tab, value] of Object.entries(saved)) {
          if (typeof value === 'string' && value.trim()) state.queryByTab[tab] = value;
        }
      }
      persistSearches();
    }

    function restoreSorts(): void {
      try {
        const saved = JSON.parse(localStorage.getItem(SORTS_KEY) || '{}') || {};
        const restored: Record<ActiveTab, TabSort> = {};
        Object.keys(saved).forEach(tab => {
          const entry = saved[tab];
          if (entry && typeof entry.key === 'string' && (entry.dir === 'asc' || entry.dir === 'desc')) {
            restored[tab] = { key: entry.key, dir: entry.dir };
          }
        });
        state.sortByTab = restored;
      } catch {
        state.sortByTab = {};
      }
    }

    // =========================================================================
    // 12. Bootstrap lifecycle
    // =========================================================================

    // =========================================================================
    // 12. N-PORT upload (drag & drop, client-side parse; iShares dropzone twin)
    // =========================================================================

    /**
     * Parses a SEC Form N-PORT-P primary_doc.xml in the browser (DOMParser, no
     * network). Same normalization as the Bun updater, so uploaded holdings
     * merge into the Watchlist exactly like static-feed holdings.
     */
    function parseNportUpload(text: string): { seriesName: string; repPdDate: string; headers: string[]; rows: string[][] } {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('not a valid XML file');
      const headers = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
      const rows: string[][] = [];
      let seriesName = '';
      let repPdDate = '';
      const all = doc.getElementsByTagName('*');
      let inGenInfo = false;
      for (let i = 0; i < all.length; i++) {
        const node = all[i];
        const tag = node.localName || '';
        if (tag === 'genInfo') inGenInfo = true;
        if (inGenInfo && !seriesName && tag === 'seriesName') seriesName = (node.textContent || '').trim();
        if (inGenInfo && !repPdDate && tag === 'repPdDate') repPdDate = (node.textContent || '').trim();
        if (tag === 'invstOrSecs') inGenInfo = false;
        if (tag !== 'invstOrSec') continue;
        const pick = (parent: Element, name: string): string => {
          const children = parent.getElementsByTagName('*');
          for (let c = 0; c < children.length; c++) {
            if ((children[c].localName || '') === name) return (children[c].textContent || '').trim();
          }
          return '';
        };
        const name = pick(node, 'name') || pick(node, 'title') || '-';
        const cusip = pick(node, 'cusip');
        let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
        if (!identifier) {
          const ids = node.getElementsByTagName('*');
          for (let c = 0; c < ids.length; c++) {
            const value = ids[c].getAttribute && ids[c].getAttribute('value');
            if (value && ['isin', 'sedol', 'other', 'cusip'].includes(ids[c].localName || '')) {
              identifier = value;
              break;
            }
          }
        }
        let marketValue = pick(node, 'valUSD');
        let balance = pick(node, 'balance');
        rows.push([
          name,
          '-',
          identifier || '-',
          pick(node, 'pctVal') || '0',
          marketValue || '0',
          balance || '-',
          pick(node, 'assetCat') || '-',
        ]);
      }
      if (!rows.length && !seriesName) throw new Error('no genInfo/invstOrSec entries found (is this a Form N-PORT primary_doc.xml?)');
      return { seriesName, repPdDate, headers, rows };
    }

    const uploadedFunds = new Map(); // ticker -> { headers, rows }

    function normalizeUploadName(value: string): string {
      return String(value || '')
        .toUpperCase()
        .replace(/REG/ig, '')
        .replace(/\u00ae/g, '')
        .replace(/\u2122/g, '')
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b(ETF|FUND|INDEX|THE)\b/g, '')
        .trim();
    }

    function setDropzoneState(stateName: 'loaded' | 'error' | null, text?: string): void {
      if (!dropzone || !dropzoneText) return;
      dropzone.classList.remove('dz-loaded', 'dz-error');
      if (stateName) dropzone.classList.add(stateName);
      if (text) dropzoneText.textContent = text;
    }

    function handleUploadedFile(file: File): void {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = parseNportUpload(String(reader.result || ''));
          const known = state.funds.find(fund => normalizeUploadName(fund.name) === normalizeUploadName(parsed.seriesName));
          let ticker = known ? known.ticker : '';
          if (!ticker) {
            const answer = window.prompt(`Ticker symbol for "${parsed.seriesName}" (as listed on EDGAR):`, '');
            ticker = sanitizeTicker(answer);
          }
          if (!ticker) {
            setDropzoneState('error', 'Upload cancelled');
            window.setTimeout(() => setDropzoneState(null, 'Upload / Drop N-PORT XML'), 1600);
            return;
          }
          uploadedFunds.set(ticker, { headers: parsed.headers, rows: parsed.rows });

          // Merge the uploaded fund into the catalog (override static holdings).
          const base = known || {
            ticker, name: parsed.seriesName || ticker, category: 'Uploaded', fundPage: null, dataFile: null,
            ter: '—', terValue: null, nav: '—', navValue: null, aum: '—', aumValue: null,
            asOfDate: parsed.repPdDate || '—', inceptionDate: '—', exchange: '', closePrice: '—', closePriceValue: null,
            premiumDiscount: '—', premiumDiscountValue: null,
            distributions: { frequency: '—', exDate: '—', dividend: '—' },
            returns: { monthEnd: null, quarterEnd: null },
          };
          const indexFund: any = {
            ...base,
            ticker,
            name: parsed.seriesName || (known ? known.name : ticker),
            category: known ? known.category : 'Uploaded',
            metrics: { dividendYield: null, secYield: null },
            holdings: parsed.rows.length,
            history: known ? known.history : 0,
          };
          const row = normalizeFundRow(indexFund);
          const existingIndex = state.funds.findIndex(fund => fund.ticker === ticker);
          if (existingIndex >= 0) state.funds[existingIndex] = row;
          else state.funds.push(row);
          state.funds.sort((a, b) => a.ticker.localeCompare(b.ticker));

          // Holdings live in memory: feed the sheet cache + a minimal meta so
          // detail tabs, lazy paging and Watchlist aggregation all work.
          sheetState.set(`${ticker}:holdings`, { headers: parsed.headers, rows: parsed.rows, nextPage: 1, manifest: { pages: [], pageSize: parsed.rows.length, totalRows: parsed.rows.length }, loading: false });
          fundMetaCache.set(ticker, {
            ...fundMetaCache.get(ticker),
            ticker,
            name: row.name,
            category: row.category,
            source: { fundPage: row.fundPage, edgarFiling: null, nportDoc: null, provider: 'uploaded N-PORT XML (session only)' },
            distributions: { frequency: known && known.distributions ? known.distributions.frequency : '—', headers: ['Ex-Date', 'Amount'], rows: [] },
            holdings: { pages: [], pageSize: parsed.rows.length, totalRows: parsed.rows.length, asOfDate: parsed.repPdDate || 'uploaded' },
            history: known && fundMetaCache.get(ticker) ? fundMetaCache.get(ticker).history : { pages: [], pageSize: 0, totalRows: 0, asOfDate: '—' },
            uploaded: true,
          });

          setDropzoneState('loaded', `${uploadedFunds.size} fund${uploadedFunds.size === 1 ? '' : 's'} uploaded`);
          setStatus(`Loaded ${ticker} (${parsed.seriesName || 'N-PORT'}): ${parsed.rows.length} holdings${parsed.repPdDate ? ` as of ${parsed.repPdDate}` : ''}. Uploads live for this session.`, 'info');
          fitTableHeight();
          render();
        } catch (error) {
          console.error('Failed to parse uploaded file:', error);
          setDropzoneState('error', 'Invalid N-PORT XML');
          window.setTimeout(() => setDropzoneState(null, 'Upload / Drop N-PORT XML'), 2200);
        }
      };
      reader.readAsText(file);
    }

    function bindEvents(): void {
      el.themeToggle.addEventListener('click', () => {
        const dark = !document.documentElement.classList.contains('dark');
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
        applyTheme(dark);
      });

      el.searchInput.addEventListener('input', () => {
        setCurrentQuery(el.searchInput.value);
        if (state.activeTab === 'watchlist') resetWatchlistChunk();
        render();
      });

      el.searchClear.addEventListener('click', () => {
        setCurrentQuery('');
        el.searchInput.value = '';
        resetWatchlistChunk();
        render();
        el.searchInput.focus();
      });

      // N-PORT dropzone (iShares dropzone parity)
      if (dropzone && fileInput) {
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (event: Event) => {
          event.preventDefault();
          dropzone.classList.add('dz-active');
        });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dz-active'));
        dropzone.addEventListener('drop', (event: DragEvent) => {
          event.preventDefault();
          dropzone.classList.remove('dz-active');
          if (event.dataTransfer && event.dataTransfer.files.length) handleUploadedFile(event.dataTransfer.files[0]);
        });
        fileInput.addEventListener('change', (event: Event) => {
          const target: any = event.target;
          if (target && target.files && target.files.length) handleUploadedFile(target.files[0]);
        });
      }

      el.copyBtn.addEventListener('click', copyTickers);
      el.exportCsvBtn.addEventListener('click', exportCsv);
      el.exportTxtBtn.addEventListener('click', exportTxt);
      el.resetBtn.addEventListener('click', clearSelectionAndSearch);

      el.blacklistBtn.addEventListener('click', () => {
        toggleBlacklistPanel();
        renderBlacklistPanel();
        fitTableHeight();
      });
      el.blacklistAddBtn.addEventListener('click', submitBlacklistInput);
      el.blacklistInput.addEventListener('keydown', (event: any) => {
        if (event.key === 'Enter') submitBlacklistInput();
      });
      el.blacklistClearBtn.addEventListener('click', clearBlacklist);

      // Paginated sheets: append more rows as the sentinel scrolls into view.
      if (typeof IntersectionObserver === 'function') {
        const observer = new IntersectionObserver(
          entries => {
            if (entries.some(entry => entry.isIntersecting)) maybeLoadMoreRows();
          },
          { root: el.tableScroll, rootMargin: '600px 0px' },
        );
        observer.observe(el.staticLoadSentinel);
      }
      el.staticLoadSentinel.addEventListener('click', () => maybeLoadMoreRows());
      el.tableScroll.addEventListener('scroll', () => {
        const sheet = activeSheetTab();
        if (!sheet || !state.activeFundTicker) return;
        const entry = sheetState.get(sheetKey(sheet));
        if (!entry || entry.loading || entry.nextPage >= entry.manifest.pages.length) return;
        const distanceToBottom = el.tableScroll.scrollHeight - el.tableScroll.scrollTop - el.tableScroll.clientHeight;
        if (distanceToBottom < 600) void loadNextSheetPage(sheet);
      }, { passive: true });

      // Keep only the table scrolling: refit on viewport changes and whenever
      // the content above the table (wrapping toolbar, panels) changes height.
      window.addEventListener('resize', fitTableHeight);
      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(() => fitTableHeight()).observe(document.body);
      }
    }

    function init(): void {
      restoreSelectedEtfs();
      restoreBlacklist();
      restoreSearches();
      restoreSorts();
      applyTheme(localStorage.getItem(THEME_KEY) === 'dark');
      bindEvents();
      syncSearchInput();
      fitTableHeight();
      renderSubtitle();
      void loadCatalog().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        el.tickerCount.textContent = 'Error';
        setStatusRow(`Unable to load api/fidelity/index.json: ${message}. Run bun ./scripts/update-data.ts and serve the folder (for example bunx serve . -p 1234).`, 'error');
      });
    }

  
  
  
