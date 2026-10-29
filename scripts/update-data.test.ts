import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
  parseRange,
  parseAumRange,
  parseNportFiling,
  nportHoldingsSheet,
  nportHoldingTickers,
  nportTickers,
  parseSecCompanyNames,
  parseSecFundTickers,
  nportIsFresh,
  holdingsWeightCount,
  HOLDINGS_GUARD_RELAX,
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
  formatHeldTickers,
  CONTROL_NAMES,
  readConfig,
  resolveControls,
  runtimeControls,
  isCertError,
  installSystemCa,
  emptyReturnRow,
  returnsBlock,
  samePublishedContent,
  keepPublishedAdjClose,
  ADJ_CLOSE_NOISE,
  useOutputRoot,
  main,
  fetchWithRetry,
  holdingsGuard,
  CLOSED_FUNDS,
  closedFund,
  FIDELITY_FUNDS,
  catalogOnlyRow,
  configureRequestLanes,
  paceRequests,
  setSoftDeadline,
  chartUrl,
  publishedAsOf,
  stalestFirst,
  mergeWindowedChart,
} from './update-data';
import { readFileSync, mkdirSync, mkdtempSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  setSystemTime();
  configureRequestLanes(1, 1);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const HELD_TICKERS: Record<string, string> = JSON.parse(read('api/fidelity/held-tickers.json'));
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
  // accession -> the series its document names, its report period, and the series whose EDGAR feed lists it (default: the same)
  accessions: {} as Record<string, { series: string; repPd: string; feed?: string }>,
  companies: {} as Record<string, { ticker: string; title: string }>, // SEC company_tickers.json
  firstTrade: {} as Record<string, number>, // Yahoo firstTradeDate per ticker
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
  longName: {} as Record<string, string>, // Yahoo longName per ticker; the seed name when absent
  adjScale: 1, // Yahoo rescales adjusted closes after a new dividend
  earlyDividend: false,
  archives: [] as string[], // N-PORT accessions requested
  onSubmissions: null as null | (() => void),
};
const seedName = (pick: (fund: (typeof FIDELITY_FUNDS)[number]) => boolean, fallback: string): string => FIDELITY_FUNDS.find(pick)?.name ?? fallback;

const nportXml = (series: string, repPd: string): string => `<?xml version="1.0"?>
<edgarSubmission><formData><genInfo><regName>Trust</regName><seriesName>${FIDELITY_FUNDS.find((fund) => fund.seriesId === series)?.shareClassOf ?? seedName((fund) => fund.seriesId === series, `Fidelity ${series}`)}</seriesName><seriesId>${series}</seriesId><repPdDate>${repPd}</repPdDate></genInfo>
<invstOrSecs>${Array.from({ length: world.positions }, (_, i) => `<invstOrSec><name>APPLE ${i} INC</name><cusip>03783310${i}</cusip><balance>10</balance><units>SH</units><curCd>USD</curCd><valUSD>1000</valUSD><pctVal>${(100 / world.positions).toFixed(4)}</pctVal><assetCat>EC</assetCat></invstOrSec>`).join('')}${Array.from({ length: world.bonds }, (_, i) => `<invstOrSec><name>ACME BOND ${i} LLC</name><cusip>99999${i}</cusip><balance>10</balance><units>PA</units><curCd>USD</curCd><valUSD>10</valUSD><pctVal>1</pctVal><assetCat>${i % 2 ? 'ABS-MBS' : 'DBT'}</assetCat></invstOrSec>`).join('')}</invstOrSecs></formData></edgarSubmission>`;

