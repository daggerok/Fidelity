import { describe, expect, test } from 'bun:test';
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
  formatEdgarDate,
  epochToIsoDate,
  normalizeHoldingName,
  normalizeHoldingNameCore,
  pickSearchTicker,
  yahooSearchUrl,
  TickerResolver,
  formatHeldTickersSeed,
} from './update-data';
import { HELD_TICKERS } from './held-tickers';

// ---------------------------------------------------------------------------
// Range parsers (same contract as daggerok/iShares and daggerok/SPDR)
// ---------------------------------------------------------------------------

describe('parseRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseRange('', 'X')).toBeUndefined();
    expect(parseRange(':', 'X')).toBeUndefined();
  });

  test('inclusive bounds', () => {
    expect(parseRange('1:5', 'X')).toEqual({ min: 1, max: 5 });
    expect(parseRange('2:', 'X')).toEqual({ min: 2, max: undefined });
    expect(parseRange(':3', 'X')).toEqual({ min: undefined, max: 3 });
  });

  test('percent signs and $ signs are optional', () => {
    expect(parseRange('0.1%:0.5%', 'X')).toEqual({ min: 0.1, max: 0.5 });
    expect(parseRange('$1:$2', 'X')).toEqual({ min: 1, max: 2 });
  });

  test('colonless values are rejected', () => {
    expect(() => parseRange('15', 'X')).toThrow(/colon is required/);
  });

  test('min greater than max is rejected', () => {
    expect(() => parseRange('5:1', 'X')).toThrow(/must not exceed/);
  });
});

describe('parseAumRange', () => {
  test('empty and ":" mean no restriction', () => {
    expect(parseAumRange('')).toBeUndefined();
    expect(parseAumRange(':')).toBeUndefined();
  });

  test('numeric bounds with K/M/B/T suffixes', () => {
    expect(parseAumRange('10M:2B')).toEqual({ min: 10_000_000, max: 2_000_000_000 });
    expect(parseAumRange('1.5T:')).toEqual({ min: 1.5e12, max: undefined });
  });

  test('preset bounds', () => {
    expect(parseAumRange('nano')).toEqual({ min: 0, max: 10_000_000 });
    expect(parseAumRange('micro')).toEqual({ min: 10_000_000, max: 300_000_000 });
    expect(parseAumRange('small')).toEqual({ min: 300_000_000, max: 2_000_000_000 });
    expect(parseAumRange('mid')).toEqual({ min: 2_000_000_000, max: 10_000_000_000 });
    expect(parseAumRange('large')).toEqual({ min: 10_000_000_000, max: undefined });
  });

  test('colonless values are rejected', () => {
    expect(() => parseAumRange('5B')).toThrow(/colon is required/);
  });
});

