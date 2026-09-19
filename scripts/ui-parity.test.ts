import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the real browser logic without bootstrap/network/DOM painting.
// Rendering and CSS are verified separately in headless Chromium.
function boot() {
  const storage = new Map<string, string>();
  const source = readFileSync(new URL('../app.tsx', import.meta.url), 'utf8').replace(/^\s*init\(\);/m, '');
  const js = new Bun.Transpiler({ loader: 'tsx' }).transformSync(source);
  const context: any = {
    console, setTimeout, clearTimeout,
    document: { activeElement: null, getElementById: () => ({ value: '', classList: { toggle() {} } }) },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
  };
  runInNewContext(js + `
    render = () => {}; renderTabs = () => {}; renderStaticLoadSentinel = () => {};
    globalThis.api = { state, el, sheetState, fundMetaCache, positionIdentity, cleanIdentifier,
      getDedupedWatchlistRows, restoreSearches, persistSearches, clearSelectionAndSearch,
      loadNextSheetPage, ensureHoldingsForSelection, isHoldingsLoading, headerSelectCandidates,
      currentExportRows, getVisibleWatchlistRows, getSelectedTabs,
      setCurrentQuery, syncSearchInput,
      setFetch: fn => { fetchPage = fn; }, resetSheetPaging };
  `, context);
  return { ...context.api, storage, document: context.document };
}

test('Clear preserves explicit sorts while clearing selection and every filter', () => {
  const a = boot();
  a.state.sortByTab = { All: { key: 'ticker', dir: 'desc' }, Bond: { key: 'name', dir: 'asc' } };
  a.state.queryByTab = { All: 'aaa', Bond: 'bond' };
  a.state.selected.add('FAAA');
  a.clearSelectionAndSearch();
  expect(a.state.sortByTab.Bond.key).toBe('name');
  expect(a.state.sortKey).toBe('ticker');
  expect(a.state.sortDir).toBe('desc');
  expect(a.state.selected.size).toBe(0);
  expect(Object.keys(a.state.queryByTab)).toHaveLength(0);
});

test('legacy filter migration is one-time; empty new map never resurrects legacy filters', () => {
  const a = boot();
  a.storage.set('fidelity-searches', JSON.stringify({ All: 'tech', Bond: 'income', bad: 5, blank: '' }));
  a.restoreSearches();
  expect(a.state.queryByTab).toEqual({ All: 'tech', Bond: 'income' });
  a.state.queryByTab = {};
  a.state.activeTab = 'Bond';
  a.persistSearches();
  a.restoreSearches();
  expect(a.state.queryByTab).toEqual({});
  expect(a.state.activeTab).toBe('Bond');
  expect(JSON.parse(a.storage.get('fidelity-site-state')).sheetFilter).toEqual({});
  expect(JSON.parse(a.storage.get('fidelity-searches')).All).toBe('tech');
});

test('legacy scalar and malformed storage are safe', () => {
  const a = boot();
  a.storage.set('fidelity-searches', JSON.stringify('income'));
  a.restoreSearches();
  expect(a.state.queryByTab.All).toBe('income');
  a.storage.set('fidelity-tab-filters', '{broken');
  a.restoreSearches();
  expect(a.state.queryByTab).toEqual({});
});

test('placeholder fallbacks, namespace collisions, numeric local tickers and zero weights', () => {
  const a = boot();
  for (const placeholder of ['', '-', '--', '—', '–', 'N/A', 'NA', 'NONE', 'NULL', '000000000']) {
    expect(a.positionIdentity([placeholder, 'BOND'], ['Ticker', 'Identifier']).key).toBe('D:BOND');
  }
  expect(a.positionIdentity(['005930'], ['Ticker']).key).toBe('T:005930');
  expect(a.positionIdentity(['-', 'cusip', 'isin'], ['Ticker', 'CUSIP', 'ISIN']).key).toBe('C:CUSIP');
  expect(a.positionIdentity(['Cash'], ['Name']).key).toBe('N:CASH');
  a.state.selected.add('TEST');
  a.sheetState.set('TEST:holdings', { headers: ['Ticker', 'Identifier', 'Name', 'Weight'], rows: [['SAME', '', 'Stock', '0'], ['-', 'SAME', 'Bond', '2'], ['--', 'NULL', 'Cash', '0']], nextPage: 0, manifest: { pages: [] } });
  expect(a.getDedupedWatchlistRows()).toHaveLength(3);
  expect(a.getDedupedWatchlistRows().find((r: any) => r.name === 'Stock').weightSum).toBe(0);
});

test('aggregation cache invalidates on row append, selection and same-length upload replacement', () => {
  const a = boot();
  a.state.selected.add('TEST');
  const entry = { headers: ['Ticker'], rows: [['A']], manifest: { pages: [] }, nextPage: 0 };
  a.sheetState.set('TEST:holdings', entry);
  const first = a.getDedupedWatchlistRows();
  expect(a.getDedupedWatchlistRows()).toBe(first);
  entry.rows.push(['B']);
  expect(a.getDedupedWatchlistRows()).toHaveLength(2);
  a.sheetState.set('TEST:holdings', { ...entry, rows: [['C'], ['D']] });
  expect(a.getDedupedWatchlistRows()[0].symbol).toBe('C');
  a.state.selected.clear();
  expect(a.getDedupedWatchlistRows()).toHaveLength(0);
});