function worldChart(ticker: string, period1 = 0): Record<string, unknown> {
  const start = Date.UTC(2025, 0, 2) / 1000;
  const days = Array.from({ length: 450 }, (_, i) => ({ t: start + i * day, close: 20 + i / 50, adj: (20 + i / 50) * world.adjScale, volume: 100 })).filter((d) => d.t >= period1);
  const dividends = [{ t: start + 30 * day, amount: 0.11 }, { t: start + 200 * day, amount: 0.12 }, { t: start + 300 * day, amount: 0.13 }].filter((d, i) => (i > 0 || world.earlyDividend) && d.t >= period1);
  return chartFixture({ days, dividends, meta: { navPrice: undefined, regularMarketTime: start + 449 * day, ...(world.firstTrade[ticker] ? { firstTradeDate: world.firstTrade[ticker] } : {}), longName: world.longName[ticker] ?? seedName((fund) => fund.ticker === ticker, 'Fidelity Test ETF') } });
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
        world.onSubmissions?.();
        const rows = world.submissions[sub[1]] || [];
        return new Response(JSON.stringify({ cik: sub[1], filings: { recent: { form: rows.map(() => 'NPORT-P'), accessionNumber: rows.map((r) => r.accession), filingDate: rows.map((r) => r.filed), reportDate: rows.map((r) => r.repPd) } } }));
      }
      // SEC fund ticker table (from the seed) and company name table
      if (url.endsWith('/files/company_tickers_mf.json')) return new Response(JSON.stringify({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: FIDELITY_FUNDS.filter((fund) => fund.seriesId).map((fund, i) => [Number(fund.trustCik), fund.seriesId, `C${String(i).padStart(9, '0')}`, fund.ticker]) }));
      if (url.endsWith('/files/company_tickers.json')) return new Response(JSON.stringify(world.companies));
      // the browse-edgar Atom feed of one series' NPORT-P filings, in the trust's own archive folder
      const feed = /browse-edgar\?action=getcompany&CIK=(S\d{9})&type=NPORT-P/.exec(url);
      if (feed) {
        const cik = Number(FIDELITY_FUNDS.find((fund) => fund.seriesId === feed[1])?.trustCik ?? 1);
        const entries = Object.entries(world.accessions).filter(([, filing]) => (filing.feed ?? filing.series) === feed[1]).map(([accession, filing]) => `<entry><content><accession-number>${accession}</accession-number><filing-date>2026-09-01</filing-date><filing-href>https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${accession}-index.htm</filing-href><filing-type>NPORT-P</filing-type><period>${filing.repPd}</period></content></entry>`);
        return new Response(`<?xml version="1.0"?><feed>${entries.join('')}</feed>`);
      }
      const arch = /Archives\/edgar\/data\/\d+\/(\d{18})\/primary_doc\.xml/.exec(url);
      if (arch) {
        world.archives.push(arch[1]);
        const hit = Object.entries(world.accessions).find(([acc]) => acc.replace(/-/g, '') === arch[1]);
        return hit ? new Response(nportXml(hit[1].series, hit[1].repPd)) : new Response('missing', { status: 404 });
      }
      if (url.includes('finance/chart/')) { world.order.push(/finance\/chart\/([A-Z]+)/.exec(url)?.[1] ?? '?'); world.onChart?.(); }
      if (url.includes('finance/chart/')) return world.chart === 'ok' ? new Response(JSON.stringify(worldChart(/finance\/chart\/([A-Z]+)/.exec(url)?.[1] ?? '', Number(/period1=(\d+)/.exec(url)?.[1] ?? 0)))) : new Response('down', { status: 404 });
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
  world.companies = {};
  world.firstTrade = {};
  world.chart = 'ok';
  world.delayMs = 0;
  world.peak = 0;
  world.positions = 1;
  world.bonds = 0;
  world.searches = [];
  world.searchFails = false;
  world.order = [];
  world.onChart = null;
  world.longName = {};
  world.adjScale = 1;
  world.earlyDividend = false;
  world.archives = [];
  world.onSubmissions = null;
  setSoftDeadline(25 * 60_000);
  installWorld();
  return root;
};
// Explicit control environment per run (never process.env).
const env = (extra: Record<string, string> = {}): Record<string, string> => ({ REQUEST_SLEEP: '0', MAX_RETRIES: '1', CONCURRENCY: '2', ...extra });
// A newer N-PORT-P filing of a series (the reader uses a filing only when its report period is strictly newer than the published holdings).
let filings = 0;
const refile = (series: string, repPd: string, names = series): string => {
  filings += 1;
  const accession = `0000035402-26-${String(900000 + filings)}`;
  world.accessions[accession] = { series: names, repPd, feed: series };
  return accession;
};
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
  test('N-PORT sheet (shared nport-reader): weights, values, balances, empty missing numbers, own identifiers, tickers only for U.S. equities', () => {
    const filing = parseNportFiling(
      nportFixture(
        'Fidelity Total Bond ETF',
        equityPosition('EQUINIX INC', '29444U700', '4.250000', '12345678.90', '1.97000000e2') +
          // a bond of a listed issuer: never the issuer's stock ticker (Fidelity published GS on 597 FBND bond rows)
          equityPosition('GOLDMAN SACHS GROUP INC (THE)', '38141GXR0', '0.0023816571', '620609.67', '705000', 'DBT') +
          `<invstOrSec><name>US TREASURY N/B</name><cusip>000000000</cusip><identifiers><isin value="US91282CDX75"/></identifiers>
          <balance>1000000.00000000</balance><curCd>USD</curCd><valUSD>990000.00</valUSD><pctVal>N/A</pctVal><assetCat>DBT</assetCat></invstOrSec>` +
          // a foreign listing in EUR: no bare ticker; a future keeps its own id, never its reference security's
          `<invstOrSec><name>SAP SE</name><cusip>N/A</cusip><identifiers><isin value="DE0007164600"/></identifiers><balance>10</balance><curCd>EUR</curCd><valUSD>2500</valUSD><pctVal>0.5</pctVal><assetCat>EC</assetCat></invstOrSec>` +
          `<invstOrSec><name>DJIA MINI E-CBOT</name><cusip>000000000</cusip><identifiers><other otherDesc="Bloomberg Identifier" value="BBG01VKPGXL9"/></identifiers><curCd>USD</curCd><valUSD>4913771.74</valUSD><pctVal>0.005</pctVal><assetCat>DE</assetCat><derivativeInfo><futrDeriv derivCat="FUT"><descRefInstrmnt><otherRefInst><identifiers><cusip value="78462F103"/><ticker value="SPY"/></identifiers></otherRefInst></descRefInstrmnt></futrDeriv></derivativeInfo></invstOrSec>`,
      ),
    );
    expect([filing.seriesName, filing.seriesId, filing.repPdDate, filing.positions.length]).toEqual(['Fidelity Total Bond ETF', 'S000099999', '2026-06-30', 5]);
    const names = parseSecCompanyNames({ 0: { ticker: 'EQIX', title: 'EQUINIX INC' }, 1: { ticker: 'GS', title: 'GOLDMAN SACHS GROUP INC' }, 2: { ticker: 'SAP', title: 'SAP SE' }, 3: { ticker: 'SPY', title: 'SPDR S&P 500 ETF TRUST' } });
    const rows = nportHoldingsSheet(filing, nportTickers(filing.positions, names));
    expect(rows[0]).toEqual({ Name: 'EQUINIX INC', Ticker: 'EQIX', Identifier: '29444U700', Weight: '4.25', 'Market Value': '12345678.9', 'Shares Held': '197', 'Asset Category': 'EC' });
    expect(rows.slice(1).map((row) => [row.Ticker, row.Identifier, row.Weight])).toEqual([['-', '38141GXR0', '0.0023816571'], ['-', 'US91282CDX75', ''], ['-', 'DE0007164600', '0.5'], ['-', 'BBG01VKPGXL9', '0.005']]);
    expect(parseNportFiling(nportFixture('Fidelity Test ETF', '')).positions).toHaveLength(0);
  });

  test('holdings guard: header-only, renamed weight column, broken weights, a bad weight sum and a halved sheet are rejected', () => {
    const headers = ['Name', 'Ticker', 'Weight'];
    const rows = [{ Name: 'A', Ticker: 'A', Weight: '60%' }, { Name: 'B', Ticker: 'B', Weight: '40%' }];
    expect(holdingsGuard(headers, rows, 2)).toBeNull();
    expect(holdingsGuard(headers, [['A', 'A', '60'], ['B', 'B', '40']], null)).toBeNull();
    expect(holdingsGuard([], [], 0)).toBeNull(); // nothing published before: an empty sheet is honest
    expect(holdingsGuard(headers, [], 505)).toContain('no holdings rows');
    expect(holdingsGuard(['Name', 'Ticker', 'Wt'], rows, 2)).toContain('no weight column');
    expect(holdingsGuard(headers, rows.map((row) => ({ ...row, Weight: '6\u200B0' })), 2)).toContain('numeric weight');
    const allocation = [{ Name: 'Cash&Collateral', Ticker: '-', Weight: '100' }, { Name: 'Equities', Ticker: '-', Weight: '476' }];
    expect(holdingsGuard(headers, allocation, 2)).toContain('outside 50..150');
    expect(holdingsGuard(headers, allocation, 2, ['sum'])).toBeNull();
    expect(holdingsGuard(headers, rows, 5)).toContain('less than half');
  });

  test('N-PORT identity: the series id and registrant of SEC company_tickers_mf.json (the seed where it has none); an HTML page is no filing; FPRO, FLDB and FLDR carry their own series', () => {
    const map = parseSecFundTickers({ fields: ['cik', 'seriesId', 'classId', 'symbol'], data: [[945908, 'S000070235', 'C000223346', 'FPRO'], [754510, 'S000007192', 'C000276225', 'FREI']] });
    expect(map.get('FPRO')).toEqual({ cik: '0000945908', seriesId: 'S000070235', classId: 'C000223346' });
    expect(map.get('FREI')).toEqual({ cik: '0000754510', seriesId: 'S000007192', classId: 'C000276225' });
    // an HTML page parses to no series and no positions: the reader never takes it for the fund's filing
    const html = parseNportFiling('<html><head><title>SEC.gov | Request Rate Threshold Exceeded</title></head><body><h1>Your request has been blocked</h1></body></html>');
    expect([html.seriesId, html.seriesName, html.positions.length]).toEqual(['', '', 0]);
    // the shortName is cut ("Fidelity Real Estate Investment"), so it never stands in for the longName
    expect(parseChart(chartFixture({ meta: { longName: undefined, shortName: 'Fidelity Real Estate Investment' } })).longName).toBe('');
    // SEC company_tickers_mf.json: FPRO S000070235/C000223346, FLDB S000084018/C000248144, FLDR S000062079/C000201028
    const series = (ticker: string) => FIDELITY_FUNDS.find((fund) => fund.ticker === ticker)?.seriesId;
    expect([series('FPRO'), series('FLDB'), series('FLDR')]).toEqual(['S000070235', 'S000084018', 'S000062079']);
  });

  test('N-PORT freshness: a report replaces published holdings only when strictly newer; nothing published accepts any report; Fidelity display dates are calendar text', () => {
    expect(nportIsFresh('2026-06-30', displayDateToIso('Jul 31 2026'), 230)).toBe(false);
    expect(nportIsFresh('2026-07-31', displayDateToIso('Jul 31 2026'), 230)).toBe(false); // the same period is no update (Fidelity used >= before)
    expect(nportIsFresh('2026-08-31', displayDateToIso('Jul 31 2026'), 230)).toBe(true);
    expect(nportIsFresh('', '2026-03-31', 100)).toBe(false);
    expect(nportIsFresh('2026-06-30', null, 0)).toBe(true);
    expect(nportIsFresh('2026-06-30', displayDateToIso('—'), 100)).toBe(false); // published rows without a date cannot be compared: keep them
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
});

