import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  parseRange,
  parseAumRange,
  normalizeNumberText,
  parseNport,
  parseNportAccessions,
  parseChart,
  priceReturns,
  lastCompletedQuarterEnd,
  annualizedToTotal,
  totalToAnnualized,
  indicatedYield,
  inferDistributionFrequency,
  deriveCatalogMetrics,
  RETURNS_BASIS,
  displayDateToIso,
  normalizeStoredMetrics,
  normalizeIndexRow,
  formatEdgarDate,
  epochToIsoDate,
  normalizeHoldingName,
  normalizeHoldingNameCore,
  pickSearchTicker,
  canHaveListedTicker,
  formatMisses,
  MISS_TTL_DAYS,
  yahooSearchUrl,
  TickerResolver,
  formatHeldTickersSeed,
  CONTROL_NAMES,
  readConfig,
  resolveControls,
  runtimeControls,
  isCertError,
  installSystemCa,
  isNewerAccession,
  nportMayReplace,
  emptyReturnRow,
  returnsBlock,
  samePublishedContent,
  useOutputRoot,
  main,
  fetchWithRetry,
  configureRequestLanes,
  paceRequests,
  setSoftDeadline,
  chartUrl,
  publishedAsOf,
  stalestFirst,
} from './update-data';
import { readFileSync, mkdtempSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HELD_TICKERS } from '../data/held-tickers';