test('detail and background share the page queue, even across navigation', async () => {
  const a = boot();
  a.state.selected.add('TEST'); a.state.activeFundTicker = 'TEST';
  a.fundMetaCache.set('TEST', { holdings: { pages: ['1', '2', '3'] } });
  a.sheetState.set('TEST:holdings', { headers: [], rows: [], nextPage: 0, loading: false, manifest: { pages: ['1', '2', '3'] } });
  const calls: string[] = [];
  a.setFetch(async (_ticker: string, page: string) => {
    calls.push(page);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { headers: ['Ticker'], rows: [[page]] };
  });
  const background = a.ensureHoldingsForSelection();
  const detail = a.loadNextSheetPage('holdings');
  a.resetSheetPaging();
  await Promise.all([background, detail, a.ensureHoldingsForSelection()]);
  expect(calls).toEqual(['1', '2', '3']);
  expect(a.sheetState.get('TEST:holdings').rows).toEqual([['1'], ['2'], ['3']]);
  expect(a.isHoldingsLoading()).toBe(false);
});

test('in-flight request cannot overwrite a session upload', async () => {
  const a = boot();
  a.state.activeFundTicker = 'TEST';
  a.sheetState.set('TEST:holdings', { headers: [], rows: [], nextPage: 0, loading: false, manifest: { pages: ['1'] } });
  let release: any;
  a.setFetch(() => new Promise(resolve => { release = resolve; }));
  const load = a.loadNextSheetPage('holdings');
  await new Promise(resolve => setTimeout(resolve, 0));
  const upload = { headers: ['Ticker'], rows: [['UPLOADED']], nextPage: 1, manifest: { pages: [] } };
  a.sheetState.set('TEST:holdings', upload);
  release({ headers: ['Ticker'], rows: [['OLD']] });
  await load;
  expect(a.sheetState.get('TEST:holdings')).toBe(upload);
  expect(upload.rows).toEqual([['UPLOADED']]);
});

test('background concurrency is capped across overlapping selection runs', async () => {
  const a = boot(); let active = 0, max = 0;
  for (let i = 0; i < 12; i++) { const t = `F${i}`; a.state.selected.add(t); a.fundMetaCache.set(t, { holdings: { pages: ['1'] } }); }
  a.setFetch(async (ticker: string) => {
    max = Math.max(max, ++active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return { headers: ['Ticker'], rows: [[ticker]] };
  });
  await Promise.all([a.ensureHoldingsForSelection(), a.ensureHoldingsForSelection()]);
  expect(max).toBeLessThanOrEqual(4);
  expect(a.getDedupedWatchlistRows()).toHaveLength(12);
});

test('header selection scope includes active category, filter and blacklist', () => {
  const a = boot();
  a.state.activeTab = 'Bond'; a.state.queryByTab.Bond = 'income';
  a.state.funds = [
    { ticker: 'A', category: 'Bond', searchIndex: 'income' },
    { ticker: 'B', category: 'Bond', searchIndex: 'growth' },
    { ticker: 'C', category: 'Equity', searchIndex: 'income' },
    { ticker: 'D', category: 'Bond', searchIndex: 'income' },
  ];
  a.state.blacklist.add('D');
  expect(a.headerSelectCandidates().map((f: any) => f.ticker)).toEqual(['A']);
});

test('Watchlist export uses full filtered results rather than the DOM chunk', () => {
  const a = boot(); a.state.activeTab = 'watchlist'; a.state.selected.add('TEST');
  a.sheetState.set('TEST:holdings', { headers: ['Ticker'], rows: Array.from({ length: 501 }, (_, i) => [`SYM${i}`]), nextPage: 1, manifest: { pages: [] } });
  expect(a.currentExportRows().rows).toHaveLength(501);
  a.state.queryByTab.watchlist = 'SYM50';
  expect(a.currentExportRows().rows).toHaveLength(2);
});


test('focused search never carries All ETFs filter into Watchlist; per-tab values survive restore', () => {
  const a = boot();
  a.document.activeElement = a.el.searchInput;
  a.setCurrentQuery('bond income');
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('bond income');
  a.state.activeTab = 'watchlist';
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('');
  a.setCurrentQuery('AAPL');
  a.state.activeTab = 'All';
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('bond income');
  a.state.queryByTab = {};
  a.restoreSearches();
  a.state.activeTab = 'watchlist';
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('AAPL');
  a.setCurrentQuery('');
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('');
  expect(JSON.parse(a.storage.get('fidelity-tab-filters'))).toEqual({ All: 'bond income' });
});

test('synchronous input render preserves spaces while typing multi-word filters', () => {
  const a = boot();
  a.document.activeElement = a.el.searchInput;
  a.setCurrentQuery('bond ');
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('bond ');
  a.setCurrentQuery('bond income');
  a.syncSearchInput();
  expect(a.el.searchInput.value).toBe('bond income');
});