describe('parsing 2', () => {
  test('dates: EDGAR display dates and epochs are UTC, display and calendar text dates are the same day in every time zone', () => {
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles', 'UTC']) {
      process.env.TZ = tz;
      expect(['Oct 24 2026', 'Oct 24, 2026', 'October 24 2026', '24 Oct 2026', '10/24/2026', '2026-10-24'].map((raw) => displayDateToIso(raw))).toEqual(Array(6).fill('2026-10-24'));
      expect([displayDateToIso('not a date'), displayDateToIso('—'), displayDateToIso('02/30/2026')]).toEqual([null, null, null]);
    }
    process.env.TZ = 'UTC';
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

    const seed = formatHeldTickers({ B: 'BB', A: 'AA', 'a10 networks inc': 'A' });
    expect(seed).toBe(formatHeldTickers({ 'a10 networks inc': 'A', B: 'BB', A: 'AA' }));
    expect(seed.indexOf('"A"')).toBeLessThan(seed.indexOf('"a10 networks inc"'));
    expect(seed.indexOf('"a10 networks inc"')).toBeLessThan(seed.indexOf('"B"'));
    const dropped = formatHeldTickers({ '': 'XX', 'VALID INC': '', GOOD: 'GD' });
    expect(dropped).not.toContain('XX');
    expect(dropped).not.toContain('"VALID INC"');
    expect(formatHeldTickers({ 'SCE TRUST VI': 'sce^l' })).toContain('"SCE^L"');
    for (const [name, ticker] of Object.entries(HELD_TICKERS)) {
      expect(name.length > 0 && ticker.length > 0, `bad seed entry ${name} -> ${ticker}`).toBe(true);
    }
    // the committed file is exactly what the updater writes, so a rerun with the same data changes nothing
    expect(formatHeldTickers(HELD_TICKERS)).toBe(read('api/fidelity/held-tickers.json'));
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

  test('holding tickers: SEC names first, the held-tickers seed and Yahoo search only for U.S. equity rows; a bond of a listed issuer and a foreign listing keep "-"', async () => {
    const filing = parseNportFiling(nportFixture('Fidelity Total Bond ETF',
      equityPosition('APPLE INC', '037833100', '5', '500', '10') +
        equityPosition('ALPHABET INC CL A', '02079K305', '3', '300', '10') +
        equityPosition('ALPHABET INC CL C', '02079K107', '2', '200', '10') +
        equityPosition('NEW LISTING INC', '123456789', '1', '100', '10') +
        equityPosition('GOLDMAN SACHS GROUP INC (THE)', '38141GXR0', '1', '100', '10', 'DBT') +
        equityPosition('BOEING CO', '097023CY9', '1', '100', '10', 'DBT') +
        `<invstOrSec><name>TOYOTA MOTOR CORP</name><cusip>J92676113</cusip><identifiers><isin value="JP3633400001"/></identifiers><balance>10</balance><curCd>JPY</curCd><valUSD>100</valUSD><pctVal>1</pctVal><assetCat>EC</assetCat></invstOrSec>` +
        `<invstOrSec><name>NESTLE SA</name><cusip>H57312649</cusip><identifiers><isin value="CH0038863350"/></identifiers><balance>10</balance><curCd>CHF</curCd><valUSD>100</valUSD><pctVal>1</pctVal><assetCat>EC</assetCat></invstOrSec>`));
    const searched: string[] = [];
    // the seed knows every issuer here (the old fill gave GS and BA to the bonds and TM to the Tokyo listing)
    const resolver = new TickerResolver({ 'ALPHABET INC CL A': 'GOOGL', 'ALPHABET INC CL C': 'GOOG', 'GOLDMAN SACHS GROUP INC': 'GS', 'BOEING CO': 'BA', 'TOYOTA MOTOR CORP': 'TM' }, async (name) => { searched.push(name); return name === 'NEW LISTING INC' ? 'NEWL' : null; });
    // one SEC title for both Alphabet classes: the duplicate check drops it, the seed's class names fill them
    const names = parseSecCompanyNames({ 0: { ticker: 'AAPL', title: 'Apple Inc.' }, 1: { ticker: 'GOOGL', title: 'Alphabet Inc.' } });
    expect(await nportHoldingTickers(filing.positions, names, resolver)).toEqual(['AAPL', 'GOOGL', 'GOOG', 'NEWL', '', '', '', '']);
    // only the U.S. equity the seed does not know is searched, never the Swiss listing
    expect(searched).toEqual(['NEW LISTING INC']);
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

describe('parsing 3', () => {
  test('N-PORT issuer names match SEC titles across initials, a leading US and backslash EDGAR suffixes', () => {
    const stock = (name: string, cusip: string) => `<invstOrSec><name>${name}</name><cusip>${cusip}</cusip><balance>1</balance><curCd>USD</curCd><valUSD>1</valUSD><pctVal>1</pctVal><assetCat>EC</assetCat></invstOrSec>`;
    const filing = parseNportFiling(`<edgarSubmission><genInfo><seriesId>S000099999</seriesId></genInfo><invstOrSecs>${stock('US Bancorp', '902973304')}${stock('Bancorp Inc/The', '05969A105')}${stock('CH Robinson Worldwide Inc', '12541W209')}</invstOrSecs></edgarSubmission>`);
    const names = parseSecCompanyNames({ 0: { ticker: 'USB', title: 'US BANCORP \\DE\\' }, 1: { ticker: 'TBBK', title: 'Bancorp, Inc.' }, 2: { ticker: 'CHRW', title: 'C H ROBINSON WORLDWIDE, INC.' } });
    // U.S. Bancorp is not The Bancorp, and C.H. Robinson is one issuer however its initials are spaced
    expect(nportTickers(filing.positions, names)).toEqual(['USB', 'TBBK', 'CHRW']);
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
    // since inception is annualized only from one full year on: at 0.83 years +10% is cumulative, not 12.17% a year
    const asOf = new Date('2026-06-30T23:59:00Z');
    expect(priceReturns([mk('2025-09-01', 100), mk('2026-06-30', 110)], asOf).siAnn).toBeNull();
    expect(priceReturns([mk('2025-06-27', 100), mk('2026-06-30', 110)], asOf).siAnn).toBeCloseTo(((1.1 ** (1 / (368 / 365.25))) - 1) * 100, 2);
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
});

describe('metrics 2', () => {
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

  test('dividendYieldBasis: indicated for the updater estimate, null with a null yield, one key set on fresh, rebuilt and placeholder rows', () => {
    const returns = { asOfDate: '2026-06-30', ytd: 9.09, yr1: 20, cagr3y: 10, cagr5y: 8, cagr10y: null, siAnn: 12.5, mo1: 0.85, qtd: 5.26 };
    const fresh = deriveCatalogMetrics(returns, 0.1, 4, 40);
    const none = deriveCatalogMetrics(returns, null, null, 40);
    const placeholder = deriveCatalogMetrics(priceReturns([]), null, null, null);
    expect(fresh.dividendYieldBasis).toBe('indicated');
    expect(none.dividendYield).toBeNull();
    expect(none.dividendYieldBasis).toBeNull();
    expect(placeholder.dividendYieldBasis).toBeNull();
    // rebuilt from a stored row: the code follows the stored yield, a stale code never survives
    const rebuilt = normalizeStoredMetrics({ ...fresh, dividendYieldBasis: undefined }, null);
    const stale = normalizeStoredMetrics({ ...none, dividendYieldBasis: 'indicated' }, null);
    const legacy = normalizeStoredMetrics((({ dividendYieldBasis: _drop, ...rest }) => rest)(fresh), null);
    expect(rebuilt.dividendYieldBasis).toBe('indicated');
    expect(stale.dividendYieldBasis).toBeNull();
    expect(legacy.dividendYieldBasis).toBe('indicated');
    const keys = (m: Record<string, unknown>) => Object.keys(m).sort();
    expect(keys(rebuilt)).toEqual(keys(fresh));
    expect(keys(legacy)).toEqual(keys(fresh));
    expect(keys(placeholder)).toEqual(keys(fresh));
    expect(keys(none)).toEqual(keys(fresh));
    expect(Object.keys(fresh).indexOf('dividendYieldBasis')).toBe(Object.keys(fresh).indexOf('dividendYieldText') + 1);
  });

  test('a fund younger than one year publishes no 1-year or since-inception return, a fund past its anniversary does (calendar anniversary of the first trade date)', async () => {
    setSystemTime(new Date('2026-03-30T12:00:00Z'));
    await inWorld(async (root) => {
      // history from 2025-01-02 to 2026-03-27 for both; FBND started trading 2025-06-02 (not one year old on 2026-03-27)
      world.firstTrade.FBND = Date.UTC(2025, 5, 2, 13, 30) / 1000;
      await quiet(() => main(env({ TICKERS: 'FBND FBCG' })));
      const rows = readJson(root, 'index.json').funds;
      const young = rows.find((row: any) => row.ticker === 'FBND').metrics;
      const old = rows.find((row: any) => row.ticker === 'FBCG').metrics;
      expect([young.ytd === null, young.tr1y, young.siAnn, young.performanceAsOf]).toEqual([false, null, null, '2026-03-27']);
      expect([old.tr1y === null, old.siAnn === null]).toEqual([false, false]);
      const monthEnd = readJson(root, 'funds/FBND/meta.json').returns.monthEnd;
      expect([monthEnd.yr1, monthEnd.sinceInception, monthEnd.yr1Text]).toEqual([null, null, '—']);
    });
  });

  test('stored rows gain basis and as-of from the returns table; returns block rows share one key set', () => {
    expect(displayDateToIso('Sep 25 2026')).toBe('2026-09-25');
    expect(displayDateToIso('—')).toBeNull();
    const old = { ytd: 1, secYield: null };
    const out = normalizeStoredMetrics(old, { monthEnd: { asOfDate: 'Sep 25 2026' } });
    expect(Object.keys(out)).toEqual(['ytd', 'secYield', 'dividendYieldBasis', 'secYieldText', 'returnsBasis', 'performanceAsOf']);
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
      // the 52-week keys are in every row, computed from its history pages (range-52w block)
      const RANGE_KEYS = ['week52Low', 'week52High', 'range52w', 'range52wClose', 'range52wAsOf', 'range52wSince', 'range52wBasis'];
      for (const fund of index.funds) expect(Object.keys(fund.metrics)).toEqual(expect.arrayContaining(RANGE_KEYS));
      for (const fund of index.funds) {
        expect(fund.dataFile).toBe(`./funds/${fund.ticker}/meta.json`);
        expect(statSync(join(root, fund.dataFile)).isFile()).toBe(true);
        expect(fund.metrics.returnsBasis).toBeTruthy();
        expect(fund.metrics.dividendYieldBasis).toBe(fund.metrics.dividendYield === null ? null : 'indicated');
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

  test('two runs on the same source data write zero changes even when Yahoo adjusted closes jitter across a cent boundary', async () => {
    await inWorld(async (root) => {
      // Yahoo float32 noise seen live: AAM SPDV 2024-11-12 came back as 31.544998 and 31.545001 a minute apart
      const upstream = globalThis.fetch;
      const jittered = (tail: number[]): void => {
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await upstream(input, init);
          if (!String(input).includes('finance/chart/')) return response;
          const payload = await response.json();
          const indicators = payload.chart.result[0].indicators;
          const closes: number[] = indicators.quote[0].close;
          indicators.adjclose = [{ adjclose: closes.map((close, i) => (i >= closes.length - tail.length ? tail[i - closes.length + tail.length] : close)) }];
          return new Response(JSON.stringify(payload));
        }) as unknown as typeof fetch;
      };
      const run = () => quiet(() => main(env({ TICKERS: 'FBND' })));
      jittered([23.915001, 24.984999, 25.995001]);
      await run();
      const first = snapshot(root);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
      jittered([23.914998, 24.985002, 25.994999]);
      await run();
      expect(snapshot(root)).toEqual(first);
      // a real change beyond the noise is still written
      jittered([23.9, 24.97, 25.98]);
      await run();
      const rows = readJson(root, 'funds/FBND/history/001.json').rows;
      expect(snapshot(root)).not.toEqual(first);
      expect(rows.slice(-3).map((row: any) => row['Adj Close'])).toEqual(['23.9', '24.97', '25.98']);
    });
  });

  test('keepPublishedAdjClose keeps the published cent only within float noise of a cent boundary', () => {
    const published = [{ Date: 'Nov 12 2024', Close: '33.928001', 'Adj Close': '31.54', Volume: '3900' }];
    const fresh = (adjCloseRaw: number) => [{ date: '2024-11-12', close: 33.928001, adjClose: Math.round(adjCloseRaw * 100) / 100, volume: 4000, adjCloseRaw }];
    expect(keepPublishedAdjClose(fresh(31.545001), published)[0]).toMatchObject({ adjClose: 31.54, volume: 4000 });
    expect(keepPublishedAdjClose(fresh(31.5452), published)[0].adjClose).toBe(31.55);
    expect(keepPublishedAdjClose(fresh(31.56), published)[0].adjClose).toBe(31.56);
    expect(ADJ_CLOSE_NOISE).toBe(1e-4);
  });
});

describe('pipeline 2', () => {
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

  test('fresh N-PORT holdings that fail the guard (halved sheet, broken weights) keep the fund exactly as published and report it failed', async () => {
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const first = snapshot(root);
      expect(readJson(root, 'funds/FBND/meta.json').holdings.totalRows).toBe(4);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
      world.positions = 1; // 1 of 4 published rows, in a newer filing
      refile('S000042567', '2026-06-30');
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(snapshot(root)).toEqual(first);
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      world.positions = 4;
      refile('S000042567', '2026-07-31');
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await upstream(input, init);
        return String(input).includes('primary_doc.xml') ? new Response((await response.text()).replace(/<pctVal>[^<]*<\/pctVal>/g, '<pctVal>N/A</pctVal>')) : response;
      }) as unknown as typeof fetch;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(snapshot(root)).toEqual(first);
      expect(process.exitCode).toBe(1);
    });
  });

  test('a new fund whose first refresh fails (guard rejection or any other error) is reported failed and gets a catalog-only row: dataFile null, no files, full metrics key set', async () => {
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBCG' })));
      const fullKeys = Object.keys(readJson(root, 'index.json').funds[0].metrics).sort();
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await upstream(input, init);
        return String(input).includes('primary_doc.xml') ? new Response((await response.text()).replace(/<pctVal>[^<]*<\/pctVal>/g, '<pctVal>N/A</pctVal>')) : response;
      }) as unknown as typeof fetch;
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: unknown) => { lines.push(String(line)); };
      try { await main(env({ TICKERS: 'FBND' })); } finally { console.log = log; }
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      expect(lines.some((line) => /FBND\s+failed .*holdings guard/.test(line))).toBe(true);
      expect(lines.some((line) => /\[ done\s+\] 1 fund: .*1 failed/.test(line))).toBe(true);
      const row = readJson(root, 'index.json').funds.find((fund: any) => fund.ticker === 'FBND');
      expect(row).toMatchObject({ dataFile: null, holdings: 0, history: 0, aumValue: null, terValue: FIDELITY_FUNDS.find((fund) => fund.ticker === 'FBND')!.ter });
      expect(Object.keys(row.metrics).sort()).toEqual(fullKeys);
      expect(row.metrics.returnsBasis).toBe(RETURNS_BASIS);
      expect(readdirSync(join(root, 'funds')).sort()).toEqual(['FBCG']);
      // any other failure of a first refresh lists the fund the same way (funds/FBCV is a plain file: nothing can be written)
      globalThis.fetch = upstream;
      writeFileSync(join(root, 'funds/FBCV'), 'not a folder');
      await quiet(() => main(env({ TICKERS: 'FBCV' })));
      expect(process.exitCode).toBe(1);
      process.exitCode = 0;
      const rows = readJson(root, 'index.json').funds;
      expect(rows.map((fund: any) => [fund.ticker, fund.dataFile])).toEqual([['FBCG', './funds/FBCG/meta.json'], ['FBCV', null], ['FBND', null]]);
      // once the sources work, both get their files and a full row
      rmSync(join(root, 'funds/FBCV'));
      await quiet(() => main(env({ TICKERS: 'FBND FBCV' })));
      expect(process.exitCode).toBe(0);
      expect(readJson(root, 'index.json').funds.map((fund: any) => fund.dataFile)).toEqual(['./funds/FBCG/meta.json', './funds/FBCV/meta.json', './funds/FBND/meta.json']);
    });
  });
});