// Clean, portable environment for every test: pinned time zone, no exported control variables,
// and fetch / exit code / deadline / request lanes restored afterwards.
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.TZ = 'UTC';
  for (const key of Object.keys(process.env)) {
    if (CONTROL_NAMES.includes(key as never) || /^(FIDELITY_|HISTORICAL_PAGE_SIZE$)/.test(key)) delete process.env[key];
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.exitCode = 0;
  setSoftDeadline(25 * 60_000);
  configureRequestLanes(1, 1);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const quiet = async (fn: () => Promise<void>): Promise<void> => {
  const log = console.log;
  console.log = () => {};
  try { await fn(); } finally { console.log = log; }
};

// ---------------------------------------------------------------------------
// Inline fixtures: N-PORT XML, Yahoo chart, and a tiny offline SEC + Yahoo world
// ---------------------------------------------------------------------------

const nportFixture = (seriesName: string, positions: string): string => `<?xml version="1.0"?>
<edgarSubmission>
  <headerData><submissionType>NPORT-P</submissionType></headerData>
  <formData>
    <genInfo>
      <regName>Fidelity Covington Trust</regName>
      <regCik>0000945908</regCik>
      <seriesName>${seriesName}</seriesName>
      <seriesId>S000099999</seriesId>
      <repPdDate>2026-06-30</repPdDate>
    </genInfo>
    <invstOrSecs>${positions}</invstOrSecs>
  </formData>
</edgarSubmission>`;

const equityPosition = (name: string, cusip: string, weight: string, value: string, balance: string, assetCat = 'EC'): string => `
      <invstOrSec>
        <name>${name}</name>
        <cusip>${cusip}</cusip>
        <balance>${balance}</balance>
        <units>SH</units>
        <curCd>USD</curCd>
        <valUSD>${value}</valUSD>
        <pctVal>${weight}</pctVal>
        <assetCat>${assetCat}</assetCat>
      </invstOrSec>`;

const day = 86_400;

function chartFixture(options: {
  days?: Array<{ t: number; close: number; adj?: number; volume?: number }>;
  dividends?: Array<{ t: number; amount: number }>;
  meta?: Record<string, unknown>;
}) {
  const days = options.days || [];
  return {
    chart: {
      result: [
        {
          meta: {
            instrumentType: 'ETF',
            fullExchangeName: 'NYSEArca',
            longName: 'Fidelity Test ETF',
            navPrice: 41.25,
            regularMarketPrice: 41.3,
            regularMarketTime: 1_782_000_000,
            firstTradeDate: 1_382_621_400,
            ...options.meta,
          },
          timestamp: days.map((d) => d.t),
          indicators: {
            quote: [{ close: days.map((d) => d.close), volume: days.map((d) => d.volume ?? 0) }],
            adjclose: [{ adjclose: days.map((d) => d.adj ?? d.close) }],
          },
          events: options.dividends
            ? {
                dividends: Object.fromEntries(
                  options.dividends.map((d, i) => [String(i), { date: d.t, amount: d.amount }]),
                ),
              }
            : {},
        },
      ],
    },
  };
}

const world = {
  accessions: {} as Record<string, { series: string; repPd: string }>,
  submissions: {} as Record<string, Array<{ accession: string; filed: string; repPd: string }>>,
  chart: 'ok' as 'ok' | 'down',
  inFlight: 0,
  peak: 0,
  delayMs: 0,
  positions: 1,
  bonds: 0,
  searches: [] as string[],
  searchFails: false,
  order: [] as string[],
  onChart: null as null | (() => void),
};

const nportXml = (series: string, repPd: string): string => `<?xml version="1.0"?>
<edgarSubmission><formData><genInfo><regName>Trust</regName><seriesName>Fidelity ${series}</seriesName><seriesId>${series}</seriesId><repPdDate>${repPd}</repPdDate></genInfo>
<invstOrSecs>${Array.from({ length: world.positions }, (_, i) => `<invstOrSec><name>APPLE ${i} INC</name><cusip>03783310${i}</cusip><balance>10</balance><units>SH</units><curCd>USD</curCd><valUSD>1000</valUSD><pctVal>50</pctVal><assetCat>EC</assetCat></invstOrSec>`).join('')}${Array.from({ length: world.bonds }, (_, i) => `<invstOrSec><name>ACME BOND ${i} LLC</name><cusip>99999${i}</cusip><balance>10</balance><units>PA</units><curCd>USD</curCd><valUSD>10</valUSD><pctVal>1</pctVal><assetCat>${i % 2 ? 'ABS-MBS' : 'DBT'}</assetCat></invstOrSec>`).join('')}</invstOrSecs></formData></edgarSubmission>`;

function worldChart(): Record<string, unknown> {
  const start = Date.UTC(2025, 0, 2) / 1000;
  const days = Array.from({ length: 450 }, (_, i) => ({ t: start + i * day, close: 20 + i / 50, volume: 100 }));
  return chartFixture({ days, dividends: [{ t: start + 200 * day, amount: 0.12 }, { t: start + 300 * day, amount: 0.13 }], meta: { navPrice: undefined, regularMarketTime: start + 449 * day } });
}

function installWorld(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    world.inFlight += 1;
    world.peak = Math.max(world.peak, world.inFlight);
    try {
      if (world.delayMs) await new Promise((resolve) => setTimeout(resolve, world.delayMs));
      const sub = /data\.sec\.gov\/submissions\/CIK(\d+)\.json/.exec(url);
      if (sub) {
        const rows = world.submissions[sub[1]] || [];
        return new Response(JSON.stringify({ filings: { recent: { form: rows.map(() => 'NPORT-P'), accessionNumber: rows.map((r) => r.accession), filingDate: rows.map((r) => r.filed), reportDate: rows.map((r) => r.repPd) } } }));
      }
      const arch = /Archives\/edgar\/data\/\d+\/(\d{18})\/primary_doc\.xml/.exec(url);
      if (arch) {
        const hit = Object.entries(world.accessions).find(([acc]) => acc.replace(/-/g, '') === arch[1]);
        return hit ? new Response(nportXml(hit[1].series, hit[1].repPd)) : new Response('missing', { status: 404 });
      }
      if (url.includes('finance/chart/')) { world.order.push(/finance\/chart\/([A-Z]+)/.exec(url)?.[1] ?? '?'); world.onChart?.(); }
      if (url.includes('finance/chart/')) return world.chart === 'ok' ? new Response(JSON.stringify(worldChart())) : new Response('down', { status: 404 });
      if (url.includes('finance/search')) {
        world.searches.push(decodeURIComponent(/[?&]q=([^&]*)/.exec(url)![1]));
        return world.searchFails ? new Response('busy', { status: 500 }) : new Response(JSON.stringify({ quoteMatches: [] }));
      }
      return new Response('unexpected ' + url, { status: 500 });
    } finally {
      world.inFlight -= 1;
    }
  }) as unknown as typeof fetch;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path.slice(dir.length)] = readFileSync(path, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const fresh = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'fidelity-run-'));
  useOutputRoot(pathToFileURL(root + '/'));
  world.accessions = {
    '0000035402-26-004724': { series: 'S000042567', repPd: '2026-05-31' },
    '0000035402-26-004036': { series: 'S000068173', repPd: '2026-04-30' },
    '0000035402-26-004033': { series: 'S000068175', repPd: '2026-04-30' },
  };
  world.submissions = {};
  world.chart = 'ok';
  world.delayMs = 0;
  world.peak = 0;
  world.positions = 1;
  world.bonds = 0;
  world.searches = [];
  world.searchFails = false;
  world.order = [];
  world.onChart = null;
  setSoftDeadline(25 * 60_000);
  installWorld();
  return root;
};
// Explicit control environment per run (never process.env).
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', CONCURRENCY: '2', REFRESH_CATALOG: 'false', ...extra });
const readJson = (root: string, rel: string): any => JSON.parse(readFileSync(join(root, rel), 'utf8'));
// Runs `fn` in a fresh offline world with a per-test temp dir that is always removed.
async function inWorld(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fresh();
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

describe('controls', () => {
  test('precedence file < advanced < nonblank input < env, empty env wins, brand aliases work', () => {
    const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'FDIS' }, { CONCURRENCY: 3, TICKERS: 'FTEC' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
    expect(c.CONCURRENCY).toBe('6');
    expect(c.TICKERS).toBe('FTEC');
    expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
    expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
    expect(resolveControls({ TICKERS: 'FDIS' }, {}, {}, { TICKERS: '' }).TICKERS).toBe('');
    expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
    // brand aliases: FIDELITY_ prefix wins over the bare name, aliases still map
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { FIDELITY_LIMIT: '7' }).MAX_FETCHES).toBe('7');
    expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { FIDELITY_MAX_FETCHES: '5', MAX_FETCHES: '9', FIDELITY_LIMIT: '7' }).MAX_FETCHES).toBe('5');
    expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '300' }).HISTORY_PAGE_SIZE).toBe('300');
    expect(resolveControls({}, {}, {}, { FIDELITY_STORE_RAW_DOWNLOADS: '1' }).STORE_RAW_DOWNLOADS).toBe('1');
  });

  test('strict validation: bad values, unknown names, CR/LF/NUL are errors, never silent fallbacks', () => {
    const bad: unknown[] = [
      { UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 },
      { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { USE_SYSTEM_CA: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { HISTORY_RANGE: '5 years' },
      { AUM: '5' }, { TER: '1:0' }, { PERFORMANCE_1Y: '5' }, { TICKERS: ['FDIS'] }, { TICKERS: { a: 1 } }, null, [],
    ];
    for (const value of bad) expect(() => resolveControls(value as never), JSON.stringify(value)).toThrow();
    expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
    expect(() => resolveControls({}, {}, { TICKERS: 'A\nB' })).toThrow();
    expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
    expect(() => resolveControls({}, [] as never)).toThrow();
    expect(() => resolveControls({}, {}, {}, { USE_SYSTEM_CA: 'maybe' })).toThrow();
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
    expect(() => parseAumRange('5B')).toThrow(/colon is required/);
  });

  test('range parsers: open bounds, percent and $ signs, K/M/B/T suffixes, AUM presets', () => {
    expect(parseRange('', 'X')).toBeUndefined();
    expect(parseRange(':', 'X')).toBeUndefined();
    expect(parseRange('1:5', 'X')).toEqual({ min: 1, max: 5 });
    expect(parseRange('2:', 'X')).toEqual({ min: 2, max: undefined });
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 });
    expect(parseRange('$1:$2', 'X')).toEqual({ min: 1, max: 2 });
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('1.5T:')).toEqual({ min: 1.5e12, max: undefined });
    expect(parseAumRange('nano')).toEqual({ min: 0, max: 10_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('scheduled run equals the config file defaults; keys match CONTROL_NAMES; SEC contact is the owner default', async () => {
    const file = JSON.parse(read('scripts/update-data.config.json'));
    expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
    for (const value of Object.values(file)) expect(typeof value).toBe('string');
    expect(file.SEC_UA).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(file.USE_SYSTEM_CA).toBe('auto');
    const scheduled = resolveControls(file, {}, {}, {});
    expect(scheduled).toEqual(file);
    const config = readConfig(scheduled);
    expect(config.tickers).toEqual([]);
    expect([config.maxFetches, config.requestSleep, config.concurrency, config.maxRetries]).toEqual([0, 1, 2, 2]);
    expect([config.holdingsPageSize, config.historyPageSize, config.historyRange]).toEqual([250, 1000, 'max']);
    expect([config.storeRawDownloads, config.skipYahoo, config.refreshCatalog]).toEqual([false, false, true]);
    expect(config.aumRange).toBeUndefined();
    expect(config.performanceRanges).toEqual({});
    expect(config.secUa).toBe('daggerok ETF feed daggerok@gmail.com');
    expect(await runtimeControls({})).toEqual(scheduled);
    expect((await runtimeControls({ TICKERS: 'FTEC' })).TICKERS).toBe('FTEC');
  });

  test('USE_SYSTEM_CA: case-insensitive values, cert errors detected, restart happens once and only for cert errors', async () => {
    for (const value of ['auto', 'true', 'false', 'AUTO', 'True', 'FALSE']) expect(resolveControls({}, { USE_SYSTEM_CA: value }).USE_SYSTEM_CA).toBe(value);
    expect(isCertError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' })).toBe(true);
    expect(isCertError(Object.assign(new Error('fetch failed'), { cause: new Error('unable to get local issuer certificate') }))).toBe(true);
    expect(isCertError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isCertError(null)).toBe(false);

    let calls = 0;
    const reexec = (() => { calls++; throw new Error('reexec'); }) as () => never;
    globalThis.fetch = (async () => new Response('ok')) as unknown as typeof fetch;
    const before = globalThis.fetch;
    installSystemCa('false', reexec, false);
    installSystemCa('auto', reexec, true);
    expect(globalThis.fetch).toBe(before);
    expect(calls).toBe(0);
    expect(() => installSystemCa('true', reexec, false)).toThrow('reexec');
    expect(calls).toBe(1);

    globalThis.fetch = (async () => { throw Object.assign(new Error('fetch failed'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid')).rejects.toThrow('reexec');
    expect(calls).toBe(2);
    globalThis.fetch = (async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
    installSystemCa('auto', reexec, false);
    await expect(fetch('https://example.invalid')).rejects.toThrow('reset');
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('N-PORT holdings: weights, values, balances; bond rows fall back to ISIN; empty body gives zero rows', () => {
    const parsed = parseNport(
      nportFixture(
        'Fidelity Metaverse ETF',
        equityPosition('EQUINIX INC', '29444U700', '4.250000', '12345678.90', '1.97000000e2') +
          equityPosition('DIGITAL REALTY TRUST INC', '253868103', '3.100000', '8765432.10', '8768.00000000'),
      ),
    );
    expect([parsed.seriesName, parsed.seriesId, parsed.repPdDate]).toEqual(['Fidelity Metaverse ETF', 'S000099999', '2026-06-30']);
    expect(parsed.holdings).toHaveLength(2);
    expect(parsed.holdings[0]).toEqual({
      Name: 'EQUINIX INC',
      Ticker: '-',
      Identifier: '29444U700',
      Weight: '4.25',
      'Market Value': '12345678.9',
      'Shares Held': '197',
      'Asset Category': 'EC',
    });
    expect(parsed.totalValue).toBeCloseTo(12345678.9 + 8765432.1, 4);

    const bond = parseNport(
      nportFixture(
        'Fidelity Total Bond ETF',
        `<invstOrSec><name>US TREASURY N/B</name><cusip>N/A</cusip>
        <identifiers><isin value="US91282CDX75"/><other value="91282CDX7"/></identifiers>
        <balance>1000000.00000000</balance><curCd>USD</curCd><valUSD>990000.00</valUSD><pctVal>2.500000</pctVal><assetCat>DB</assetCat></invstOrSec>`,
      ),
    );
    expect(bond.holdings[0].Identifier).toBe('US91282CDX75');
    expect(bond.holdings[0].Ticker).toBe('-');
    expect(bond.holdings[0]['Asset Category']).toBe('DB');

    const empty = parseNport(nportFixture('Fidelity Test ETF', ''));
    expect(empty.holdings).toHaveLength(0);
    expect(empty.totalValue).toBe(0);
  });

  test('N-PORT freshness: only NPORT-P forms, only a strictly newer filing, never an older report period', () => {
    const accessions = parseNportAccessions({
      filings: {
        recent: {
          form: ['NPORT-P', 'N-CEN', 'NPORT-P', '4'],
          accessionNumber: ['0000035402-26-001', '0000035402-26-002', '0000035402-26-003', '0000035402-26-004'],
          filingDate: ['2026-08-24', '2026-08-01', '2026-07-20', '2026-08-25'],
          reportDate: ['2026-06-30', '', '2026-05-31', ''],
        },
      },
    });
    expect(accessions.map((a) => a.accession)).toEqual(['0000035402-26-001', '0000035402-26-003']);
    expect(accessions[1].reportDate).toBe('2026-05-31');

    const seed = { accession: 'A-1', filed: '2026-06-26', reportDate: '2026-04-30', url: '' };
    expect(isNewerAccession(undefined, { accession: 'A-2', filed: '2026-01-01', reportDate: '' })).toBe(true);
    expect(isNewerAccession(seed, { accession: 'A-2', filed: '2026-09-25', reportDate: '2026-07-31' })).toBe(true);
    expect(isNewerAccession(seed, { accession: 'A-1', filed: '2026-09-25', reportDate: '2026-07-31' })).toBe(false);
    expect(isNewerAccession(seed, { accession: 'A-0', filed: '2026-05-01', reportDate: '2026-03-31' })).toBe(false);
    expect(isNewerAccession(seed, { accession: 'A-3', filed: '2026-09-25', reportDate: '2026-02-28' })).toBe(false);
    expect(nportMayReplace('2026-06-30', '2026-05-31')).toBe(false);
    expect(nportMayReplace('2026-06-30', '2026-06-30')).toBe(true);
    expect(nportMayReplace('2026-06-30', '2026-07-31')).toBe(true);
    expect(nportMayReplace(null, '2026-05-31')).toBe(true);
  });

  test('Yahoo chart: skips null closes, falls back to raw closes, sorts dividends and drops non-positive ones', () => {
    const base = 1_700_000_000;
    const parsed = parseChart(
      chartFixture({
        days: [
          { t: base, close: 10, adj: 9.5, volume: 100 },
          { t: base + day, close: null as unknown as number },
          { t: base + 2 * day, close: 11, adj: 10.45, volume: 200 },
        ],
      }),
    );
    expect(parsed.days).toHaveLength(2);
    expect(parsed.days[0].adjClose).toBe(9.5);
    expect(parsed.days[1].close).toBe(11);
    expect(parsed.exchangeName).toBe('NYSEArca');
    expect(parsed.navPrice).toBe(41.25);

    const noAdj = chartFixture({ days: [{ t: base, close: 10.5 }] });
    delete (noAdj.chart.result[0].indicators as Record<string, unknown>).adjclose;
    expect(parseChart(noAdj as never).days[0].adjClose).toBe(10.5);

    const divs = parseChart(chartFixture({ dividends: [{ t: 1_700_000_000, amount: 0.17 }, { t: 1_600_000_000, amount: 0.15 }, { t: 1_500_000_000, amount: 0 }] }));
    expect(divs.dividends.map((d) => d.amount)).toEqual([0.15, 0.17]);
  });

  test('number and date text: scientific notation expanded, missing values stay text, EDGAR dates and epochs are UTC', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
    for (const text of ['12.34', 'N/A', '-', '']) expect(normalizeNumberText(text)).toBe(text);
    expect(formatEdgarDate('2026-06-30')).toBe('Jun 30 2026');
    expect(formatEdgarDate('')).toBe('');
    expect(epochToIsoDate(1_782_000_000)).toBe('2026-06-21');
    expect(epochToIsoDate(1_782_000_000)).toBe(new Date(1_782_000_000 * 1000).toISOString().slice(0, 10));
  });

  test('holding names: legal suffixes stripped, junk is empty, search match is by name, seed formatting is deterministic', () => {
    expect(normalizeHoldingName('DIGITAL OCEAN HOLDINGS INC')).toBe('DIGITAL OCEAN');
    expect(normalizeHoldingName('DigitalOcean Holdings, Inc.')).toBe('DIGITALOCEAN');
    expect(normalizeHoldingName('Brown-Forman Corp')).toBe('BROWN FORMAN');
    expect(normalizeHoldingName('A.O. Smith Corporation')).toBe('A O SMITH');
    expect(normalizeHoldingName('US TREASURY N/B')).toBe('US TREASURY N B');
    expect(normalizeHoldingNameCore('DIGITAL OCEAN HOLDINGS')).toBe('DIGITALOCEAN');
    for (const junk of ['', null, '---']) expect(normalizeHoldingName(junk as never)).toBe('');

    const payload = {
      quoteMatches: [
        { symbol: 'WRONG', longname: 'Something Else Inc', quoteType: 'EQUITY' },
        { symbol: 'DOCN', longname: 'DigitalOcean Holdings, Inc.', quoteType: 'EQUITY' },
        { symbol: 'DOCNW', longname: 'DigitalOcean Holdings, Inc. Warrant', quoteType: 'EQUITY' },
      ],
    };
    expect(pickSearchTicker('DIGITAL OCEAN HOLDINGS INC', payload)).toBe('DOCN');
    expect(pickSearchTicker('SOMETHING ENTIRELY DIFFERENT LTD', payload)).toBeNull();
    expect(pickSearchTicker('DIGITAL OCEAN HOLDINGS INC', { quoteMatches: [{ symbol: 'EURUSD=X', longname: 'Euro US Dollar', quoteType: 'CURRENCY' }] })).toBeNull();
    expect(pickSearchTicker('BULLISH', {})).toBeNull();
    expect(pickSearchTicker('BULLISH', { quoteMatches: [{ symbol: 'BLSH', longname: 'Bullish BLCM Inc', quoteType: 'EQUITY' }] })).toBe('BLSH');
    expect(yahooSearchUrl('DIGITAL OCEAN')).toBe('https://query1.finance.yahoo.com/v1/finance/search?q=DIGITAL%20OCEAN&quotesCount=10&newsCount=0&enableFuzzyQuery=false');

    const seed = formatHeldTickersSeed({ B: 'BB', A: 'AA', 'a10 networks inc': 'A' });
    expect(seed).toBe(formatHeldTickersSeed({ 'a10 networks inc': 'A', B: 'BB', A: 'AA' }));
    expect(seed.indexOf('"A"')).toBeLessThan(seed.indexOf('"a10 networks inc"'));
    expect(seed.indexOf('"a10 networks inc"')).toBeLessThan(seed.indexOf('"B"'));
    const dropped = formatHeldTickersSeed({ '': 'XX', 'VALID INC': '', GOOD: 'GD' });
    expect(dropped).not.toContain('XX');
    expect(dropped).not.toContain('"VALID INC"');
    expect(formatHeldTickersSeed({ 'SCE TRUST VI': 'sce^l' })).toContain('"SCE^L"');
    for (const [name, ticker] of Object.entries(HELD_TICKERS)) {
      expect(name.length > 0 && ticker.length > 0, `bad seed entry ${name} -> ${ticker}`).toBe(true);
    }
  });

  test('ticker resolver: seed by exact/normalized name, memoized search, failures degrade to "-", ambiguous keys give no guess', async () => {
    const seeded = new TickerResolver({ 'DIGITALOCEAN HOLDINGS INC': 'DOCN', '3M CO': 'MMM', 'SCE TRUST VI': 'SCE^L', 'BERKSHIRE HATHAWAY INC': 'BRK-B' });
    expect(seeded.lookup('DigitalOcean Holdings Inc')).toBe('DOCN');
    expect(seeded.lookup('DIGITAL OCEAN HOLDINGS')).toBe('DOCN');
    expect(seeded.lookup('3M Company')).toBe('MMM');
    expect(seeded.lookup('NOBODY HERE INC')).toBeNull();
    expect(seeded.lookup('SCE TRUST VI')).toBe('SCE^L');
    expect(seeded.lookup('Berkshire Hathaway Inc')).toBe('BRK-B');
    expect(await seeded.resolve('UNKNOWN NAME INC')).toBe('-');
    const ambiguous = new TickerResolver({ 'ACME INC': 'ACME', 'ACME CO': 'ACMX' });
    expect(ambiguous.lookup('ACME')).toBeNull();
    expect(ambiguous.lookup('ACME INC')).toBe('ACME');

    const seen: string[] = [];
    const learning = new TickerResolver({}, async (name) => {
      seen.push(name);
      return name === 'BULLISH' ? 'BLSH' : null;
    });
    expect(await learning.resolve('BULLISH')).toBe('BLSH');
    expect(await learning.resolve('Bullish')).toBe('BLSH');
    expect(await learning.resolve('SOME PRIVATE CLO 7 LTD')).toBe('-');
    expect(await learning.resolve('SOME PRIVATE CLO 7 LTD')).toBe('-');
    expect(seen).toEqual(['BULLISH', 'SOME PRIVATE CLO 7 LTD']);
    expect(learning.freshEntries()).toEqual({ BULLISH: 'BLSH' });

    let calls = 0;
    const failing = new TickerResolver({}, async () => { calls += 1; throw new Error('offline'); });
    expect(await failing.resolve('SOME PRIVATE LLC')).toBe('-');
    expect(await failing.resolve('SOME PRIVATE LLC')).toBe('-');
    expect(calls).toBe(1);
  });

  test('search misses: asset category gate, TTL, a hit overrides a miss, failures are never remembered, file is sorted', async () => {
    for (const code of ['EC', 'EP', '', undefined, 'OTHER']) expect(canHaveListedTicker(code), String(code)).toBe(true);
    for (const code of ['DBT', 'ABS-MBS', 'ABS-CBDO', 'LON', 'STIV', 'RA', 'DE', 'DFE', 'dbt']) expect(canHaveListedTicker(code), code).toBe(false);

    const seen: string[] = [];
    const search = async (name: string): Promise<string | null> => { seen.push(name); return name === 'NOW LISTED INC' ? 'NWLD' : null; };
    // debt rows are never searched, but a name the seed knows still resolves for any category
    const first = new TickerResolver({ 'BOEING CO': 'BA' }, search, {}, '2026-10-03');
    expect(await first.resolve('ACME BOND LLC', 'DBT')).toBe('-');
    expect(await first.resolve('BOEING CO', 'DBT')).toBe('BA');
    expect(await first.resolve('PRIVATE ONE LLC', 'EC')).toBe('-');
    expect(await first.resolve('PRIVATE TWO LLC', undefined)).toBe('-');
    expect(seen).toEqual(['PRIVATE ONE LLC', 'PRIVATE TWO LLC']);
    expect(first.missEntries()).toEqual({ 'PRIVATE ONE LLC': '2026-10-03', 'PRIVATE TWO LLC': '2026-10-03' });

    // inside the TTL a remembered miss is not searched again; at the TTL it is, and the date moves
    const persisted = first.missEntries();
    seen.length = 0;
    const within = new TickerResolver({}, search, persisted, '2026-11-01');
    expect(await within.resolve('Private One LLC', 'EC')).toBe('-');
    expect(seen).toEqual([]);
    const expired = new TickerResolver({}, search, persisted, '2026-11-02');
    expect(MISS_TTL_DAYS).toBe(30);
    expect(await expired.resolve('Private One LLC', 'EC')).toBe('-');
    expect(seen).toEqual(['Private One LLC']);
    expect(expired.missEntries()['PRIVATE ONE LLC']).toBe('2026-11-02');
    expect(expired.missEntries()['PRIVATE TWO LLC']).toBe('2026-10-03');
    // entries nobody refreshed for 90 days are pruned
    expect(new TickerResolver({}, search, persisted, '2027-01-02').missEntries()).toEqual({});

    // an expired miss that is a hit now: the ticker is learned and the miss disappears
    const hit = new TickerResolver({}, search, { 'NOW LISTED': '2026-08-01' }, '2026-10-03');
    expect(await hit.resolve('NOW LISTED INC', 'EC')).toBe('NWLD');
    expect(hit.missEntries()).toEqual({});
    // a name that the seed knows by now is dropped even when still within its TTL
    expect(new TickerResolver({ 'NOW LISTED INC': 'NWLD' }, search, { 'NOW LISTED': '2026-10-01' }, '2026-10-03').missEntries()).toEqual({});

    // a failed request (offline, throttled) is retried next run, never remembered
    const failing = new TickerResolver({}, async () => { throw new Error('429'); }, {}, '2026-10-03');
    expect(await failing.resolve('FLAKY LLC', 'EC')).toBe('-');
    expect(failing.missEntries()).toEqual({});

    expect(formatMisses({ B: '2026-10-03', A: '2026-10-01' })).toBe('{\n  "A": "2026-10-01",\n  "B": "2026-10-03"\n}\n');
    expect(formatMisses({})).toBe('{}\n');
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  const mk = (iso: string, adjClose: number) => ({ date: iso, close: adjClose, adjClose, volume: 0 });
  const days = [
    mk('2020-01-02', 60), mk('2023-06-30', 90), mk('2025-06-30', 100), mk('2025-12-31', 108), mk('2026-01-02', 110),
    mk('2026-03-31', 114), mk('2026-05-29', 118), mk('2026-06-29', 119), mk('2026-06-30', 120),
  ];

  test('price returns anchor to the last close; quarter ends anchor to the last completed quarter', () => {
    const returns = priceReturns(days, new Date('2026-06-30T23:59:00Z'));
    expect(returns.asOfDate).toBe('2026-06-30');
    expect(returns.ytd).toBeCloseTo(((120 - 108) / 108) * 100, 2);
    expect(returns.yr1).toBeCloseTo(((120 - 100) / 100) * 100, 2);
    expect(returns.cagr3y).toBeCloseTo(((120 / 90) ** (1 / 3) - 1) * 100, 2);
    expect(lastCompletedQuarterEnd(new Date('2026-08-26T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(lastCompletedQuarterEnd(new Date('2026-01-15T00:00:00Z')).toISOString().slice(0, 10)).toBe('2025-12-31');
  });

  test('young funds get null for horizons they are too young for, never 0 or made-up values', () => {
    const returns = priceReturns([mk('2026-06-01', 100), mk('2026-06-30', 101)], new Date('2026-06-30T23:59:00Z'));
    expect([returns.cagr3y, returns.cagr5y, returns.cagr10y, returns.siAnn]).toEqual([null, null, null, null]);
    expect(priceReturns([]).asOfDate).toBe('');
    const none = deriveCatalogMetrics(priceReturns([]), null, null, null);
    expect(none.performanceAsOf).toBeNull();
    expect(none.dividendYield).toBeNull();
    expect(none.dividendYieldText).toBe('—');
  });

  test('conversions, indicated yield and distribution frequency (None without distributions)', () => {
    expect(annualizedToTotal(10, 2)).toBeCloseTo(21, 6);
    expect(totalToAnnualized(annualizedToTotal(10, 2), 2)).toBeCloseTo(10, 6);
    expect(annualizedToTotal(Number.NaN, 2)).toBeNull();
    expect(indicatedYield(0.1, 4, 40)).toBeCloseTo(1.0, 6);
    expect(indicatedYield(null, 4, 40)).toBeNull();
    expect(indicatedYield(0.1, 4, 0)).toBeNull();
    const dates = (ms: number[]) => ms.map((t) => ({ epoch: t, amount: 0.1 }));
    const quarter = 91 * day;
    expect(inferDistributionFrequency(dates([1_700_000_000, 1_700_000_000 + quarter, 1_700_000_000 + 2 * quarter, 1_700_000_000 + 3 * quarter])).frequency).toBe('Quarterly');
    expect(inferDistributionFrequency([]).frequency).toBe('None');
  });

  test('catalog metrics: CAGRs map directly, TRs derive, SEC yield null, returnsBasis and performanceAsOf travel together', () => {
    const returns = { asOfDate: '2026-06-30', ytd: 9.09, yr1: 20, cagr3y: 10, cagr5y: 8, cagr10y: null, siAnn: 12.5, mo1: 0.85, qtd: 5.26 };
    const metrics = deriveCatalogMetrics(returns, 0.1, 4, 40);
    expect(metrics.cagr3y).toBe(10);
    expect(metrics.tr3y).toBeCloseTo(33.1, 2);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.dividendYield).toBeCloseTo(1.0, 6);
    expect(metrics.secYield).toBeNull();
    expect(metrics.returnsBasis).toBe(RETURNS_BASIS);
    expect(String(metrics.returnsBasis).trim()).not.toBe('');
    expect(metrics.performanceAsOf).toBe('2026-06-30');
    expect(Object.keys(metrics).slice(-2)).toEqual(['returnsBasis', 'performanceAsOf']);
    expect(deriveCatalogMetrics(priceReturns([]), null, null, null).returnsBasis).toBe(RETURNS_BASIS);
  });

  test('stored rows gain basis and as-of from the returns table; returns block rows share one key set', () => {
    expect(displayDateToIso('Sep 25 2026')).toBe('2026-09-25');
    expect(displayDateToIso('—')).toBeNull();
    const old = { ytd: 1, secYield: null };
    const out = normalizeStoredMetrics(old, { monthEnd: { asOfDate: 'Sep 25 2026' } });
    expect(Object.keys(out)).toEqual(['ytd', 'secYield', 'secYieldText', 'returnsBasis', 'performanceAsOf']);
    expect(out.performanceAsOf).toBe('2026-09-25');
    expect(normalizeStoredMetrics(old, null).performanceAsOf).toBeNull();
    expect(normalizeStoredMetrics({ ...out, performanceAsOf: '2026-09-01' }, null).performanceAsOf).toBe('2026-09-01');
    const row = normalizeIndexRow({ ticker: 'X', metrics: old, returns: { monthEnd: { asOfDate: 'Sep 25 2026' } } });
    expect((row.metrics as Record<string, unknown>).performanceAsOf).toBe('2026-09-25');

    const series = Array.from({ length: 400 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), close: 10 + i / 100, adjClose: 10 + i / 100, volume: 1 }));
    const block = returnsBlock(priceReturns(series), {}) as Record<string, any>;
    expect(Object.keys(block.quarterEnd)).not.toContain('null');
    expect(Object.keys(block.quarterEnd).sort()).toEqual(Object.keys(block.monthEnd).sort());
    expect(block.quarterEnd.yr1).toBeNull();
    expect(emptyReturnRow('Jun 30 2026').ytdText).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// pipeline (mocked fetch, 3-fund catalog)
// ---------------------------------------------------------------------------

describe('pipeline', () => {
  test('a one-ticker run keeps every row and file, all rows share one metrics key set, every dataFile exists', async () => {
    await inWorld(async (root) => {
      await quiet(() => main(env({ TICKERS: 'FBND FBCG FBCV' })));
      expect(readJson(root, 'index.json').funds).toHaveLength(3);
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const index = readJson(root, 'index.json');
      expect(index.funds.map((f: any) => f.ticker)).toEqual(['FBCG', 'FBCV', 'FBND']);
      expect(readdirSync(join(root, 'funds')).sort()).toEqual(['FBCG', 'FBCV', 'FBND']);
      const keySets = new Set(index.funds.map((f: any) => Object.keys(f.metrics).sort().join(',')));
      expect(keySets.size).toBe(1);
      for (const fund of index.funds) {
        expect(fund.dataFile).toBe(`./funds/${fund.ticker}/meta.json`);
        expect(statSync(join(root, fund.dataFile)).isFile()).toBe(true);
        expect(fund.metrics.returnsBasis).toBeTruthy();
      }
    });
  });

  test('a second identical run writes nothing (zero diff)', async () => {
    await inWorld(async (root) => {
      const run = () => quiet(() => main(env({ TICKERS: 'FBND FBCG' })));
      await run();
      const first = snapshot(root);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
      await run();
      expect(snapshot(root)).toEqual(first);
      expect(samePublishedContent('{"generatedAt":"old","funds":[{"ticker":"FAAA"}]}', { generatedAt: 'new', funds: [{ ticker: 'FAAA' }] })).toBe(true);
      expect(samePublishedContent('{"generatedAt":"old","funds":[]}', { generatedAt: 'new', funds: [{ ticker: 'FAAA' }] })).toBe(false);
    });
  });

  test('search misses are remembered: debt rows are never searched, a rerun sends no search and writes nothing, failures leave no state', async () => {
    await inWorld(async (root) => {
      world.positions = 3;
      world.bonds = 4;
      const missesFile = join(root, 'held-ticker-misses.json');
      const run = () => quiet(() => main(env({ TICKERS: 'FBND FBCG FBCV' })));
      await run();
      // three funds hold the same 3 equity names and 4 bond names: 3 searches in total, none for bonds
      expect(world.searches.slice().sort()).toEqual(['APPLE 0 INC', 'APPLE 1 INC', 'APPLE 2 INC']);
      const written = readFileSync(missesFile, 'utf8');
      const keys = Object.keys(JSON.parse(written));
      expect(keys).toEqual(['APPLE 0', 'APPLE 1', 'APPLE 2']);
      expect(written).toBe(formatMisses(JSON.parse(written)));
      const first = snapshot(root);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
      world.searches = [];
      await run();
      expect(world.searches).toEqual([]);
      expect(snapshot(root)).toEqual(first);
      expect(Object.values(readJson(root, 'funds/FBND/holdings/001.json').rows.map((r: any) => r.Ticker)).every((t) => t === '-')).toBe(true);
    });
    await inWorld(async (root) => {
      world.positions = 2;
      world.searchFails = true;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(world.searches.length).toBeGreaterThan(0);
      expect(Object.keys(snapshot(root)).some((name) => name.endsWith('held-ticker-misses.json'))).toBe(false);
    });
  });

  test('a failed source keeps the fund exactly as published; nav and premium stay null with an honest as-of', async () => {
    await inWorld(async (root) => {
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const meta = readJson(root, 'funds/FBND/meta.json');
      expect(meta.nav).toEqual({ display: '—', value: null, asOfDate: '—' });
      expect(meta.premiumDiscount.value).toBeNull();
      expect(JSON.stringify(meta.returns)).not.toContain('"null"');
      const price = meta.marketPrice.value;
      expect(price).toBeGreaterThan(0);
      const metricsBefore = readJson(root, 'index.json').funds[0].metrics;
      world.chart = 'down';
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const after = readJson(root, 'funds/FBND/meta.json');
      expect(after.marketPrice).toEqual(meta.marketPrice);
      expect(after.distributions).toEqual(meta.distributions);
      expect(readJson(root, 'index.json').funds).toHaveLength(1);
      expect(readJson(root, 'index.json').funds[0].metrics).toEqual(metricsBefore);
    });
  });

  test('REFRESH_CATALOG moves a series to its newer filing; an older filing never replaces fresher holdings', async () => {
    await inWorld(async (root) => {
      world.accessions['0000035402-26-009999'] = { series: 'S000042567', repPd: '2026-07-31' };
      world.accessions['0000035402-26-009998'] = { series: 'S000068173', repPd: '2026-07-31' };
      world.submissions['0001562565'] = [
        { accession: '0000035402-26-009999', filed: '2026-09-25', repPd: '2026-07-31' },
        { accession: '0000035402-26-004724', filed: '2026-07-24', repPd: '2026-05-31' },
      ];
      // a filing of an unknown series must be ignored (identity check)
      world.accessions['0000035402-26-009997'] = { series: 'S000000001', repPd: '2026-08-31' };
      world.submissions['0000945908'] = [{ accession: '0000035402-26-009997', filed: '2026-09-26', repPd: '2026-08-31' }];
      await quiet(() => main(env({ TICKERS: 'FBND FBCG', REFRESH_CATALOG: 'true' })));
      const fbnd = readJson(root, 'funds/FBND/meta.json');
      expect(fbnd.holdings.asOf).toBe('Jul 31 2026');
      expect(fbnd.source.nportDoc).toContain('000003540226009999');
      expect(fbnd.seed.accession).toBe('0000035402-26-009999');
      expect(readJson(root, 'funds/FBCG/meta.json').holdings.asOf).toBe('Apr 30 2026');

      // published holdings are fresher than the seed accession: a rerun must keep them
      const meta = readJson(root, 'funds/FBND/meta.json');
      meta.holdings.asOf = 'Sep 30 2026';
      writeFileSync(join(root, 'funds/FBND/meta.json'), JSON.stringify(meta));
      world.submissions['0001562565'] = [];
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(readJson(root, 'funds/FBND/meta.json').holdings.asOf).toBe('Sep 30 2026');
    });
  });

  test('MAX_FETCHES cursor advances, TICKERS runs leave it alone, unknown tickers are errors, a past soft deadline keeps all rows', async () => {
    await inWorld(async (root) => {
      await quiet(() => main(env({ MAX_FETCHES: '1' })));
      expect(readJson(root, 'update-state.json').cursor).toBe('FAAA');
      await quiet(() => main(env({ MAX_FETCHES: '1' })));
      expect(readJson(root, 'update-state.json').cursor).toBe('FBCG');
      expect(readJson(root, 'index.json').funds.map((f: any) => f.ticker)).toEqual(['FAAA', 'FBCG']);
      await quiet(() => main(env({ TICKERS: 'FBND', MAX_FETCHES: '1' })));
      expect(readJson(root, 'update-state.json').cursor).toBe('FBCG');
      await expect(quiet(() => main(env({ TICKERS: 'FBND NOPE' })))).rejects.toThrow('NOPE');
      await quiet(() => main(env()));
      expect(readJson(root, 'update-state.json').cursor).toBeNull();
      const rows = readJson(root, 'index.json').funds.length;
      setSoftDeadline(-1);
      await quiet(() => main(env()));
      expect(readJson(root, 'index.json').funds).toHaveLength(rows);
    });
  });

  test('stalest fund first: a deadline-truncated run refreshes the stalest, the next runs pick up the skipped funds', async () => {
    await inWorld(async (root) => {
      await quiet(() => main(env({ TICKERS: 'FAAA FBCG FBCV' })));
      // published as-of dates: FBCG stalest, then FAAA, then FBCV (alphabetical order would be FAAA, FBCG, FBCV)
      const index = readJson(root, 'index.json');
      const asOf: Record<string, [string, string]> = { FBCG: ['Jan 10 2026', '2026-01-10'], FAAA: ['Feb 10 2026', '2026-02-10'], FBCV: ['Mar 01 2026', '2026-03-01'] };
      for (const row of index.funds) {
        row.asOfDate = asOf[row.ticker][0];
        row.metrics.performanceAsOf = asOf[row.ticker][1];
      }
      writeFileSync(join(root, 'index.json'), JSON.stringify(index));
      const published = new Map<string, any>(index.funds.map((row: any) => [row.ticker, row]));
      expect(stalestFirst([{ ticker: 'FAAA' }, { ticker: 'FBCG' }, { ticker: 'FBCV' }, { ticker: 'ZNEW' }], published).map((f) => f.ticker)).toEqual(['ZNEW', 'FBCG', 'FAAA', 'FBCV']);
      expect(publishedAsOf({ ...index.funds[0], dataFile: null })).toBeNull();

      // fake clock: every chart request "takes" 2 minutes, the soft deadline is 1 minute, so each run handles exactly one fund
      const realNow = Date.now;
      let clock = realNow();
      Date.now = () => clock;
      const summary = join(root, 'summary.md');
      process.env.GITHUB_STEP_SUMMARY = summary;
      try {
        world.onChart = () => { clock += 120_000; };
        const runs: string[][] = [];
        for (let run = 0; run < 3; run++) {
          world.order = [];
          setSoftDeadline(60_000);
          await quiet(() => main(env({ TICKERS: 'FAAA FBCG FBCV', CONCURRENCY: '1' })));
          runs.push(world.order);
        }
        expect(runs).toEqual([['FBCG'], ['FAAA'], ['FBCV']]);
        expect(readFileSync(summary, 'utf8')).toContain('1 of 3 funds refreshed, 2 keep their previously published data, oldest remaining published as-of: 2026-02-10 (FAAA)');
        world.order = [];
        setSoftDeadline(25 * 60_000);
        await quiet(() => main(env({ TICKERS: 'FAAA FBCG FBCV', CONCURRENCY: '1' })));
        expect(world.order).toHaveLength(3); // a run that finishes every fund reports no deadline
        expect(readFileSync(summary, 'utf8').match(/soft deadline/g)).toHaveLength(3);
        expect(readJson(root, 'index.json').funds).toHaveLength(3);
        expect(readJson(root, 'index.json').funds.every((f: any) => f.asOfDate === 'Mar 27 2026')).toBe(true);
      } finally {
        Date.now = realNow;
      }
    });
  });

  test('writes are atomic (no temp files) and stale holdings pages go only after the new meta is written', async () => {
    await inWorld(async (root) => {
      world.positions = 2;
      await quiet(() => main(env({ TICKERS: 'FBND', HOLDINGS_PAGE_SIZE: '1' })));
      expect(readdirSync(join(root, 'funds/FBND/holdings')).sort()).toEqual(['001.json', '002.json']);
      world.positions = 1;
      await quiet(() => main(env({ TICKERS: 'FBND', HOLDINGS_PAGE_SIZE: '1' })));
      expect(readdirSync(join(root, 'funds/FBND/holdings')).sort()).toEqual(['001.json']);
      expect(readJson(root, 'funds/FBND/meta.json').holdings.pages).toEqual(['holdings/001.json']);
      expect(Object.keys(snapshot(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// network
// ---------------------------------------------------------------------------

describe('network', () => {
  test('every request carries a timeout: a hanging server is aborted and retries are bounded', async () => {
    let calls = 0;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // no signal: hangs forever and the test times out
        signal.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });
    }) as unknown as typeof fetch;
    configureRequestLanes(1, 0);
    const guard = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('hung: request has no timeout signal')), 3000));
    await expect(Promise.race([fetchWithRetry('https://example.invalid/x', '[t]', {}, 1, 30), guard])).rejects.toThrow('network error');
    expect(calls).toBe(2);
  });

  test('pacing reserves the lane slot synchronously: concurrent callers on one lane are spaced in order', async () => {
    configureRequestLanes(1, 0.1);
    const starts: number[] = [];
    await Promise.all([0, 1, 2].map(async () => { await paceRequests(); starts.push(Date.now()); }));
    expect(starts[1]).toBeGreaterThan(starts[0]);
    expect(starts[2]).toBeGreaterThan(starts[1]);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(100);
  });

  test('CONCURRENCY is real: peak in-flight requests is 1 at c=1 and 3 at c=3', async () => {
    for (const [concurrency, peak] of [['1', 1], ['3', 3]] as const) {
      await inWorld(async () => {
        world.delayMs = 40;
        await quiet(() => main(env({ TICKERS: 'FBND FBCG FBCV', CONCURRENCY: concurrency })));
        expect(world.peak).toBe(peak);
      });
    }
  });

  test('HISTORY_RANGE shrinks the Yahoo request with explicit period1 and period2', () => {
    const now = Date.UTC(2026, 9, 2);
    expect(chartUrl('FBND', { historyRange: 'max' }, now)).toContain('period1=0&');
    const url = chartUrl('FBND', { historyRange: '5y' }, now);
    const period1 = Number(/period1=(\d+)/.exec(url)![1]);
    expect(Math.round((now / 1000 - period1) / 86_400 / 365.25)).toBe(5);
    expect(url).toContain(`period2=${Math.floor(now / 1000)}`);
  });
});