describe('normalizeNumberText', () => {
  test('expands scientific notation', () => {
    expect(normalizeNumberText('2.97057744E8')).toBe('297057744');
  });

  test('keeps plain numbers and text untouched', () => {
    expect(normalizeNumberText('12.34')).toBe('12.34');
    expect(normalizeNumberText('N/A')).toBe('N/A');
    expect(normalizeNumberText('-')).toBe('-');
    expect(normalizeNumberText('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// N-PORT-P fixtures (in-memory XML, same fixture style as SPDR's XLSX suite)
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

describe('nport fixtures', () => {
  test('parses equity holdings with weights, values and balances', () => {
    const xml = nportFixture(
      'Fidelity Metaverse ETF',
      equityPosition('EQUINIX INC', '29444U700', '4.250000', '12345678.90', '1.97000000e2') +
        equityPosition('DIGITAL REALTY TRUST INC', '253868103', '3.100000', '8765432.10', '8768.00000000'),
    );
    const parsed = parseNport(xml);
    expect(parsed.seriesName).toBe('Fidelity Metaverse ETF');
    expect(parsed.seriesId).toBe('S000099999');
    expect(parsed.repPdDate).toBe('2026-06-30');
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
  });

  test('falls back to identifiers when the CUSIP is N/A (bond rows)', () => {
    const xml = nportFixture(
      'Fidelity Total Bond ETF',
      `<invstOrSec>
        <name>US TREASURY N/B</name>
        <cusip>N/A</cusip>
        <identifiers><isin value="US91282CDX75"/><other value="91282CDX7"/></identifiers>
        <balance>1000000.00000000</balance>
        <curCd>USD</curCd>
        <valUSD>990000.00</valUSD>
        <pctVal>2.500000</pctVal>
        <assetCat>DB</assetCat>
      </invstOrSec>`,
    );
    const parsed = parseNport(xml);
    expect(parsed.holdings[0].Identifier).toBe('US91282CDX75'); // first published identifier wins
    expect(parsed.holdings[0].Ticker).toBe('-');
    expect(parsed.holdings[0]['Asset Category']).toBe('DB');
  });

  test('tolerates empty bodies and missing values', () => {
    const parsed = parseNport(nportFixture('Fidelity Test ETF', ''));
    expect(parsed.holdings).toHaveLength(0);
    expect(parsed.totalValue).toBe(0);
    expect(parsed.seriesName).toBe('Fidelity Test ETF');
  });

  test('submissions parser keeps only NPORT-P forms', () => {
    const submissions = {
      filings: {
        recent: {
          form: ['NPORT-P', 'N-CEN', 'NPORT-P', '4'],
          accessionNumber: ['0000035402-26-001', '0000035402-26-002', '0000035402-26-003', '0000035402-26-004'],
          filingDate: ['2026-08-24', '2026-08-01', '2026-07-20', '2026-08-25'],
          reportDate: ['2026-06-30', '', '2026-05-31', ''],
        },
      },
    };
    const accessions = parseNportAccessions(submissions);
    expect(accessions).toHaveLength(2);
    expect(accessions[0].accession).toBe('0000035402-26-001');
    expect(accessions[1].reportDate).toBe('2026-05-31');
  });
});

// ---------------------------------------------------------------------------
// Yahoo chart fixtures
// ---------------------------------------------------------------------------

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

describe('chart fixtures', () => {
  test('builds trading days, skips null closes, keeps adjusted closes', () => {
    const base = 1_700_000_000;
    const payload = chartFixture({
      days: [
        { t: base, close: 10, adj: 9.5, volume: 100 },
        { t: base + day, close: null as unknown as number },
        { t: base + 2 * day, close: 11, adj: 10.45, volume: 200 },
      ],
    });
    const parsed = parseChart(payload);
    expect(parsed.days).toHaveLength(2);
    expect(parsed.days[0].adjClose).toBe(9.5);
    expect(parsed.days[1].close).toBe(11);
    expect(parsed.exchangeName).toBe('NYSEArca');
    expect(parsed.navPrice).toBe(41.25);
  });

  test('falls back to raw closes when adjclose is absent', () => {
    const payload = chartFixture({ days: [{ t: 1_700_000_000, close: 10.5 }] });
    delete (payload.chart.result[0].indicators as Record<string, unknown>).adjclose;
    const parsed = parseChart(payload as never);
    expect(parsed.days[0].adjClose).toBe(10.5);
  });

  test('sorts dividends chronologically and drops non-positive amounts', () => {
    const payload = chartFixture({
      dividends: [
        { t: 1_700_000_000, amount: 0.17 },
        { t: 1_600_000_000, amount: 0.15 },
        { t: 1_500_000_000, amount: 0 },
      ],
    });
    const parsed = parseChart(payload);
    expect(parsed.dividends.map((d) => d.amount)).toEqual([0.15, 0.17]);
  });
});

// ---------------------------------------------------------------------------
// Derived metrics (SPDR parity + price-return derivations)
// ---------------------------------------------------------------------------

describe('annualizedToTotal / totalToAnnualized', () => {
  test('annualizedToTotal inverts annualization exactly', () => {
    // 10% CAGR over 2 years -> 21% cumulative.
    expect(annualizedToTotal(10, 2)).toBeCloseTo(21, 6);
  });

  test('guards bad input', () => {
    expect(annualizedToTotal(null, 3)).toBeNull();
    expect(annualizedToTotal(Number.NaN, 3)).toBeNull();
    expect(annualizedToTotal(5, 0)).toBeNull();
  });

  test('round-trips through totalToAnnualized', () => {
    const cagr = 7.5;
    const total = annualizedToTotal(cagr, 5);
    expect(totalToAnnualized(total, 5)).toBeCloseTo(cagr, 4);
  });
});

describe('indicatedYield', () => {
  test('computes latest distribution x frequency / price', () => {
    expect(indicatedYield(0.10, 4, 40)).toBeCloseTo(1.0, 6);
  });

  test('guards missing pieces', () => {
    expect(indicatedYield(null, 4, 40)).toBeNull();
    expect(indicatedYield(0.1, null, 40)).toBeNull();
    expect(indicatedYield(0.1, 4, 0)).toBeNull();
    expect(indicatedYield(0, 4, 40)).toBeNull();
  });
});

describe('inferDistributionFrequency', () => {
  test('detects quarterly and monthly cadences', () => {
    const quarterly = [0, 91, 182, 273].map((offset, i) => ({ epoch: 1_700_000_000 + offset * day, amount: 0.1 + i }));
    const monthly = [0, 30, 61, 91, 122].map((offset, i) => ({ epoch: 1_700_000_000 + offset * day, amount: 0.05 + i }));
    expect(inferDistributionFrequency(quarterly)).toEqual({ frequency: 'Quarterly', paymentsPerYear: 4 });
    expect(inferDistributionFrequency(monthly)).toEqual({ frequency: 'Monthly', paymentsPerYear: 12 });
  });

  test('no distributions means None (FBTC-style funds)', () => {
    expect(inferDistributionFrequency([])).toEqual({ frequency: 'None', paymentsPerYear: null });
  });
});

describe('priceReturns', () => {
  // Deterministic calendar: last close 2026-06-30 at 120.
  const mk = (iso: string, adjClose: number) => ({ date: iso, close: adjClose, adjClose, volume: 0 });
  const days = [
    mk('2020-01-02', 60),
    mk('2023-06-30', 90),
    mk('2025-06-30', 100),
    mk('2025-12-31', 108),
    mk('2026-01-02', 110),
    mk('2026-03-31', 114),
    mk('2026-05-29', 118),
    mk('2026-06-29', 119),
    mk('2026-06-30', 120),
  ];

  test('derives YTD, 1Y, CAGRs and SI anchored to the last close', () => {
    const now = new Date('2026-06-30T23:59:00Z');
    const returns = priceReturns(days, now);
    expect(returns.asOfDate).toBe('2026-06-30');
    expect(returns.ytd).toBeCloseTo(((120 - 108) / 108) * 100, 2); // vs the 2025 year-end close
    expect(returns.yr1).toBeCloseTo(((120 - 100) / 100) * 100, 2); // vs 2025-06-30
    expect(returns.cagr3y).toBeCloseTo(((120 / 90) ** (1 / 3) - 1) * 100, 2); // vs 2023-06-30
    expect(returns.siAnn).toBeCloseTo(((120 / 60) ** (1 / (days.length && 6.49)) - 1) * 100, 0); // rough since-inception
  });

  test('young funds produce nulls instead of made-up returns', () => {
    const young = [mk('2026-06-01', 100), mk('2026-06-30', 101)];
    const returns = priceReturns(young, new Date('2026-06-30T23:59:00Z'));
    expect(returns.cagr3y).toBeNull();
    expect(returns.cagr5y).toBeNull();
    expect(returns.siAnn).toBeNull();
    expect(priceReturns([]).asOfDate).toBe('');
  });
});

describe('lastCompletedQuarterEnd', () => {
  test('anchors to the last completed quarter', () => {
    expect(lastCompletedQuarterEnd(new Date('2026-08-26T00:00:00Z')).toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(lastCompletedQuarterEnd(new Date('2026-01-15T00:00:00Z')).toISOString().slice(0, 10)).toBe('2025-12-31');
  });
});

describe('deriveCatalogMetrics', () => {
  test('maps CAGRs directly and derives TRs, keeps SEC yield null', () => {
    const returns = {
      asOfDate: '2026-06-30', ytd: 9.09, yr1: 20, cagr3y: 10, cagr5y: 8, cagr10y: null, siAnn: 12.5, mo1: 0.85, qtd: 5.26,
    };
    const metrics = deriveCatalogMetrics(returns, 0.1, 4, 40);
    expect(metrics.cagr3y).toBe(10);
    expect(metrics.tr3y).toBeCloseTo(33.1, 2);
    expect(metrics.tr10y).toBeNull();
    expect(metrics.dividendYield).toBeCloseTo(1.0, 6);
    expect(metrics.secYield).toBeNull();
  });

  test('tolerates no-distribution funds (crypto)', () => {
    const metrics = deriveCatalogMetrics(priceReturns([]), null, null, null);
    expect(metrics.dividendYield).toBeNull();
    expect(metrics.dividendYieldText).toBe('—');
  });
});

describe('date formatting', () => {
  test('EDGAR ISO dates render like the sibling apps', () => {
    expect(formatEdgarDate('2026-06-30')).toBe('Jun 30 2026');
    expect(formatEdgarDate('')).toBe('');
  });

  test('epoch days convert to ISO', () => {
    expect(epochToIsoDate(1_782_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Holding ticker resolution (N-PORT rows carry no exchange tickers)
// ---------------------------------------------------------------------------

describe('normalizeHoldingName', () => {
  test('strips legal-form suffixes and fillers', () => {
    expect(normalizeHoldingName('DIGITAL OCEAN HOLDINGS INC')).toBe('DIGITAL OCEAN');
    expect(normalizeHoldingName('DigitalOcean Holdings, Inc.')).toBe('DIGITALOCEAN');
    expect(normalizeHoldingName('3M Co')).toBe('3M');
    expect(normalizeHoldingName('Brown-Forman Corp')).toBe('BROWN FORMAN');
    expect(normalizeHoldingName('A.O. Smith Corporation')).toBe('A O SMITH');
    expect(normalizeHoldingName('BECTON DICKINSON and CO')).toBe('BECTON DICKINSON');
    expect(normalizeHoldingName('Acushnet Holdings Inc. Class A Common Stock')).toBe('ACUSHNET');
    expect(normalizeHoldingName('ABN AMRO BANK N.V.')).toBe('ABN AMRO BANK');
    expect(normalizeHoldingName('US TREASURY N/B')).toBe('US TREASURY N B');
  });

  test('core form drops the remaining spaces', () => {
    expect(normalizeHoldingNameCore('DIGITAL OCEAN HOLDINGS')).toBe('DIGITALOCEAN');
    expect(normalizeHoldingNameCore('DigitalOcean Holdings, Inc.')).toBe('DIGITALOCEAN');
  });

  test('empty and junk names normalize to empty', () => {
    expect(normalizeHoldingName('')).toBe('');
    expect(normalizeHoldingName(null)).toBe('');
    expect(normalizeHoldingName('---')).toBe('');
  });
});

describe('held-tickers seed', () => {
  test('covers the filed names with their real exchange tickers', () => {
    expect(Object.keys(HELD_TICKERS).length).toBeGreaterThan(1000);
    expect(HELD_TICKERS['DIGITALOCEAN HOLDINGS INC']).toBe('DOCN');
    expect(HELD_TICKERS['DigitalOcean Holdings Inc']).toBe('DOCN');
    expect(HELD_TICKERS['ROBINHOOD MARKETS INC']).toBe('HOOD');
    expect(HELD_TICKERS['CIRCLE INTERNET GROUP INC']).toBe('CRCL');
    expect(HELD_TICKERS['3M CO']).toBe('MMM');
  });

  test('never maps a name to an empty ticker', () => {
    for (const [name, ticker] of Object.entries(HELD_TICKERS)) {
      expect(name.length > 0, `empty name key: ${ticker}`).toBe(true);
      expect(ticker.length > 0, `empty ticker for ${name}`).toBe(true);
    }
  });
});

describe('TickerResolver', () => {
  test('resolves from the seed by exact and normalized name', () => {
    const resolver = new TickerResolver({ 'DIGITALOCEAN HOLDINGS INC': 'DOCN', '3M CO': 'MMM' });
    expect(resolver.lookup('DIGITALOCEAN HOLDINGS INC')).toBe('DOCN');
    expect(resolver.lookup('DigitalOcean Holdings Inc')).toBe('DOCN'); // normalized match
    expect(resolver.lookup('DIGITAL OCEAN HOLDINGS')).toBe('DOCN'); // token-core match
    expect(resolver.lookup('3M Company')).toBe('MMM');
    expect(resolver.lookup('NOBODY HERE INC')).toBeNull();
  });

  test('learned hits are memoized: one search per unknown name', async () => {
    const seen: string[] = [];
    const resolver = new TickerResolver({}, async (name) => {
      seen.push(name);
      return name === 'BULLISH' ? 'BLSH' : null;
    });
    expect(await resolver.resolve('BULLISH')).toBe('BLSH');
    expect(await resolver.resolve('Bullish')).toBe('BLSH'); // learned, no re-query
    expect(seen).toEqual(['BULLISH']);
    expect(await resolver.resolve('SOME PRIVATE CLO 7 LTD')).toBe('-');
    expect(await resolver.resolve('SOME PRIVATE CLO 7 LTD')).toBe('-'); // miss cached
    expect(seen).toEqual(['BULLISH', 'SOME PRIVATE CLO 7 LTD']);
    expect(resolver.freshEntries()).toEqual({ BULLISH: 'BLSH' });
  });

  test('search failures degrade to "-" and are not retried', async () => {
    let calls = 0;
    const resolver = new TickerResolver({}, async () => {
      calls += 1;
      throw new Error('offline');
    });
    expect(await resolver.resolve('SOME PRIVATE LLC')).toBe('-');
    expect(await resolver.resolve('SOME PRIVATE LLC')).toBe('-');
    expect(calls).toBe(1);
  });

  test('without a search function only seed lookups work', async () => {
    const resolver = new TickerResolver({ 'ROBINHOOD MARKETS INC': 'HOOD' });
    expect(await resolver.resolve('ROBINHOOD MARKETS INC')).toBe('HOOD');
    expect(await resolver.resolve('UNKNOWN NAME INC')).toBe('-');
  });

  test('keeps class-share markers in the real exchange symbol', () => {
    const resolver = new TickerResolver({ 'SCE TRUST VI': 'SCE^L', 'BERKSHIRE HATHAWAY INC': 'BRK-B' });
    expect(resolver.lookup('SCE TRUST VI')).toBe('SCE^L');
    expect(resolver.lookup('Berkshire Hathaway Inc')).toBe('BRK-B');
    expect(formatHeldTickersSeed({ 'SCE TRUST VI': 'sce^l' })).toContain('"SCE^L"');
  });

  test('ambiguous normalized keys fall back safely', () => {
    const resolver = new TickerResolver({ 'ACME INC': 'ACME', 'ACME CO': 'ACMX' });
    // "ACME" normalizes to the same key for both tickers -> ambiguous, no guess.
    expect(resolver.lookup('ACME')).toBeNull();
    expect(resolver.lookup('ACME INC')).toBe('ACME');
  });
});

describe('pickSearchTicker', () => {
  const docnPayload = {
    quoteMatches: [
      { symbol: 'WRONG', longname: 'Something Else Inc', quoteType: 'EQUITY' },
      { symbol: 'DOCN', longname: 'DigitalOcean Holdings, Inc.', quoteType: 'EQUITY' },
      { symbol: 'DOCNW', longname: 'DigitalOcean Holdings, Inc. Warrant', quoteType: 'EQUITY' },
    ],
  };

  test('matches by normalized name, not by list position', () => {
    expect(pickSearchTicker('DIGITAL OCEAN HOLDINGS INC', docnPayload)).toBe('DOCN');
    expect(pickSearchTicker('DigitalOcean Holdings, Inc.', docnPayload)).toBe('DOCN');
  });

  test('ignores non-equity quotes and non-matching names', () => {
    const payload = { quoteMatches: [{ symbol: 'EURUSD=X', longname: 'Euro US Dollar', quoteType: 'CURRENCY' }] };
    expect(pickSearchTicker('DIGITAL OCEAN HOLDINGS INC', payload)).toBeNull();
    expect(pickSearchTicker('SOMETHING ENTIRELY DIFFERENT LTD', docnPayload)).toBeNull();
    expect(pickSearchTicker('BULLISH', {})).toBeNull();
  });

  test('short single/two-word names may match by token containment', () => {
    const payload = { quoteMatches: [{ symbol: 'BLSH', longname: 'Bullish BLCM Inc', quoteType: 'EQUITY' }] };
    expect(pickSearchTicker('BULLISH', payload)).toBe('BLSH');
  });

  test('builds the strict-match search URL', () => {
    expect(yahooSearchUrl('DIGITAL OCEAN')).toBe(
      'https://query1.finance.yahoo.com/v1/finance/search?q=DIGITAL%20OCEAN&quotesCount=10&newsCount=0&enableFuzzyQuery=false',
    );
  });
});

describe('formatHeldTickersSeed', () => {
  test('is deterministic and case-insensitively sorted', () => {
    const a = formatHeldTickersSeed({ B: 'BB', A: 'AA', 'a10 networks inc': 'A' });
    expect(a).toBe(formatHeldTickersSeed({ 'a10 networks inc': 'A', B: 'BB', A: 'AA' }));
    expect(a.indexOf('"A"')).toBeLessThan(a.indexOf('"a10 networks inc"'));
    expect(a.indexOf('"a10 networks inc"')).toBeLessThan(a.indexOf('"B"'));
  });

  test('drops empty names and tickers', () => {
    const out = formatHeldTickersSeed({ '': 'XX', 'VALID INC': '', GOOD: 'GD' });
    expect(out).not.toContain('XX');
    expect(out).not.toContain('"VALID INC"');
    expect(out).toContain('"GOOD": "GD"');
  });
});

// Run timestamps must not turn unchanged data/cursor state into daily commits.
import { samePublishedContent } from './update-data';
test('published JSON ignores run timestamp-only changes but preserves real updates', () => {
  expect(samePublishedContent('{"generatedAt":"old","funds":[{"ticker":"FAAA"}]}', { generatedAt: 'new', funds: [{ ticker: 'FAAA' }] })).toBe(true);
  expect(samePublishedContent('{"cursor":null,"savedAt":"old"}', { cursor: null, savedAt: 'new' })).toBe(true);
  expect(samePublishedContent('{"cursor":null,"savedAt":"old"}', { cursor: 'FBND', savedAt: 'new' })).toBe(false);
  expect(samePublishedContent('{"generatedAt":"old","funds":[]}', { generatedAt: 'new', funds: [{ ticker: 'FAAA' }] })).toBe(false);
  expect(samePublishedContent('broken', {})).toBe(false);
});