describe('pipeline 3', () => {
  test('a closed fund is never fetched or reported failed: its files stay as published, its index row says closed, a rerun writes nothing', async () => {
    const entry = { ticker: 'FBND', closed: '2026-10-01', source: 'https://www.sec.gov/Archives/edgar/data/1/notice.htm' };
    expect(() => closedFund([{ ...entry, closed: 'soon' }], 'FBND')).toThrow('CLOSED_FUNDS');
    expect(closedFund([entry], 'fbnd')).toEqual(entry);
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBND FBCG FBCV' })));
      const first = snapshot(root);
      const upstream = globalThis.fetch;
      const calls: string[] = [];
      const recording = (mutate: boolean) => (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(input));
        const response = await upstream(input, init);
        // every N-PORT weight N/A: the guard would reject these holdings
        return mutate && String(input).includes('primary_doc.xml') ? new Response((await response.text()).replace(/<pctVal>[^<]*<\/pctVal>/g, '<pctVal>N/A</pctVal>')) : response;
      }) as unknown as typeof fetch;
      const seedAt = FIDELITY_FUNDS.findIndex((fund) => fund.ticker === 'FBND');
      const seed = FIDELITY_FUNDS[seedAt];
      CLOSED_FUNDS.push(entry);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
        globalThis.fetch = recording(true);
        await quiet(() => main(env({ TICKERS: 'FBND' })));
        expect(calls).toEqual([]);
        expect(process.exitCode).not.toBe(1);
        const closed = snapshot(root);
        for (const path of Object.keys(first)) if (!path.endsWith('index.json')) expect([path, closed[path]]).toEqual([path, first[path]]);
        const rows = readJson(root, 'index.json').funds;
        expect(rows.map((fund: any) => fund.ticker)).toEqual(['FBCG', 'FBCV', 'FBND']);
        expect(rows.find((fund: any) => fund.ticker === 'FBND')).toMatchObject({ status: 'closed', closedDate: '2026-10-01', closedSource: entry.source, dataFile: './funds/FBND/meta.json' });
        expect(rows.filter((fund: any) => fund.status === 'closed')).toHaveLength(1);
        // a rerun over every fund: FBND is still not fetched (no chart, no filing of its series), nothing changes
        globalThis.fetch = recording(false);
        await quiet(() => main(env({ TICKERS: 'FBND FBCG FBCV' })));
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.filter((url) => /FBND|000003540226004724/.test(url))).toEqual([]);
        expect(snapshot(root)).toEqual(closed);
        // the seed dropped the fund: TICKERS still accepts it, its row and files survive every run
        FIDELITY_FUNDS.splice(seedAt, 1);
        await quiet(() => main(env({ TICKERS: 'FBND' })));
        await quiet(() => main(env({ TICKERS: 'FBCG' })));
        expect(snapshot(root)).toEqual(closed);
      } finally {
        if (FIDELITY_FUNDS.indexOf(seed) < 0) FIDELITY_FUNDS.splice(seedAt, 0, seed);
        CLOSED_FUNDS.splice(CLOSED_FUNDS.indexOf(entry), 1);
      }
    });
  });

  test('a filing that names another series is not used; holdings published for another series are no baseline', async () => {
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const meta = readJson(root, 'funds/FBND/meta.json');
      expect([meta.name, meta.holdings.totalRows, meta.holdings.asOf, meta.seed.seriesId]).toEqual(['Fidelity Total Bond ETF', 4, 'May 31 2026', 'S000042567']);
      // the newest filing in FBND's feed is FCOR's (S000040431): it is read, never used; the fund's own older filing is not newer
      const impostor = refile('S000042567', '2026-07-31', 'S000040431');
      world.positions = 2;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(world.archives).toContain(impostor.replace(/-/g, ''));
      const kept = readJson(root, 'funds/FBND/meta.json');
      expect([kept.holdings, kept.aum, kept.seed, kept.source]).toEqual([meta.holdings, meta.aum, meta.seed, meta.source]);
      expect(readJson(root, 'funds/FBND/holdings/001.json').totalRows).toBe(4);
      // published for another series (a seed fixed since): no baseline, so the fund's own filing replaces it even when older
      world.positions = 1;
      writeFileSync(join(root, 'funds/FBND/meta.json'), JSON.stringify({ ...kept, seed: { ...kept.seed, seriesId: 'S000047984' }, holdings: { ...kept.holdings, asOf: 'Jul 31 2026' } }));
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const fixed = readJson(root, 'funds/FBND/meta.json');
      expect([fixed.holdings.totalRows, fixed.holdings.asOf, fixed.seed.seriesId, fixed.seed.accession]).toEqual([1, 'May 31 2026', 'S000042567', '0000035402-26-004724']);
      expect(process.exitCode).toBe(0);
    });
  });

  test('an ETF share class (FREI) uses its mutual fund series: holdings from the filing, the ETF name, AUM null; stale data of another series is replaced', async () => {
    await inWorld(async (root) => {
      const frei = FIDELITY_FUNDS.find((fund) => fund.ticker === 'FREI')!;
      // SEC company_tickers_mf.json: FREI = class C000276225 of series S000007192, Fidelity Securities Fund (CIK 754510)
      expect([frei.seriesId, frei.trustCik, frei.shareClassOf, frei.ter]).toEqual(['S000007192', '0000754510', 'Fidelity Real Estate Income Fund', 0.57]);
      world.accessions['0000035402-26-006222'] = { series: 'S000007192', repPd: '2026-07-31' };
      world.longName.FREI = 'Fidelity Real Estate Income Fund ETF'; // Yahoo's longName, not the N-PORT series name
      // published before: FPRO's series and its 44 rows under FREI
      mkdirSync(join(root, 'funds/FREI'), { recursive: true });
      writeFileSync(join(root, 'funds/FREI/meta.json'), JSON.stringify({ ticker: 'FREI', name: 'Fidelity Real Estate Investment ETF', seed: { seriesId: 'S000070235' }, holdings: { totalRows: 44, asOf: 'Jul 31 2026' }, aum: { value: 16369551.39 } }));
      world.positions = 3;
      await quiet(() => main(env({ TICKERS: 'FREI' })));
      const meta = readJson(root, 'funds/FREI/meta.json');
      expect([meta.name, meta.holdings.totalRows, meta.holdings.asOf, meta.seed.seriesId, meta.aum.value, meta.expenseRatio.value]).toEqual(['Fidelity Real Estate Income Fund ETF Class', 3, 'Jul 31 2026', 'S000007192', null, 0.57]);
      expect(meta.aum.source).toContain('every share class');
      const row = readJson(root, 'index.json').funds.find((fund: any) => fund.ticker === 'FREI');
      expect([row.name, row.aumValue, row.terValue]).toEqual(['Fidelity Real Estate Income Fund ETF Class', null, 0.57]);
      expect(process.exitCode).toBe(0);
    });
  });

  test('an N-PORT body that is no usable filing (no positions, an HTML page) is not used: no AUM 0 for a new fund, a published fund keeps holdings and AUM', async () => {
    await inWorld(async (root) => {
      const warn = console.warn;
      const warnings: string[] = [];
      console.warn = (message: string) => { warnings.push(String(message)); };
      try {
        // a new fund whose filing lists no positions: AUM stays unknown (null), never 0
        world.positions = 0;
        await quiet(() => main(env({ TICKERS: 'FBND' })));
        const fresh = readJson(root, 'funds/FBND/meta.json');
        expect([fresh.aum.value, fresh.holdings.totalRows, readJson(root, 'index.json').funds[0].aumValue]).toEqual([null, 0, null]);
        expect(warnings.some((line) => line.includes('FBND') && line.includes('has no positions'))).toBe(true);
        world.positions = 2;
        await quiet(() => main(env({ TICKERS: 'FBND' })));
        const meta = readJson(root, 'funds/FBND/meta.json');
        expect([meta.aum.value, meta.holdings.totalRows]).toEqual([2000, 2]);
        // SEC answers 200 with an HTML page: holdings and AUM stay as published, the rest of the fund still updates
        const upstream = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
          String(input).includes('primary_doc.xml') ? new Response('<html><body>Request Rate Threshold Exceeded</body></html>', { status: 200 }) : upstream(input, init)) as unknown as typeof fetch;
        await quiet(() => main(env({ TICKERS: 'FBND' })));
        const kept = readJson(root, 'funds/FBND/meta.json');
        expect([kept.aum, kept.holdings, kept.seed]).toEqual([meta.aum, meta.holdings, meta.seed]);
        expect(readJson(root, 'index.json').funds[0].aumValue).toBe(2000);
        expect(warnings.some((line) => line.includes('FBND') && line.includes('no N-PORT-P filing of its own'))).toBe(true);
        expect(process.exitCode).toBe(0);
      } finally {
        console.warn = warn;
      }
    });
  });

  test('a HISTORY_RANGE window never shrinks the published history: older days are rescaled to the new adjusted closes, metrics see them', async () => {
    setSystemTime(new Date('2026-03-30T12:00:00Z'));
    await inWorld(async (root) => {
      world.earlyDividend = true;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const full = readJson(root, 'funds/FBND/meta.json');
      const fullRow = readJson(root, 'index.json').funds.find((f: any) => f.ticker === 'FBND');
      expect(full.history.totalRows).toBe(450);
      expect(fullRow.metrics.siAnn).not.toBeNull();
      // Q25: the same data through a 1y window writes nothing (the published days before the window are kept as they are)
      const unchanged = snapshot(root);
      await quiet(() => main(env({ TICKERS: 'FBND', HISTORY_RANGE: '1y' })));
      expect(snapshot(root)).toEqual(unchanged);
      // a dividend since the last run: Yahoo rescales every adjusted close by 0.99, and a 1y request starts 2025-03-30
      world.adjScale = 0.99;
      await quiet(() => main(env({ TICKERS: 'FBND', HISTORY_RANGE: '1y' })));
      const meta = readJson(root, 'funds/FBND/meta.json');
      const row = readJson(root, 'index.json').funds.find((f: any) => f.ticker === 'FBND');
      expect(meta.history.totalRows).toBe(450);
      const first = readJson(root, 'funds/FBND/history/001.json').rows[0];
      expect([first.Date, first.Close, first['Adj Close']]).toEqual(['Jan 02 2025', '20', '19.8']);
      expect(row.metrics.siAnn).toBeCloseTo(fullRow.metrics.siAnn, 1);
      expect(row.metrics.performanceAsOf).toBe(fullRow.metrics.performanceAsOf);
      expect(meta.distributions.rows.map((r: string[]) => r[0])).toEqual(['02/01/2025', '07/21/2025', '10/29/2025']);
      // the same window again writes nothing
      const before = snapshot(root);
      await quiet(() => main(env({ TICKERS: 'FBND', HISTORY_RANGE: '1y' })));
      expect(snapshot(root)).toEqual(before);
    });
    // a split rescales the raw closes too: no honest join, the caller keeps the published history and returns
    const mkDay = (date: string, close: number) => ({ date, close, adjClose: close, volume: 0 });
    const published = [{ Date: 'Jan 02 2026', Close: '40', 'Adj Close': '40', Volume: '0' }, { Date: 'Jan 05 2026', Close: '42', 'Adj Close': '42', Volume: '0' }];
    const chart = { exchangeName: '', longName: '', navPrice: null, regularMarketPrice: null, regularMarketTime: null, firstTradeDate: null, dividends: [] };
    expect(mergeWindowedChart({ ...chart, days: [mkDay('2026-01-05', 21), mkDay('2026-01-06', 22)] }, published, [])).toBeNull();
    expect(mergeWindowedChart({ ...chart, days: [mkDay('2026-01-07', 42)] }, published, [])).toBeNull();
  });
});

describe('pipeline 4', () => {
  test('REFRESH_CATALOG: the newest report period of the fund\'s own series is used from the trust\'s folder; an older one keeps the holdings and their filing links; 0 asks EDGAR nothing', async () => {
    await inWorld(async (root) => {
      // a late filing for an older period never wins over the newest report period
      world.accessions['0000035402-26-009999'] = { series: 'S000042567', repPd: '2026-07-31' };
      world.accessions['0000035402-26-009990'] = { series: 'S000042567', repPd: '2026-04-30' };
      await quiet(() => main(env({ TICKERS: 'FBND FBCG' })));
      const fbnd = readJson(root, 'funds/FBND/meta.json');
      expect([fbnd.holdings.asOf, fbnd.seed.accession]).toEqual(['Jul 31 2026', '0000035402-26-009999']);
      expect([fbnd.source.nportDoc, fbnd.source.edgarFiling]).toEqual(['https://www.sec.gov/Archives/edgar/data/1562565/000003540226009999/primary_doc.xml', 'https://www.sec.gov/Archives/edgar/data/1562565/000003540226009999/000003540226009999-index.htm']);
      expect(readJson(root, 'funds/FBCG/meta.json').holdings.asOf).toBe('Apr 30 2026');
      // published holdings are fresher than every filing: they stay, with the filing they came from
      const meta = readJson(root, 'funds/FBND/meta.json');
      meta.holdings.asOf = 'Sep 30 2026';
      writeFileSync(join(root, 'funds/FBND/meta.json'), JSON.stringify(meta));
      world.positions = 3;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const kept = readJson(root, 'funds/FBND/meta.json');
      expect([kept.holdings, kept.source, kept.seed]).toEqual([meta.holdings, meta.source, meta.seed]);
      // REFRESH_CATALOG=0: no SEC request at all, holdings and links stay as published, the rest of the fund still updates
      refile('S000042567', '2026-10-31');
      const calls: string[] = [];
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); return upstream(input, init); }) as unknown as typeof fetch;
      await quiet(() => main(env({ TICKERS: 'FBND', REFRESH_CATALOG: '0' })));
      expect([calls.some((url) => url.includes('finance/chart/FBND')), calls.filter((url) => url.includes('sec.gov'))]).toEqual([true, []]);
      expect(readJson(root, 'funds/FBND/meta.json').holdings).toEqual(meta.holdings);
    });
  });

  test('a relaxed guard still keeps numeric published weights from an all-dash sheet (Q24)', async () => {
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const first = snapshot(root);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // generatedAt has second resolution
      // a newer filing without one numeric weight, for a fund whose relax table would let it through
      refile('S000042567', '2026-06-30');
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await upstream(input, init);
        return String(input).includes('primary_doc.xml') ? new Response((await response.text()).replace(/<pctVal>[^<]*<\/pctVal>/g, '<pctVal>N/A</pctVal>')) : response;
      }) as unknown as typeof fetch;
      HOLDINGS_GUARD_RELAX.FBND = ['numeric', 'sum'];
      try {
        await quiet(() => main(env({ TICKERS: 'FBND' })));
      } finally {
        delete HOLDINGS_GUARD_RELAX.FBND;
      }
      expect(snapshot(root)).toEqual(first);
      expect(process.exitCode).toBe(1);
      expect(holdingsWeightCount(['Name', 'Weight'], [['A', ''], ['B', '2']])).toBe(1);
    });
  });

  test('TICKERS outside the seed and the published feed stops the run before any request; a stale catalog-only row is dropped (Q27)', async () => {
    await inWorld(async (root) => {
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      const index = readJson(root, 'index.json');
      // a catalog-only row left by an old run for a ticker the seed does not list
      writeFileSync(join(root, 'index.json'), JSON.stringify({ ...index, funds: [...index.funds, { ...catalogOnlyRow(FIDELITY_FUNDS[0]), ticker: 'NOPE' }] }));
      const before = snapshot(root);
      const calls: string[] = [];
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push(String(input)); return upstream(input, init); }) as unknown as typeof fetch;
      await expect(quiet(() => main(env({ TICKERS: 'NOPE' })))).rejects.toThrow('TICKERS: NOPE not in the Fidelity seed or published feed; nothing was fetched or written');
      expect(calls).toEqual([]);
      expect(snapshot(root)).toEqual(before);
      await quiet(() => main(env({ TICKERS: 'FBND' })));
      expect(readJson(root, 'index.json').funds.map((fund: any) => fund.ticker)).toEqual(['FBND']);
    });
  });

  test('NEW FUNDS announces a fund on its first successful publish, a failed new fund as not published yet (Q28)', async () => {
    await inWorld(async (root) => {
      world.positions = 4;
      await quiet(() => main(env({ TICKERS: 'FBCG' })));
      process.env.GITHUB_STEP_SUMMARY = join(root, 'summary.md');
      // FBCV's first filing has no numeric weight: the guard rejects it and FBCV gets a catalog-only row
      const upstream = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await upstream(input, init);
        return String(input).includes('000003540226004033') ? new Response((await response.text()).replace(/<pctVal>[^<]*<\/pctVal>/g, '<pctVal>N/A</pctVal>')) : response;
      }) as unknown as typeof fetch;
      const lines: string[] = [];
      const log = console.log;
      console.log = (line: unknown) => { if (/^NEW FUNDS/.test(String(line))) lines.push(String(line)); };
      try {
        await main(env({ TICKERS: 'FBND FBCV' }));
        expect(lines).toEqual(['NEW FUNDS: FBND', 'NEW FUNDS (not published yet): FBCV']);
        expect(readFileSync(join(root, 'summary.md'), 'utf8')).toContain('### NEW FUNDS\n\nNEW FUNDS: FBND\nNEW FUNDS (not published yet): FBCV\n');
        lines.length = 0;
        await main(env({ TICKERS: 'FBND FBCV' }));
        expect(lines).toEqual([]);
        globalThis.fetch = upstream;
        await main(env({ TICKERS: 'FBCV' }));
        expect(lines).toEqual(['NEW FUNDS: FBCV']);
      } finally {
        console.log = log;
      }
    });
  });
});

describe('pipeline 5', () => {
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
      refile('S000042567', '2026-06-30');
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
