#!/usr/bin/env bun
/// <reference types="bun" />
import { readFile as outputReadFile, readdir as outputReadDir } from 'node:fs/promises';
import { createHash as outputCreateHash } from 'node:crypto';
import { join as outputJoin } from 'node:path';
import { fileURLToPath as outputFileURLToPath } from 'node:url';

// Console presentation; no changes to provider requests or persisted data.
/** Presentation only: no requests, writes, filtering, or changes to updater state. */

const outputClean = (value: unknown): string => String(value ?? 'null').replace(/[\r\n\t]+/g, ' ');
/** Presentation only: per-fund retry and fallback notices are printed when VERBOSE is enabled. */
const outputVerbose = (): boolean => /^(1|true|yes|on)$/i.test((globalThis as any).process?.env?.VERBOSE ?? '');
function outputNote(message: string): void { if (outputVerbose()) console.warn(message); }
/** Names are the canonical environment knobs, not internal parser properties. */
function outputConfigEntries(config: Record<string, any>): [string, string][] {
  const values = new Map<string, string>();
  const aliases: Record<string, string> = {
    requestSleepSeconds: 'REQUEST_SLEEP', categories: 'CATEGORY',
    aumRange: 'AUM', terRange: 'TER', dividendYieldRange: 'DIVIDEND_YIELD', secYieldRange: 'SEC_YIELD',
    performanceRanges: 'PERFORMANCE', totalReturnRanges: 'TOTAL_RETURN',
    skipVanEck: 'SKIP_VANECK', skipProShares: 'SKIP_PROSHARES',
    skipWisdomTree: 'SKIP_WISDOMTREE', skipGoldmanSachs: 'SKIP_GOLDMANSACHS',
    skipGlobalX: 'SKIP_GLOBALX', skipNorthernTrust: 'SKIP_NORTHERNTRUST',
  };
  const range = (v: any): string => typeof v === 'string' ? v : v?.source ?? `${Number.isFinite(v?.min) ? v.min : ''}:${Number.isFinite(v?.max) ? v.max : ''}`;
  for (const [key, value] of Object.entries(config)) {
    if (['proxyGapMs', 'fetchTimeoutMs', 'retryDelayMs'].includes(key)) continue;
    const name = aliases[key] ?? (/^[A-Z0-9_]+$/.test(key) ? key : key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase());
    if (name === 'PERFORMANCE' || name === 'TOTAL_RETURN') {
      for (const period of ['YTD', '1Y', '3Y', '5Y', '10Y']) values.set(`${name}_${period}`, range(value?.[period]));
    } else if (['AUM', 'TER', 'DIVIDEND_YIELD', 'SEC_YIELD'].includes(name)) {
      values.set(name, range(value));
    } else {
      values.set(name, value instanceof Set ? [...value].join(',') || 'all' : Array.isArray(value) ? value.join(',') || 'all' : outputClean(value));
    }
  }
  const first = ['MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY'];
  return [...values].sort(([a], [b]) => {
    const ai = first.indexOf(a), bi = first.indexOf(b);
    return (ai < 0 ? first.length : ai) - (bi < 0 ? first.length : bi) || a.localeCompare(b);
  });
}
function outputConfigValue(key: string, value: string): string {
  if (/TOKEN|PASSWORD|SECRET|COOKIE|SEC_UA/i.test(key)) return '<redacted>';
  if (key === 'TICKERS' && ['', 'null', 'undefined'].includes(value)) return 'all';
  return outputClean(value);
}
function outputPrintConfig(brand: string, config: Record<string, any>): void {
  const entries: [string, string][] = [...outputConfigEntries(config), ['VERBOSE', String(outputVerbose())]];
  console.log(`[ config   ] ${brand} updater:\n${entries.map(([key, value]) => `              ${key}=${outputConfigValue(key, value)}`).join('\n')}`);
}
function outputHasOutputFilters(config: Record<string, any>): boolean {
  return outputConfigEntries(config).some(([name, value]) =>
    /^(CATEGORY|AUM|TER|DIVIDEND_YIELD|SEC_YIELD|PERFORMANCE_|TOTAL_RETURN_)/.test(name) &&
    !['', ':', 'null', 'all'].includes(value));
}
function outputPrintFilter(selected: number, total: number, deferred = false): void {
  console.log(`[ filter   ] ${selected} of ${total} funds ${deferred ? 'selected for evaluation (data-dependent filters applied per fund)' : 'pass filters'}`);
}
function outputStable(value: any): any {
  if (Array.isArray(value)) return value.map(outputStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !['generatedAt', 'catalogReadAt'].includes(key)).map(key => [key, outputStable(value[key])]));
  return value;
}
function outputContentKey(value: unknown): string { return JSON.stringify(outputStable(value)) ?? 'null'; }
async function outputInspectFund(root: URL | string, ticker: string): Promise<{ digest: string; meta: any }> {
  const dir = outputJoin(root instanceof URL ? outputFileURLToPath(root) : root, 'funds', ticker);
  const hash = outputCreateHash('sha256');
  async function visit(path: string): Promise<void> {
    const entries = await outputReadDir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await visit(outputJoin(path, entry.name));
      else if (entry.name.endsWith('.json')) {
        const text = await outputReadFile(outputJoin(path, entry.name), 'utf8').catch(() => '');
        hash.update(outputJoin(path.slice(dir.length), entry.name));
        try { hash.update(outputContentKey(JSON.parse(text))); } catch { hash.update(text); }
      }
    }
  }
  await visit(dir);
  const meta = await outputReadFile(outputJoin(dir, 'meta.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  return { digest: hash.digest('hex'), meta };
}
const outputCount = (value: any): unknown => typeof value === 'number' ? value : Array.isArray(value) ? value.length : value?.totalRows ?? value?.rows?.length ?? null;
const outputScalar = (value: any): any => value && typeof value === 'object' ? value.display ?? value.value ?? null : value;
const outputUnits: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12 };
function outputMoney(value: any): string {
  const raw = value && typeof value === 'object' && typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : outputScalar(value);
  if (raw === null || raw === undefined || raw === '—' || raw === '--') return 'null';
  const text = String(raw).replace(/[$,\s]/g, '');
  const match = text.match(/^([+-]?[\d.]+)(K|M|B|T|Thousand|Million|Billion|Trillion)?$/i);
  if (!match) return outputClean(raw);
  const number = Number(match[1]) * (outputUnits[match[2]?.toUpperCase() ?? ''] ?? 1);
  if (!Number.isFinite(number)) return 'null';
  for (const [unit, scale] of [['T', 1e12], ['B', 1e9], ['M', 1e6], ['K', 1e3]] as const) {
    if (Math.abs(number) >= scale) return `$${(number / scale).toFixed(1)}${unit}`;
  }
  return `$${number.toFixed(2)}`;
}
/** Yields: rounded to 2 decimals without trailing zeros; placeholders are omitted like null. */
function outputPercent(value: any): unknown {
  const raw = outputScalar(value);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? Number(raw.toFixed(2)) : null;
  const text = String(raw).trim().replace(/%$/, '').trim();
  if (['', '-', '—', '--', 'n/a'].includes(text.toLowerCase())) return null;
  const number = Number(text.replace(/,/g, ''));
  return Number.isFinite(number) ? Number(number.toFixed(2)) : outputClean(raw);
}
function outputFundLine(index: number, total: number, ticker: string, status: string, data: any = {}, reason?: unknown): string {
  const width = Math.max(2, String(total).length);
  const metrics = data.metrics ?? {};
  // Presentation only. Keep valid zero/false values; omit unavailable fields.
  // outputMoney returns the string 'null' for an unavailable monetary value.
  const field = (key: string, value: unknown): string =>
    value === null || value === undefined || value === 'null' ? '' : `${key}=${outputClean(value)}`;
  const sources = [
    field('official', data.officialHistoryCount),
    field('yahoo', data.yahooHistoryCount),
  ].filter(part => part !== '').join(' ');
  const detail = [
    field('port', data.portId ?? data.portfolioId),
    field('history', outputCount(data.history ?? data.historyCount)),
    sources ? `(${sources})` : '',
    field('holdings', outputCount(data.holdings ?? data.holdingsCount)),
    field('divs', outputCount(data.worksheets?.Distributions ?? data.distributions)),
    field('netAssets', outputMoney(data.netAssets ?? data.aum)),
    field('total', outputMoney(data.totalFundNetAssets ?? data.totalNetAssets)),
    field('div', outputPercent(data.trailingYield ?? data.yields?.effectiveYield ?? data.yields?.dividendYield ?? data.dividendYield ?? metrics.dividendYield)),
    field('sec', outputPercent(data.secYield ?? data.yields?.secYield ?? metrics.secYield)),
    field('wp', data.workplaceRaw),
  ].filter(part => part !== '').join(' ');
  return `[ ${String(index).padStart(width)}/${String(total).padEnd(width)}  ] ${outputClean(ticker).padEnd(5)} ${status.padEnd(9)}${detail ? ` ${detail}` : ''}${reason ? ` reason=${outputClean(reason)}` : ''}`;
}
function outputCreateReporter(root: URL | string, total: number) {
  let completed = 0;
  const tally = new Map<string, number>();
  return {
    before: (ticker: string) => outputInspectFund(root, ticker),
    async result(ticker: string, before: { digest: string }, status?: string, reason?: unknown, extra: any = {}) {
      const after = await outputInspectFund(root, ticker);
      const final = status ?? (before.digest === after.digest ? 'unchanged' : 'updated');
      tally.set(final, (tally.get(final) ?? 0) + 1);
      console.log(outputFundLine(++completed, total, ticker, final, { ...after.meta, ...extra }, reason));
    },
    /** First [ done ] line: the statuses of every fund line this reporter printed. */
    summary(startedAt: number): string {
      const order = ['updated', 'unchanged', 'kept', 'skipped', 'failed'];
      const statuses = [...order, ...[...tally.keys()].filter(status => !order.includes(status))];
      return `[ done     ] ${completed} fund${completed === 1 ? '' : 's'}: ${statuses.map(status => `${tally.get(status) ?? 0} ${status}`).join(', ')} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
    },
  };
}
/** Second [ done ] line: published totals. */
function outputCounts(funds: number, holdings: number, history: number): string {
  return `[ done     ] counts: ${funds.toLocaleString('en-US')} funds / ${holdings.toLocaleString('en-US')} holdings rows / ${history.toLocaleString('en-US')} history rows`;
}


// Fidelity ETF static data updater.
// Fetches official SEC EDGAR N-PORT-P holdings filings for the Fidelity ETF
// trusts and daily market/NAV history plus distributions from the public
// Yahoo Finance chart API, then writes a deterministic, paginated static
// JSON API under ./api/fidelity, following the daggerok/iShares and
// daggerok/SPDR repository design (no dependencies, Bun only).

import { mkdir, readFile, writeFile, readdir, rm, appendFile, rename } from 'node:fs/promises';

// --- TLS trust store (identical in every ETF repo) ---
const SYSTEM_CA_MARKER = 'ETF_UPDATER_SYSTEM_CA';
const CERT_ERROR = /UNABLE_TO_GET_ISSUER_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_HAS_EXPIRED|unable to get (?:local )?issuer certificate|self[- ]signed certificate|certificate has expired/i;

export function isCertError(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  return CERT_ERROR.test(`${String(e?.code ?? '')} ${String(e?.message ?? '')}`) || (e?.cause ? isCertError(e.cause) : false);
}

export function systemCaActive(env: Record<string, string | undefined> = process.env, execArgv: string[] = process.execArgv): boolean {
  return execArgv.includes('--use-system-ca') || env.NODE_USE_SYSTEM_CA === '1' || env[SYSTEM_CA_MARKER] === '1';
}

export function reexecWithSystemCa(): never {
  const child = Bun.spawnSync([process.execPath, '--use-system-ca', ...process.argv.slice(1)], {
    env: { ...process.env, [SYSTEM_CA_MARKER]: '1' },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}

/** mode: auto (restart once on an untrusted-certificate error), true (restart now), false (never). */
export function installSystemCa(mode: string, reexec: () => never = reexecWithSystemCa, active: boolean = systemCaActive()): void {
  if (mode === 'false' || active) return;
  if (mode === 'true') reexec();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    try { return await realFetch(...args); }
    catch (error) {
      if (!isCertError(error)) throw error;
      console.error('[ notice   ] TLS certificate not trusted; restarting once with --use-system-ca');
      return reexec();
    }
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Fidelity ETF seed
// ---------------------------------------------------------------------------

// Fidelity ETF seed: ticker <-> SEC series mapping, verified against
// EDGAR N-PORT-P filings (seriesId + accession) and Yahoo Finance
// (instrumentType, longName, firstTradeDate, expense ratio).
//
// Fidelity publishes no public fund-data API, so this seed is the catalog
// backbone: the updater refreshes holdings by seriesId from EDGAR (each
// series' newest N-PORT-P filing, found by the shared nport-reader block
// while REFRESH_CATALOG is on) and history from Yahoo. The series id and CIK
// of SEC company_tickers_mf.json win over the seed's; the seed covers a
// ticker the table lacks. Re-verify quarterly with `bun test` regression checks.
//
// Generated 2026-08-26 from SEC EDGAR + Yahoo public data.

export const FIDELITY_TRUSTS: Record<string, string> = {
  '0000945908': 'Fidelity Covington Trust',
  '0001562565': 'Fidelity Merrimack Street Trust',
  '0001852317': 'Fidelity Wise Origin Bitcoin Fund',
  '0002000046': 'Fidelity Ethereum Fund',
  '0000754510': 'Fidelity Securities Fund',
};

export type FidelitySeedFund = {
  ticker: string;
  name: string;
  seriesId: string | null;
  trustCik: string;
  category: string;
  /** The N-PORT-P filing the seed row was verified against (provenance only: the updater reads each series' newest filing). */
  accession: string | null;
  filed: string | null;
  repPdDate: string | null;
  inception: string | null;
  exchange: string;
  ter: number | null;
  fundPage: string;
  catalogOnly?: boolean;
  /**
   * ETF share class of a multi-class mutual fund: the N-PORT series name. The filing covers every class, so its
   * series name (not the ETF's) is checked, the ETF keeps the seed name, and AUM stays null (the net assets are the whole fund's).
   */
  shareClassOf?: string;
};

export const FIDELITY_FUNDS: FidelitySeedFund[] = [
    { ticker: 'FAAA', name: 'Fidelity AAA CLO ETF', seriesId: 'S000099377', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004633', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2026-02-12', exchange: 'NasdaqGM', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FAAA' },
    { ticker: 'FBCG', name: 'Fidelity Blue Chip Growth ETF', seriesId: 'S000068173', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004036', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2020-06-05', exchange: 'Cboe US', ter: 0.57, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FBCG' },
    { ticker: 'FBCV', name: 'Fidelity Blue Chip Value ETF', seriesId: 'S000068175', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004033', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2020-06-05', exchange: 'Cboe US', ter: 0.57, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FBCV' },
    { ticker: 'FBND', name: 'Fidelity Total Bond ETF', seriesId: 'S000042567', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004724', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2014-10-09', exchange: 'NYSEArca', ter: 0.36, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FBND' },
    { ticker: 'FBOT', name: 'Fidelity Disruptive Automation ETF', seriesId: 'S000079685', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-004640', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-12', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FBOT' },
    { ticker: 'FBTC', name: 'Fidelity Wise Origin Bitcoin Fund', seriesId: null, trustCik: '0001852317', category: 'Digital Assets', accession: null, filed: null, repPdDate: null, inception: '2024-01-11', exchange: 'Cboe US', ter: 0.25, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FBTC', catalogOnly: true },
    { ticker: 'FCLD', name: 'Fidelity Cloud Computing ETF', seriesId: 'S000073598', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-005390', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2021-10-07', exchange: 'Cboe US', ter: 0.39, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FCLD' },
    { ticker: 'FCLO', name: 'Fidelity CLO ETF', seriesId: 'S000099376', trustCik: '0000945908', category: 'Bond', accession: '0000035402-26-004622', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2026-02-12', exchange: 'NasdaqGM', ter: 0.0, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FCLO' },
    { ticker: 'FCOM', name: 'Fidelity MSCI Communication Services Index ETF', seriesId: 'S000042579', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063883', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FCOM' },
    { ticker: 'FCOR', name: 'Fidelity Corporate Bond ETF', seriesId: 'S000040431', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004643', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2014-10-09', exchange: 'NYSEArca', ter: 0.36, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FCOR' },
    { ticker: 'FCPI', name: 'Fidelity Stocks for Inflation ETF', seriesId: 'S000066804', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004225', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2019-11-07', exchange: 'Cboe US', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FCPI' },
    { ticker: 'FDCF', name: 'Fidelity Disruptive Communications ETF', seriesId: 'S000079686', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-004620', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-12', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDCF' },
    { ticker: 'FDEM', name: 'Fidelity Emerging Markets Multifactor ETF', seriesId: 'S000064787', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004045', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2019-03-01', exchange: 'Cboe US', ter: 0.25, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDEM' },
    { ticker: 'FDEV', name: 'Fidelity International Multifactor ETF', seriesId: 'S000064788', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004091', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2019-03-01', exchange: 'Cboe US', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDEV' },
    { ticker: 'FDFF', name: 'Fidelity Disruptive Finance ETF', seriesId: 'S000079687', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-004619', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-12', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDFF' },
    { ticker: 'FDHY', name: 'Fidelity Enhanced High Yield ETF', seriesId: 'S000062078', trustCik: '0000945908', category: 'Bond', accession: '0000035402-26-004665', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2018-06-14', exchange: 'NYSEArca', ter: 0.35, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDHY' },
    { ticker: 'FDIF', name: 'Fidelity Disruptors ETF', seriesId: 'S000079690', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004651', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-20', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDIF' },
    { ticker: 'FDIG', name: 'Fidelity Crypto Industry and Digital Payments ETF', seriesId: 'S000075902', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-005394', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2022-04-21', exchange: 'NasdaqGM', ter: 0.39, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDIG' },
    { ticker: 'FDIS', name: 'Fidelity MSCI Consumer Discretionary Index ETF', seriesId: 'S000042570', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063882', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDIS' },
    { ticker: 'FDLO', name: 'Fidelity Low Volatility Factor ETF', seriesId: 'S000054751', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004112', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2016-09-15', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDLO' },
    { ticker: 'FDMO', name: 'Fidelity Momentum Factor ETF', seriesId: 'S000054752', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004099', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2016-09-15', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDMO' },
    { ticker: 'FDRV', name: 'Fidelity Electric Vehicles and Future Transportation ETF', seriesId: 'S000073600', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-005378', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2021-10-07', exchange: 'Cboe US', ter: 0.39, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDRV' },
    { ticker: 'FDTX', name: 'Fidelity Disruptive Technology ETF', seriesId: 'S000079689', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-004627', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-12', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDTX' },
    { ticker: 'FDVV', name: 'Fidelity High Dividend ETF', seriesId: 'S000054749', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004078', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2016-09-15', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FDVV' },
    { ticker: 'FEAC', name: 'Fidelity Enhanced U.S. All-Cap Equity ETF', seriesId: 'S000087779', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005417', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2024-11-21', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FEAC' },
    { ticker: 'FELC', name: 'Fidelity Enhanced Large Cap Core ETF', seriesId: 'S000081804', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005398', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FELC' },
    { ticker: 'FELG', name: 'Fidelity Enhanced Large Cap Growth ETF', seriesId: 'S000081805', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005384', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FELG' },
    { ticker: 'FELV', name: 'Fidelity Enhanced Large Cap Value ETF', seriesId: 'S000081806', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005385', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FELV' },
    { ticker: 'FEMG', name: 'Fidelity Enhanced Mid Cap Growth ETF', seriesId: 'S000102550', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005396', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2026-04-30', exchange: 'NYSEArca', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FEMG' },
    { ticker: 'FEMR', name: 'Fidelity Enhanced Emerging Markets ETF', seriesId: 'S000087780', trustCik: '0000945908', category: 'International', accession: '0000035402-26-005383', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2024-11-21', exchange: 'NYSEArca', ter: 0.38, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FEMR' },
    { ticker: 'FEMV', name: 'Fidelity Enhanced Mid Cap Value ETF', seriesId: 'S000102551', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005395', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2026-04-30', exchange: 'NYSEArca', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FEMV' },
    { ticker: 'FENI', name: 'Fidelity Enhanced International ETF', seriesId: 'S000081802', trustCik: '0000945908', category: 'International', accession: '0000035402-26-005399', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.28, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FENI' },
    { ticker: 'FENY', name: 'Fidelity MSCI Energy Index ETF', seriesId: 'S000042573', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063881', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FENY' },
    { ticker: 'FESM', name: 'Fidelity Enhanced Small Cap Core ETF', seriesId: 'S000081807', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005400', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.28, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FESM' },
    { ticker: 'FETH', name: 'Fidelity Ethereum Fund', seriesId: null, trustCik: '0002000046', category: 'Digital Assets', accession: null, filed: null, repPdDate: null, inception: '2024-07-23', exchange: 'Cboe US', ter: 0.25, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FETH', catalogOnly: true },
    { ticker: 'FFDI', name: 'Fidelity Fundamental Developed International ETF', seriesId: 'S000087781', trustCik: '0000945908', category: 'International', accession: '0000035402-26-004054', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2024-11-21', exchange: 'Cboe US', ter: 0.55, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFDI' },
    { ticker: 'FFEM', name: 'Fidelity Fundamental Emerging Markets ETF', seriesId: 'S000087783', trustCik: '0000945908', category: 'International', accession: '0000035402-26-004060', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2024-11-21', exchange: 'Cboe US', ter: 0.6, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFEM' },
    { ticker: 'FFGX', name: 'Fidelity Fundamental Global ex US ETF', seriesId: 'S000087782', trustCik: '0000945908', category: 'International', accession: '0000035402-26-004042', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2024-11-21', exchange: 'Cboe US', ter: 0.55, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFGX' },
    { ticker: 'FFLC', name: 'Fidelity Fundamental Large Cap Core ETF', seriesId: 'S000068174', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004052', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2020-06-05', exchange: 'Cboe US', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFLC' },
    { ticker: 'FFLG', name: 'Fidelity Fundamental Large Cap Growth ETF', seriesId: 'S000070233', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004062', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2021-02-04', exchange: 'Cboe US', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFLG' },
    { ticker: 'FFLV', name: 'Fidelity Fundamental Large Cap Value ETF', seriesId: 'S000084016', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004089', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2024-02-26', exchange: 'Cboe US', ter: 0.38, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFLV' },
    { ticker: 'FFSM', name: 'Fidelity Fundamental Small-Mid Cap ETF', seriesId: 'S000070236', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004079', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2021-02-04', exchange: 'Cboe US', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FFSM' },
    { ticker: 'FHLC', name: 'Fidelity MSCI Health Care Index ETF', seriesId: 'S000042575', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063876', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FHLC' },
    { ticker: 'FIDI', name: 'Fidelity International High Dividend ETF', seriesId: 'S000059462', trustCik: '0000945908', category: 'International', accession: '0000035402-26-004085', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2018-01-25', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FIDI' },
    { ticker: 'FIDU', name: 'Fidelity MSCI Industrials Index ETF', seriesId: 'S000042576', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063878', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FIDU' },
    { ticker: 'FIGB', name: 'Fidelity Investment Grade Bond ETF', seriesId: 'S000071131', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004658', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2021-03-04', exchange: 'NYSEArca', ter: 0.36, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FIGB' },
    { ticker: 'FIVA', name: 'Fidelity International Value Factor ETF', seriesId: 'S000059463', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004084', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2018-01-25', exchange: 'NYSEArca', ter: 0.18, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FIVA' },
    { ticker: 'FLDB', name: 'Fidelity Low Duration Bond ETF', seriesId: 'S000084018', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004694', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2024-02-26', exchange: 'NasdaqGM', ter: 0.2, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FLDB' },
    { ticker: 'FLDR', name: 'Fidelity Low Duration Bond Factor ETF', seriesId: 'S000062079', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004687', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2018-06-18', exchange: 'Cboe US', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FLDR' },
    { ticker: 'FLRG', name: 'Fidelity U.S. Multifactor ETF', seriesId: 'S000068350', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004211', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2020-09-18', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FLRG' },
    { ticker: 'FLTB', name: 'Fidelity Limited Term Bond ETF', seriesId: 'S000042569', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004685', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2014-10-09', exchange: 'NYSEArca', ter: 0.25, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FLTB' },
    { ticker: 'FMAG', name: 'Fidelity Magellan ETF', seriesId: 'S000070234', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-004116', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2021-02-04', exchange: 'Cboe US', ter: 0.57, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMAG' },
    { ticker: 'FMAT', name: 'Fidelity MSCI Materials Index ETF', seriesId: 'S000042578', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063875', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMAT' },
    { ticker: 'FMDE', name: 'Fidelity Enhanced Mid Cap Core ETF', seriesId: 'S000081803', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005387', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2023-11-20', exchange: 'NYSEArca', ter: 0.23, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMDE' },
    { ticker: 'FMED', name: 'Fidelity Disruptive Medicine ETF', seriesId: 'S000079688', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-004621', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-06-12', exchange: 'NasdaqGM', ter: 0.5, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMED' },
    { ticker: 'FMET', name: 'Fidelity Metaverse ETF', seriesId: 'S000075903', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-005474', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2022-04-21', exchange: 'NasdaqGM', ter: 0.39, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMET' },
    { ticker: 'FMUB', name: 'Fidelity Municipal Bond Opportunities ETF', seriesId: 'S000089370', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004110', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2025-04-07', exchange: 'NasdaqGM', ter: 0.3, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMUB' },
    { ticker: 'FMUN', name: 'Fidelity Systematic Municipal Bond Index ETF', seriesId: 'S000089371', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-005529', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2025-04-08', exchange: 'NasdaqGM', ter: 0.05, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FMUN' },
    { ticker: 'FNCL', name: 'Fidelity MSCI Financials Index ETF', seriesId: 'S000042574', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063879', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FNCL' },
    { ticker: 'FPFD', name: 'Fidelity Preferred Securities and Income ETF', seriesId: 'S000072125', trustCik: '0000945908', category: 'Bond', accession: '0000035402-26-004678', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2021-06-17', exchange: 'Cboe US', ter: 0.59, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FPFD' },
    { ticker: 'FPRO', name: 'Fidelity Real Estate Investment ETF', seriesId: 'S000070235', trustCik: '0000945908', category: 'Sector', accession: '0000035402-26-004137', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2021-02-04', exchange: 'Cboe US', ter: 0.57, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FPRO' },
    { ticker: 'FQAL', name: 'Fidelity Quality Factor ETF', seriesId: 'S000054753', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004131', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2016-09-16', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FQAL' },
    // ETF Class (C000276225) of Fidelity Real Estate Income Fund, series S000007192 of Fidelity Securities Fund (SEC company_tickers_mf.json).
    // TER: net 0.57% after the FMR reimbursement (gross 0.76%), summary prospectus 2026-09-29, EDGAR 497K 0000754510-26-000241.
    { ticker: 'FREI', name: 'Fidelity Real Estate Income Fund ETF Class', seriesId: 'S000007192', trustCik: '0000754510', category: 'Sector', accession: '0000035402-26-006222', filed: '2026-09-23', repPdDate: '2026-07-31', inception: '2026-06-18', exchange: 'NasdaqGM', ter: 0.57, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FREI', shareClassOf: 'Fidelity Real Estate Income Fund' },
    { ticker: 'FRNW', name: 'Fidelity Clean Energy ETF', seriesId: 'S000073597', trustCik: '0000945908', category: 'Thematic', accession: '0000035402-26-005377', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2021-10-07', exchange: 'Cboe US', ter: 0.39, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FRNW' },
    { ticker: 'FSEC', name: 'Fidelity Investment Grade Securitized ETF', seriesId: 'S000071132', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004686', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2021-03-08', exchange: 'NYSEArca', ter: 0.36, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSEC' },
    { ticker: 'FSEG', name: 'Fidelity Enhanced Small Cap Growth ETF', seriesId: 'S000102552', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005422', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2026-04-30', exchange: 'NYSEArca', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSEG' },
    { ticker: 'FSEV', name: 'Fidelity Enhanced Small Cap Value ETF', seriesId: 'S000102553', trustCik: '0000945908', category: 'US Equity', accession: '0000035402-26-005415', filed: '2026-08-24', repPdDate: '2026-06-30', inception: '2026-04-30', exchange: 'NYSEArca', ter: null, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSEV' },
    { ticker: 'FSMD', name: 'Fidelity Small-Mid Multifactor ETF', seriesId: 'S000064786', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004227', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2019-02-28', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSMD' },
    { ticker: 'FSTA', name: 'Fidelity MSCI Consumer Staples Index ETF', seriesId: 'S000042572', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063877', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSTA' },
    { ticker: 'FSYD', name: 'Fidelity Sustainable High Yield ETF', seriesId: 'S000075296', trustCik: '0000945908', category: 'Bond', accession: '0000035402-26-004717', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2022-02-17', exchange: 'NYSEArca', ter: 0.55, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FSYD' },
    { ticker: 'FTBD', name: 'Fidelity Tactical Bond ETF', seriesId: 'S000079047', trustCik: '0001562565', category: 'Bond', accession: '0000035402-26-004704', filed: '2026-07-24', repPdDate: '2026-05-31', inception: '2023-01-26', exchange: 'NYSEArca', ter: 0.55, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FTBD' },
    { ticker: 'FTEC', name: 'Fidelity MSCI Information Technology Index ETF', seriesId: 'S000042577', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063885', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FTEC' },
    { ticker: 'FUTY', name: 'Fidelity MSCI Utilities Index ETF', seriesId: 'S000042571', trustCik: '0000945908', category: 'Sector', accession: '0001410368-26-063880', filed: '2026-06-23', repPdDate: '2026-04-30', inception: '2013-10-24', exchange: 'NYSEArca', ter: 0.084, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FUTY' },
    { ticker: 'FVAL', name: 'Fidelity Value Factor ETF', seriesId: 'S000054754', trustCik: '0000945908', category: 'Factor', accession: '0000035402-26-004222', filed: '2026-06-26', repPdDate: '2026-04-30', inception: '2016-09-15', exchange: 'NYSEArca', ter: 0.15, fundPage: 'https://digital.fidelity.com/prgw/digital/research/quote?stocks=FVAL' },
];

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, any>;

const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
// Yahoo symbol-search endpoint used to resolve holding names that the static
// name -> ticker seed (api/fidelity/held-tickers.json) does not cover yet.
const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
// SEC requires a declared User-Agent for automated access:
// https://www.sec.gov/os/accessing-edgar-data
// SEC's WAF accepts the strict "Company Name contact@domain" shape: no
// parentheses, no URLs. Override with SEC_UA when running from CI.
const SEC_UA_DEFAULT = 'daggerok ETF feed daggerok@gmail.com';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let API_ROOT = new URL('../api/fidelity/', import.meta.url);
let INDEX_FILE = new URL('index.json', API_ROOT);
let STATE_FILE = new URL('update-state.json', API_ROOT);
let MISSES_FILE = new URL('held-ticker-misses.json', API_ROOT);
let HELD_TICKERS_FILE = new URL('held-tickers.json', API_ROOT);

/** Test hook: point every read and write of the feed at another directory (a trailing slash URL). */
export function useOutputRoot(root: URL): void {
  API_ROOT = root;
  INDEX_FILE = new URL('index.json', API_ROOT);
  STATE_FILE = new URL('update-state.json', API_ROOT);
  MISSES_FILE = new URL('held-ticker-misses.json', API_ROOT);
  HELD_TICKERS_FILE = new URL('held-tickers.json', API_ROOT);
}

const HOLDINGS_PAGE_SIZE_FALLBACK = 250;
const HISTORY_PAGE_SIZE_FALLBACK = 1000;
const CONCURRENCY_FALLBACK = 2;
const REQUEST_SLEEP_FALLBACK = 1;
const MAX_RETRIES_FALLBACK = 2;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad3(value: number): string {
  return String(value).padStart(3, '0');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeTicker(raw: unknown): string {
  return String(raw ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function cleanText(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\u00ae/g, '') // ®
    .replace(/\u2122/g, '') // ™
    .replace(/&#174;|&reg;/gi, '')
    .replace(/&#8482;|&trade;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() === '—' || value.trim() === '-') return null;
  const parsed = Number(value.replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// "2026-06-30" -> "Jun 30 2026" (the display style shared with the sibling apps).
export function formatEdgarDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const [, year, month, day] = match;
  return `${MONTHS[Number(month) - 1] ?? month} ${day} ${year}`;
}

export function formatEpochDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, '0')} ${date.getUTCFullYear()}`;
}

export function epochToIsoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export function formatUsDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

export function formatAumDisplay(value: number): string {
  return `$${(value / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} M`;
}

// ---------------------------------------------------------------------------
// Updater configuration (environment variables, iShares/SPDR-style)
// ---------------------------------------------------------------------------

type Range = { min?: number; max?: number };
type ReturnPeriod = 'YTD' | '1Y' | '3Y' | '5Y' | '10Y';
const RETURN_PERIODS: readonly ReturnPeriod[] = ['YTD', '1Y', '3Y', '5Y', '10Y'];
type RangeMap = Partial<Record<ReturnPeriod, Range>>;

type UpdaterConfig = {
  concurrency: number;
  requestSleep: number;
  maxFetches: number;
  holdingsPageSize: number;
  historyPageSize: number;
  storeRawDownloads: boolean;
  maxRetries: number;
  tickers: string[];
  historyRange: string;
  secUa: string;
  skipYahoo: boolean;
  refreshCatalog: boolean;
  aumRange?: Range & { source?: string };
  terRange?: Range;
  dividendYieldRange?: Range;
  performanceRanges: RangeMap;
  totalReturnRanges: RangeMap;
};

const AUM_PRESET_BOUNDS = {
  nano: { min: 0, max: 10_000_000 },
  micro: { min: 10_000_000, max: 300_000_000 },
  small: { min: 300_000_000, max: 2_000_000_000 },
  mid: { min: 2_000_000_000, max: 10_000_000_000 },
  large: { min: 10_000_000_000, max: undefined },
} as const;
type AumPreset = keyof typeof AUM_PRESET_BOUNDS;

const AMOUNT_SUFFIXES: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

function envValue(env: Record<string, string | undefined>, name: string, aliases: string[] = []): string {
  for (const key of [`FIDELITY_${name}`, name, ...aliases]) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

function parsePositiveInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseNonNegativeInt(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseNonNegativeFloat(raw: string, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBoolean(raw: string, fallback = false): boolean {
  const text = String(raw ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

// Strict "min:max" ranges (same parser and errors as the sibling repos).
export function parseRange(raw: string, label: string): Range | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  if (!text.includes(':')) {
    throw new Error(`${label}: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const [rawMin, rawMax] = text.split(':', 2);
  const parseBound = (bound: string): number | undefined => {
    const cleaned = bound.trim().replace(/%$/, '').replace(/[$,]/g, '');
    if (cleaned === '') return undefined;
    const value = Number(cleaned);
    if (!Number.isFinite(value)) throw new Error(`${label}: "${bound.trim()}" is not a number`);
    return value;
  };
  const min = parseBound(rawMin);
  const max = parseBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`${label}: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseAumBound(bound: string): number | undefined {
  const cleaned = bound.trim().replace(/[$,]/g, '');
  if (cleaned === '') return undefined;
  const suffixMatch = /^([\d.]+)([KMBT])$/i.exec(cleaned);
  if (suffixMatch) return Number(suffixMatch[1]) * (AMOUNT_SUFFIXES[suffixMatch[2].toUpperCase()] ?? 1);
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

export function parseAumRange(raw: string): (Range & { source?: string }) | undefined {
  const text = String(raw ?? '').trim();
  if (text === '' || text === ':') return undefined;
  const lower = text.toLowerCase();
  for (const preset of Object.keys(AUM_PRESET_BOUNDS) as AumPreset[]) {
    if (lower === preset) return { ...AUM_PRESET_BOUNDS[preset] } as Range & { source?: string };
  }
  if (!text.includes(':')) {
    throw new Error(`AUM: "${text}" must use the "min:max" range syntax (a colon is required)`);
  }
  const [rawMin, rawMax] = text.split(':', 2);
  const min = parseAumBound(rawMin);
  const max = parseAumBound(rawMax);
  if (min === undefined && max === undefined) return undefined;
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`AUM: min (${min}) must not exceed max (${max})`);
  }
  return { min, max };
}

function parseRanges(env: Record<string, string | undefined>, prefix: 'PERFORMANCE' | 'TOTAL_RETURN'): RangeMap {
  const ranges: RangeMap = {};
  for (const period of RETURN_PERIODS) {
    const parsed = parseRange(envValue(env, `${prefix}_${period}`), `${prefix}_${period}`);
    if (parsed) ranges[period] = parsed;
  }
  return ranges;
}

export function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), CONCURRENCY_FALLBACK),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), REQUEST_SLEEP_FALLBACK),
    maxFetches: parseNonNegativeInt(envValue(env, 'MAX_FETCHES', ['FIDELITY_LIMIT']), 0),
    holdingsPageSize: parsePositiveInt(envValue(env, 'HOLDINGS_PAGE_SIZE'), HOLDINGS_PAGE_SIZE_FALLBACK),
    historyPageSize: parsePositiveInt(envValue(env, 'HISTORY_PAGE_SIZE', ['HISTORICAL_PAGE_SIZE']), HISTORY_PAGE_SIZE_FALLBACK),
    storeRawDownloads: parseBoolean(envValue(env, 'STORE_RAW_DOWNLOADS', ['FIDELITY_STORE_RAW_DOWNLOADS']), false),
    maxRetries: parsePositiveInt(envValue(env, 'MAX_RETRIES'), MAX_RETRIES_FALLBACK),
    tickers: envValue(env, 'TICKERS')
      .split(/[\s,;]+/)
      .map(sanitizeTicker)
      .filter(Boolean),
    historyRange: envValue(env, 'HISTORY_RANGE') || 'max',
    secUa: envValue(env, 'SEC_UA') || SEC_UA_DEFAULT,
    skipYahoo: parseBoolean(envValue(env, 'SKIP_YAHOO'), false),
    refreshCatalog: parseBoolean(envValue(env, 'REFRESH_CATALOG'), true),
    aumRange: parseAumRange(envValue(env, 'AUM')),
    terRange: parseRange(envValue(env, 'TER'), 'TER'),
    dividendYieldRange: parseRange(envValue(env, 'DIVIDEND_YIELD'), 'DIVIDEND_YIELD'),
    performanceRanges: parseRanges(env, 'PERFORMANCE'),
    totalReturnRanges: parseRanges(env, 'TOTAL_RETURN'),
  };
}

function rangeLabel(range?: Range): string {
  if (!range) return 'any';
  const min = range.min === undefined ? '' : String(range.min);
  const max = range.max === undefined ? '' : String(range.max);
  return `${min}:${max}`;
}

function configLines(config: UpdaterConfig): string[] {
  return [
    `CONCURRENCY         ${config.concurrency}`,
    `REQUEST_SLEEP       ${config.requestSleep} s between outgoing request starts`,
    `MAX_FETCHES         ${config.maxFetches === 0 ? 'all eligible funds' : `${config.maxFetches} per run (resumes after the saved cursor)`}`,
    `HOLDINGS_PAGE_SIZE  ${config.holdingsPageSize}`,
    `HISTORY_PAGE_SIZE   ${config.historyPageSize}`,
    `STORE_RAW_DOWNLOADS ${config.storeRawDownloads ? 'on' : 'off'}`,
    `MAX_RETRIES         ${config.maxRetries}`,
    `TICKERS             ${config.tickers.length ? config.tickers.join(' ') : 'all Fidelity ETFs in the seed'}`,
    `HISTORY_RANGE       ${config.historyRange} (Yahoo chart range)`,
    `AUM                 ${rangeLabel(config.aumRange)}`,
    `TER                 ${rangeLabel(config.terRange)}`,
    `DIVIDEND_YIELD      ${rangeLabel(config.dividendYieldRange)}`,
    `PERFORMANCE_*       ${RETURN_PERIODS.filter((p) => config.performanceRanges[p]).map((p) => `${p}=${rangeLabel(config.performanceRanges[p])}`).join(' ') || 'any'}`,
    `TOTAL_RETURN_*      ${RETURN_PERIODS.filter((p) => config.totalReturnRanges[p]).map((p) => `${p}=${rangeLabel(config.totalReturnRanges[p])}`).join(' ') || 'any'}`,
    `SEC_UA              ${config.secUa}`,
    `SKIP_YAHOO          ${config.skipYahoo}`,
    `REFRESH_CATALOG     ${config.refreshCatalog}`,
  ];
}

export const USAGE = `
Fidelity ETF static data updater (Bun, no dependencies).

  bun ./scripts/update-data.ts            update ./api/fidelity from SEC EDGAR + Yahoo
  ./scripts/update-data.ts --backfill-tickers
                                          offline: stamp real exchange tickers from
                                          api/fidelity/held-tickers.json into already
                                          generated holdings data (no network)
  ./scripts/update-data.ts -h | --help    print this help

Controls resolve as: scripts/update-data.config.json defaults < environment
(the GitHub Actions workflow also layers an "advanced" JSON object and nonblank
inputs between them). Every control below is a key of the config file; an
explicitly set environment variable (optionally prefixed FIDELITY_) wins even
when empty, which clears the control. Strict
"min:max" ranges; AND logic.

  MAX_FETCHES          Batch size: continue after the ticker cursor saved in
                       api/fidelity/update-state.json. Empty or 0 means all.
                       Legacy alias: FIDELITY_LIMIT.
  REQUEST_SLEEP        Minimum seconds between outgoing request starts,
                       including retries (default 1). SEC allows at most 10
                       requests per second; Yahoo throttles hard, keep >= 1.
  CONCURRENCY          Parallel fund workers (default 2). Starts are still
                       globally spaced by REQUEST_SLEEP.
  MAX_RETRIES          Retries after the initial request (integer >= 1, default 2). Only
                       network errors and HTTP 403/408/425/429/5xx responses
                       are retried with bounded exponential backoff.
  TICKERS              Space-, comma- or semicolon-separated ticker allowlist,
                       for example "FDIS FTEC FBTC".
  AUM                  Net assets range in USD: "min:max". Bounds accept plain
                       amounts or K/M/B/T suffixes; a whole-value preset may be
                       one of nano, micro, small, mid, large.
  TER                  Expense ratio range in percent, for example "0.1:0.5".
  DIVIDEND_YIELD       Indicated dividend yield range in percent.
  PERFORMANCE_YTD      Market-price return ranges (also 1Y, 3Y, 5Y, 10Y).
  TOTAL_RETURN_YTD     Cumulative return ranges (also 1Y, 3Y, 5Y, 10Y).
  HOLDINGS_PAGE_SIZE   Rows per generated holdings JSON page (default 250).
  HISTORY_PAGE_SIZE    Rows per generated NAV-history JSON page (default 1000).
                       Legacy alias: HISTORICAL_PAGE_SIZE.
  STORE_RAW_DOWNLOADS  Store the source N-PORT XML under api/fidelity/raw
                       (1/true/yes/on). Legacy alias: FIDELITY_STORE_RAW_DOWNLOADS.
  HISTORY_RANGE        Yahoo chart range for history rows (default "max").
  SEC_UA               Override the declared SEC User-Agent (SEC policy
                       requires a declared contact for automated access).
  SKIP_YAHOO           1/true to update EDGAR holdings only.
  REFRESH_CATALOG      0/false to skip the EDGAR lookup of each series' newest
                       N-PORT-P filing: holdings and net assets stay as published
                       (default on).
  VERBOSE              1/true to print per-fund retry and fallback notices.
  USE_SYSTEM_CA        auto (default) restarts once with Bun's --use-system-ca when a
                       request fails with an untrusted-certificate error; true always
                       uses the system CA store; false never restarts.

Holding tickers: N-PORT positions publish no exchange tickers, so the
updater fills the holdings Ticker column for U.S. equities traded in USD only
(shared nport-reader rule): SEC EDGAR company_tickers.json names first, then
the name -> ticker seed in api/fidelity/held-tickers.json, then the Yahoo
Finance symbol search with a strict name match; new mappings are written back
to api/fidelity/held-tickers.json (commit it with the data update). Bonds,
loans, funds, derivatives and non-U.S. listings keep "-", and a ticker that
would land on two different securities is dropped.

AUM and return filters are evaluated against fresh Yahoo data and the
previously published catalog values before the heavier N-PORT downloads.
Funds that are filtered out (or that fail) keep their previously published
files, exactly like the sibling updaters.

Examples:

  MAX_FETCHES=10 ./scripts/update-data.ts
  TICKERS="FDIS FTEC" ./scripts/update-data.ts
  AUM="1B:" TER=":0.5" ./scripts/update-data.ts
  PERFORMANCE_1Y="15:" ./scripts/update-data.ts
  STORE_RAW_DOWNLOADS=1 ./scripts/update-data.ts
`;

// ---------------------------------------------------------------------------
// Fetch layer with global pacing and bounded retries (SPDR-style)
// ---------------------------------------------------------------------------

// One pacing lane per concurrent worker (sized from config.concurrency in
// main()). A single shared gate capped total throughput at one request per
// REQUEST_SLEEP no matter how high CONCURRENCY was set; CONCURRENCY workers
// now each get their own paced lane, so concurrency actually multiplies
// throughput as documented instead of only overlapping wait time.
let nextRequestAtLanes: number[] = [0];
let softDeadlineMs = 25 * 60_000; // the workflow times out at 30 min: stop taking new funds well before, and still write the index

/** Test hook: shorten (or exhaust) the soft run deadline. */
export function setSoftDeadline(ms: number): void {
  softDeadlineMs = ms;
}
let requestSleepMs = REQUEST_SLEEP_FALLBACK * 1000;

/** Sizes the per-worker pacing lanes (one lane per CONCURRENCY worker, REQUEST_SLEEP apart). */
export function configureRequestLanes(lanes: number, sleepSeconds: number): void {
  requestSleepMs = Math.max(0, sleepSeconds) * 1000;
  nextRequestAtLanes = new Array(Math.max(1, lanes)).fill(0);
}

/** Reserves the earliest lane slot synchronously, then waits for it: concurrent callers can never share a slot. */
export async function paceRequests(): Promise<void> {
  const now = Date.now();
  let lane = 0;
  for (let i = 1; i < nextRequestAtLanes.length; i++) if (nextRequestAtLanes[i] < nextRequestAtLanes[lane]) lane = i;
  const waitFor = nextRequestAtLanes[lane] - now;
  nextRequestAtLanes[lane] = Math.max(now, nextRequestAtLanes[lane]) + requestSleepMs;
  if (waitFor > 0) await sleep(waitFor);
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Per-attempt time budget for headers and body together. */
export const FETCH_TIMEOUT_MS = 45_000;

async function fetchAttempts<T>(
  url: string,
  label: string,
  init: RequestInit,
  maxRetries: number,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceRequests();
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), ...init });
      if (response.ok) return await consume(response);
      const retryable = [403, 408, 425, 429].includes(response.status) || response.status >= 500;
      if (!retryable) throw new HttpError(`${label}: HTTP ${response.status} ${response.statusText}`, response.status, false);
      lastError = new HttpError(`${label}: HTTP ${response.status} (attempt ${attempt + 1} of ${maxRetries + 1})`, response.status, true);
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      lastError = error instanceof HttpError ? error : new Error(`${label}: network error (${String(error)})`);
    }
    if (attempt < maxRetries) await sleep(Math.min(30_000, 1_000 * 2 ** attempt) + 250);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label}: failed`);
}

export function fetchWithRetry(
  url: string,
  label: string,
  init: RequestInit = {},
  maxRetries = 2,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetchAttempts(url, label, init, maxRetries, timeoutMs, async (response) => response);
}

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,*/*' };
}

function yahooHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json' };
}

async function fetchText(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<string> {
  // The body is read inside the retry loop, so a stalled download is aborted and retried too.
  return fetchAttempts(url, label, { headers }, config.maxRetries, FETCH_TIMEOUT_MS, (response) => response.text());
}

async function fetchJson(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<JsonRecord> {
  const text = await fetchText(url, label, headers, config);
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`${label}: response is not valid JSON`);
  }
}

// ---------------------------------------------------------------------------
// Holding ticker resolution
//
// N-PORT positions publish no exchange tickers — only the issuer name and a
// CUSIP/ISIN. The holdings feed still needs real tickers (the Watchlist
// "Copy Tickers" action, exports, deduplication), so the updater resolves
// them from the name -> ticker seed in api/fidelity/held-tickers.json and, for names
// the seed does not cover yet (new IPOs, foreign listings), from the Yahoo
// Finance symbol search with a STRICT name match so a fuzzy hit can never
// pin the wrong security. Positions that genuinely have no exchange ticker
// (bonds, private CLO/ABS debt, SPVs) stay "-"; the app then falls back to
// the CUSIP/ISIN Identifier, the same convention as SPDR bond rows.
// ---------------------------------------------------------------------------

// Same normalization the seed was generated with: upper-case, strip
// punctuation and legal-form suffixes (INC, CORP, LTD, HOLDINGS, COMMON
// STOCK, ...), leading/trailing fillers (THE, OF, AND, DE, ...). "3M Co" ->
// "3M", "DigitalOcean Holdings, Inc." and "DIGITAL OCEAN HOLDINGS INC" ->
// "DIGITAL OCEAN".
const HOLDING_NAME_SUFFIXES = new Set([
  'STOCK', 'COMMON', 'PREFERRED', 'PFD', 'SHARES', 'ORDINARY', 'DEPOSITARY', 'ADS', 'ADR',
  'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'CO', 'COMPANY', 'LTD', 'LIMITED', 'PLC',
  'PUBLIC', 'SA', 'SAS', 'SARL', 'SRL', 'SL', 'KG', 'AG', 'BA', 'BV', 'NV', 'OY', 'SE',
  'AS', 'AB', 'AD', 'K K', 'KABUSHIKI', 'KAISHA', 'PTY', 'PT', 'SFC', 'ANONIMA', 'GMBH',
  'HOLDINGS', 'HLDGS', 'DEL', 'NEW', 'DELISTED', 'REPR', 'GROUP',
]);
const HOLDING_NAME_PHRASES = new Set([
  'COMMON STOCK', 'PREFERRED STOCK', 'DEPOSITARY SHARES', 'AMERICAN DEPOSITARY SHARES',
  'ORDINARY SHARES', 'LIABILITY CO', 'CLASS A', 'CLASS B', 'CLASS C', 'CLASS D',
  'S A', 'N V', 'B V', 'PRIVATE LTD', 'PUBLIC LTD',
]);
const HOLDING_NAME_FILLERS = new Set([
  'THE', 'OF', 'AND', 'FOR', 'DE', 'LA', 'LE', 'VAN', 'VON', 'DER', 'DEN', 'DI', 'Y',
  'E', 'DU', 'DA', 'LOS', 'LAS', 'EL', 'AL', 'DEL',
]);

export function normalizeHoldingName(raw: unknown): string {
  let text = String(raw ?? '').toUpperCase().replace(/&/g, ' AND ');
  text = text.replace(/[^A-Z0-9]+/g, ' ');
  let tokens = text.split(' ').filter(Boolean);
  let changed = true;
  while (changed && tokens.length) {
    changed = false;
    if (tokens.length >= 2 && HOLDING_NAME_PHRASES.has(`${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`)) {
      tokens = tokens.slice(0, -2);
      changed = true;
      continue;
    }
    if (HOLDING_NAME_SUFFIXES.has(tokens[tokens.length - 1])) {
      tokens.pop();
      changed = true;
      continue;
    }
    while (tokens.length && HOLDING_NAME_FILLERS.has(tokens[tokens.length - 1])) {
      tokens.pop();
      changed = true;
    }
  }
  while (tokens.length && HOLDING_NAME_FILLERS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

export function normalizeHoldingNameCore(raw: unknown): string {
  return normalizeHoldingName(raw).replace(/ /g, '');
}

// Holding tickers keep their class-share markers (SCE^L, BF/A, BRK-B): they
// are the real exchange symbols, unlike fund tickers which sanitizeTicker
// upper-cases and strips everything but letters/digits.
export function cleanHoldingTicker(raw: unknown): string {
  const symbol = String(raw ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.^/-]*$/.test(symbol) ? symbol : '';
}

export function yahooSearchUrl(name: string): string {
  return `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(name)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false`;
}

// Strict matcher for Yahoo search payloads: the quote's long name must
// normalize to the same name (or token-core) as the filed holding name. Only
// EQUITY/ETF quotes are accepted, and single/two-word holdings may additionally
// match by token containment (e.g. "BULLISH" -> "Bullish BLCM Inc").
export function pickSearchTicker(name: string, payload: JsonRecord): string | null {
  const matches: unknown[] = Array.isArray(payload?.quoteMatches) ? payload.quoteMatches : [];
  const norm = normalizeHoldingName(name);
  if (!norm) return null;
  const core = norm.replace(/ /g, '');
  const tokens = norm.split(' ');
  for (const match of matches) {
    if (!match || typeof match !== 'object') continue;
    const record = match as JsonRecord;
    const quoteType = String(record.quoteType || '').toUpperCase();
    if (quoteType !== 'EQUITY' && quoteType !== 'ETF') continue;
    const symbol = cleanHoldingTicker(record.symbol);
    if (!symbol) continue;
    const longName = String(record.longname || record.shortname || '');
    const candidate = normalizeHoldingName(longName);
    if (!candidate) continue;
    if (candidate === norm || candidate.replace(/ /g, '') === core) return symbol;
    if (tokens.length <= 2 && tokens.every((token) => candidate.includes(token))) return symbol;
  }
  return null;
}

export type TickerSearchFn = (name: string) => Promise<string | null>;

/** A search miss is not repeated before this many days (state file api/fidelity/held-ticker-misses.json). */
export const MISS_TTL_DAYS = 30;
/** Misses nobody refreshed for this long (the holding left every fund) are dropped from the state file. */
export const MISS_RETENTION_DAYS = 90;

// N-PORT asset categories that cannot have an exchange ticker of their own:
// debt, every ABS flavour, loans, short-term investment vehicles, repos, real
// estate and the derivative classes. Only equity (EC), preferred (EP) and
// unknown codes go to the name search. The seed lookup still runs for every
// row, so issuer names already mapped (bond rows of a listed issuer) keep their ticker.
const NO_TICKER_CATEGORIES = new Set(['DBT', 'LON', 'STIV', 'RA', 'RE', 'DCO', 'DCR', 'DE', 'DFE', 'DIR', 'DO', 'SN']);

export function canHaveListedTicker(assetCategory: unknown): boolean {
  const code = String(assetCategory ?? '').trim().toUpperCase();
  return !(NO_TICKER_CATEGORIES.has(code) || code.startsWith('ABS-'));
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS;
}

// Memoized name -> ticker lookup over the seed plus live Yahoo searches.
// Unknown names are searched at most once per run (hits are learned into the
// index, misses are cached) and can never throw: resolution degrades to "-".
// Genuine misses (a valid answer without a strict match) are also remembered
// across runs in `misses` (normalized name -> last tried date) for MISS_TTL_DAYS;
// failed requests (offline, throttled) are never persisted as misses.
export class TickerResolver {
  private readonly byName = new Map<string, string>();
  private readonly byNorm = new Map<string, string>();
  private readonly byNormCore = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly missed = new Map<string, true>();
  private readonly misses = new Map<string, string>();
  readonly fresh: Array<{ name: string; ticker: string }> = [];
  readonly stats = { searches: 0, skippedCategory: 0, skippedKnownMiss: 0 };
  private readonly search: TickerSearchFn | null;
  private readonly today: string;

  constructor(seed: Record<string, string>, search: TickerSearchFn | null = null, persistedMisses: Record<string, string> = {}, today: string = isoDay(Date.now())) {
    this.search = search;
    this.today = today;
    for (const [name, ticker] of Object.entries(seed)) this.learn(name, ticker, false);
    for (const [norm, date] of Object.entries(persistedMisses)) if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) this.misses.set(norm, String(date));
  }

  get size(): number {
    return this.byName.size;
  }

  private indexName(name: string, symbol: string): void {
    const norm = normalizeHoldingName(name);
    if (!norm) return;
    const core = norm.replace(/ /g, '');
    const put = (map: Map<string, string>, key: string): void => {
      const existing = map.get(key);
      if (existing === undefined) map.set(key, symbol);
      else if (existing !== symbol) map.delete(key); // two tickers share the key: ambiguous
    };
    put(this.byNorm, norm);
    if (core) put(this.byNormCore, core);
  }

  // Records a name -> ticker mapping (seed entries and learned hits).
  private learn(name: string, rawTicker: string, isFresh: boolean): void {
    const symbol = cleanHoldingTicker(rawTicker);
    if (!name || !symbol) return;
    this.byName.set(name, symbol);
    this.indexName(name, symbol);
    if (isFresh) this.fresh.push({ name, ticker: symbol });
  }

  lookup(name: string): string | null {
    const exact = this.byName.get(name);
    if (exact) return exact;
    const norm = normalizeHoldingName(name);
    if (!norm) return null;
    return this.byNorm.get(norm) ?? this.byNormCore.get(norm.replace(/ /g, '')) ?? null;
  }

  private missIsFresh(norm: string): boolean {
    const date = this.misses.get(norm);
    return date !== undefined && daysBetween(date, this.today) < MISS_TTL_DAYS;
  }

  async resolve(name: string, assetCategory?: unknown): Promise<string> {
    const known = this.lookup(name);
    if (known) return known;
    const norm = normalizeHoldingName(name);
    if (!norm || !this.search || this.missed.has(norm)) return '-';
    if (!canHaveListedTicker(assetCategory)) {
      this.stats.skippedCategory += 1;
      return '-';
    }
    if (this.missIsFresh(norm)) {
      this.stats.skippedKnownMiss += 1;
      return '-';
    }
    const search = this.search; // narrowed to non-null; closures cannot see `this` narrowing
    const inflight = this.inFlight.get(norm) ?? (async () => {
      let symbol: string | null = null;
      let failed = false;
      this.stats.searches += 1;
      try {
        symbol = await search(name);
      } catch {
        symbol = null; // offline/throttled: keep "-" instead of failing the fund
        failed = true;
      }
      if (symbol) {
        this.learn(name, symbol, true);
        this.misses.delete(norm); // a hit overrides an older miss
      } else {
        this.missed.set(norm, true);
        if (!failed) this.misses.set(norm, this.today);
      }
      this.inFlight.delete(norm);
      return symbol;
    })();
    this.inFlight.set(norm, inflight);
    const symbol = await inflight;
    return symbol ?? '-';
  }

  freshEntries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { name, ticker } of this.fresh) out[name] = ticker;
    return out;
  }

  /** Misses to persist: still-retained entries, minus names that are mapped by now. */
  missEntries(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [norm, date] of this.misses) {
      if (daysBetween(date, this.today) >= MISS_RETENTION_DAYS) continue;
      if (this.lookup(norm)) continue;
      out[norm] = date;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Seed file persistence (api/fidelity/held-tickers.json grows with live resolutions)
// ---------------------------------------------------------------------------

/** Sorted, one entry per line: normalized holding name -> last tried date. */
export function formatMisses(entries: Record<string, string>): string {
  const keys = Object.keys(entries).filter(Boolean).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!keys.length) return '{}\n';
  return `{\n${keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(entries[key])}`).join(',\n')}\n}\n`;
}

async function readMisses(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(MISSES_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {}; // missing or unreadable: every name is simply searched again
  }
}

/**
 * N-PORT holding name -> exchange ticker, one entry per line, sorted (names exactly as filed, case preserved).
 * Seeded 2026-08-26 from SEC EDGAR company_tickers.json and the Nasdaq Trader / NYSE / NYSE American symbol
 * directories, then extended live through the Yahoo Finance symbol search (strict name match only) and committed
 * with the generated feed. Positions without an exchange ticker (bonds, private debt) are intentionally absent:
 * their rows keep Ticker "-" and the app falls back to CUSIP/ISIN.
 */
export function formatHeldTickers(entries: Record<string, string>): string {
  const rows = Object.entries(entries)
    .map(([name, ticker]) => [name, cleanHoldingTicker(ticker)] as const)
    .filter(([name, ticker]) => name && ticker)
    .sort((a, b) => {
      const ka = a[0].toLowerCase();
      const kb = b[0].toLowerCase();
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  if (!rows.length) return '{}\n';
  return `{\n${rows.map(([name, ticker]) => `  ${JSON.stringify(name)}: ${JSON.stringify(ticker)}`).join(',\n')}\n}\n`;
}

async function readHeldTickers(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(HELD_TICKERS_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {}; // missing or unreadable: names are only resolved live
  }
}

async function writeTextIfChanged(file: URL, value: string, skipFirstEmpty = false): Promise<boolean> {
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === value || (skipFirstEmpty && previous === null && value === '{}\n')) return false;
  await writeAtomic(file, value);
  return true;
}

/** Writes through a temp file and a rename, so a killed run never leaves a half-written JSON file behind. */
async function writeAtomic(file: URL, text: string): Promise<void> {
  const tmp = new URL(`${file.href}.tmp`);
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------
// SEC EDGAR layer: the shared nport-reader block at the end of this file finds, reads and checks each fund's filing
// ---------------------------------------------------------------------------

const SEC_FUND_TICKERS_URL = 'https://www.sec.gov/files/company_tickers_mf.json';
const SEC_COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const HOLDINGS_HEADERS = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
/** Funds whose holdings legitimately fail a holdingsGuard check (geared, futures, look-through, top-N lists): ticker, or '*' for every fund -> relaxed checks. */
export const HOLDINGS_GUARD_RELAX: Record<string, string[]> = {};
/** Funds the issuer closed, each confirmed from an SEC filing or the issuer notice (`source`): never fetched or guarded, last published data kept, index row marked closed. */
export const CLOSED_FUNDS: ClosedFund[] = [];

/** One run's SEC state: the two SEC ticker tables (each loaded once) and the N-PORT reader cache (submissions and documents). */
let secState: { funds: Promise<Map<string, NportSeriesRef>> | null; names: Promise<Map<string, string>> | null; reader: Map<string, unknown> } = { funds: null, names: null, reader: new Map() };

/** A fresh SEC state for a run (main and tests). */
export function resetSecState(): void {
  secState = { funds: null, names: null, reader: new Map() };
}

/** SEC's fund ticker -> registrant CIK + series id table, loaded once per run (a failed load is asked again by the next fund). */
function loadFundTickerTable(config: UpdaterConfig): Promise<Map<string, NportSeriesRef>> {
  if (!secState.funds) {
    const loading = fetchJson(SEC_FUND_TICKERS_URL, '[edgar   ] fund ticker table', secHeaders(config), config).then((payload) => parseSecFundTickers(payload));
    secState.funds = loading;
    loading.catch(() => { if (secState.funds === loading) secState.funds = null; });
  }
  return secState.funds;
}

/** SEC's company name -> ticker table for the N-PORT rows, loaded once per run; Yahoo search hits of the run are added to it. */
function loadCompanyNames(config: UpdaterConfig): Promise<Map<string, string>> {
  if (!secState.names) {
    const loading = fetchJson(SEC_COMPANY_TICKERS_URL, '[edgar   ] company ticker table', secHeaders(config), config).then((payload) => parseSecCompanyNames(payload));
    secState.names = loading;
    loading.catch(() => { if (secState.names === loading) secState.names = null; });
  }
  return secState.names;
}

/**
 * The registrant CIK and series id the N-PORT reader looks for: SEC company_tickers_mf.json first, the seed where the table
 * has no row for the ticker or could not be read. A seed that disagrees with the SEC table is reported; the SEC table wins.
 */
async function nportSeriesOf(seed: SeedFund, config: UpdaterConfig): Promise<{ cik: string; seriesId: string | null }> {
  let ref: NportSeriesRef | undefined;
  try {
    ref = (await loadFundTickerTable(config)).get(seed.ticker);
  } catch (error) {
    outputNote(`[ ${'edgar'.padEnd(9)}] fund ticker table: ${error instanceof Error ? error.message : String(error)} — using the seed series`);
  }
  if (ref && seed.seriesId && ref.seriesId !== seed.seriesId) console.warn(`[ ${'nport'.padEnd(9)}] ${seed.ticker}: SEC lists series ${ref.seriesId}, the seed ${seed.seriesId}; reading ${ref.seriesId}`);
  return ref ? { cik: ref.cik, seriesId: ref.seriesId } : { cik: seed.trustCik, seriesId: seed.seriesId };
}

/**
 * Exchange tickers of a filing's positions ('' for none) by the shared rule (`nportTickers`: only U.S. equities traded in USD,
 * never one ticker on two securities). A name the SEC company table does not know (Alphabet CL A and CL C share one SEC title, so
 * the duplicate check drops both) is looked up in api/fidelity/held-tickers.json and then through the Yahoo symbol search
 * (TickerResolver), but only for a row the shared rule would give a name-matched ticker; a hit joins the run's name table,
 * so the duplicate check sees it. Bonds, cash, funds, derivatives and non-U.S.
 * listings are never searched and keep "-".
 */
export async function nportHoldingTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string>, resolver: TickerResolver): Promise<string[]> {
  const first = nportTickers(positions, names);
  for (let i = 0; i < positions.length; i++) {
    const key = nportNameKey(positions[i].name);
    if (first[i] || !key || names.has(key)) continue;
    // Would the shared rule take a ticker for this name (a U.S. equity in USD with a CUSIP or U.S. ISIN)? Ask it with a probe table.
    if (nportTickers([positions[i]], new Map([[key, '?']]))[0] !== '?') continue;
    const symbol = await resolver.resolve(positions[i].name, positions[i].assetCat);
    if (symbol !== '-') names.set(key, symbol);
  }
  return nportTickers(positions, names);
}

/**
 * The Fidelity holdings sheet (HOLDINGS_HEADERS) of an N-PORT filing: the position's own identifier (CUSIP, else ISIN, else
 * the "other" code), a missing number empty (never 0), a missing text '-'; tickers from nportHoldingTickers.
 */
export function nportHoldingsSheet(filing: NportFiling, tickers: ReadonlyArray<string>): JsonRecord[] {
  return filing.positions.map((position, index) => ({
    Name: position.name || '-',
    Ticker: tickers[index] || '-',
    Identifier: nportIdentifier(position) || '-',
    Weight: nportCell(position.weight, 10),
    'Market Value': nportCell(position.value, 2),
    'Shares Held': nportCell(position.balance, 6),
    'Asset Category': position.assetCat || '-',
  }));
}

// ---------------------------------------------------------------------------
// Yahoo chart layer: daily history, distributions, quote meta
// ---------------------------------------------------------------------------

// adjCloseRaw: Yahoo's unrounded value, only used to tell float noise from a real change (never persisted).
export type ChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type ParsedChart = {
  exchangeName: string;
  longName: string;
  navPrice: number | null;
  regularMarketPrice: number | null;
  regularMarketTime: number | null;
  firstTradeDate: number | null;
  days: ChartDay[];
  dividends: Array<{ epoch: number; amount: number }>;
};

export function parseChart(payload: JsonRecord): ParsedChart {
  const result = (payload?.chart?.result || [])[0] as JsonRecord | undefined;
  if (!result) throw new Error('chart: empty result');
  const meta = (result.meta || {}) as JsonRecord;
  const timestamps: number[] = result.timestamp || [];
  const quote = ((result.indicators || {}).quote || [])[0] as JsonRecord | undefined;
  const adj = ((result.indicators || {}).adjclose || [])[0] as JsonRecord | undefined;
  const closes: unknown[] = (quote && quote.close) || [];
  const volumes: unknown[] = (quote && quote.volume) || [];
  const adjCloses: unknown[] = (adj && adj.adjclose) || closes;
  const days: ChartDay[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (typeof close !== 'number' || !Number.isFinite(close)) continue;
    const adjClose = typeof adjCloses[i] === 'number' && Number.isFinite(adjCloses[i] as number) ? (adjCloses[i] as number) : close;
    days.push({
      date: epochToIsoDate(timestamps[i]),
      close: round(close, 6),
      // Yahoo recomputes the split/dividend-adjusted close on every request;
      // at 6 decimals the last digit or two jitters between otherwise
      // identical requests, making every history row (and the fund) look
      // "updated" on every single run. 2 decimals is well past any
      // meaningful precision for a price and absorbs that jitter.
      adjClose: round(adjClose, 2),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
      adjCloseRaw: adjClose,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || ''), // never the shortName: it is often cut ("Fidelity Real Estate Investment")
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

export function chartUrl(ticker: string, config: Pick<UpdaterConfig, 'historyRange'>, nowMs = Date.now()): string {
  // Explicit period1/period2: `range=max` silently downgrades to monthly bars.
  const period2 = Math.floor(nowMs / 1000);
  let period1 = 0; // "max"
  const yearsMatch = /^(\d+)y$/i.exec(config.historyRange);
  if (yearsMatch) period1 = Math.floor(period2 - Number(yearsMatch[1]) * 365.25 * 86_400);
  return `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d&events=div%7Csplit`;
}

// ---------------------------------------------------------------------------
// Derived catalog metrics (unit-tested helpers, SPDR parity + price returns)
// ---------------------------------------------------------------------------

// (1 + CAGR)^n - 1 — the exact inverse of annualizing (same helper as SPDR).
export function annualizedToTotal(annualizedPercent: number | null | undefined, years: number): number | null {
  if (typeof annualizedPercent !== 'number' || !Number.isFinite(annualizedPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + annualizedPercent / 100) ** years - 1) * 100, 2);
}

export function totalToAnnualized(totalPercent: number | null | undefined, years: number): number | null {
  if (typeof totalPercent !== 'number' || !Number.isFinite(totalPercent)) return null;
  if (years <= 0) return null;
  return round(((1 + totalPercent / 100) ** (1 / years) - 1) * 100, 2);
}

// Indicated yield: latest distribution x payments per year / price (SPDR helper).
export function indicatedYield(
  latestDistribution: number | null | undefined,
  paymentsPerYear: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (typeof latestDistribution !== 'number' || typeof paymentsPerYear !== 'number' || typeof price !== 'number') return null;
  if (!Number.isFinite(latestDistribution) || !Number.isFinite(paymentsPerYear) || !Number.isFinite(price) || price <= 0) return null;
  if (paymentsPerYear <= 0 || latestDistribution <= 0) return null;
  return round(((latestDistribution * paymentsPerYear) / price) * 100, 2);
}

export function inferDistributionFrequency(
  dividends: Array<{ epoch: number; amount: number }>,
): { frequency: string; paymentsPerYear: number | null } {
  if (!dividends.length) return { frequency: 'None', paymentsPerYear: null };
  const recent = dividends.slice(-9);
  if (recent.length < 2) return { frequency: 'Unknown', paymentsPerYear: null };
  const gapsDays: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = (recent[i].epoch - recent[i - 1].epoch) / 86_400;
    if (gap > 14 && gap < 400) gapsDays.push(gap);
  }
  if (!gapsDays.length) return { frequency: 'Unknown', paymentsPerYear: null };
  gapsDays.sort((a, b) => a - b);
  const medianGap = gapsDays[Math.floor(gapsDays.length / 2)];
  if (medianGap >= 300) return { frequency: 'Annually', paymentsPerYear: 1 };
  if (medianGap >= 150) return { frequency: 'Semiannually', paymentsPerYear: 2 };
  if (medianGap >= 75) return { frequency: 'Quarterly', paymentsPerYear: 4 };
  if (medianGap >= 25) return { frequency: 'Monthly', paymentsPerYear: 12 };
  return { frequency: 'Irregular', paymentsPerYear: null };
}

export type PriceReturns = {
  asOfDate: string;
  ytd: number | null;
  yr1: number | null;
  cagr3y: number | null;
  cagr5y: number | null;
  cagr10y: number | null;
  siAnn: number | null;
  mo1: number | null;
  qtd: number | null;
};

function pctChange(start: number, end: number): number {
  return round(((end - start) / start) * 100, 2);
}

function annualized(start: number, end: number, years: number): number | null {
  if (start <= 0 || years <= 0) return null;
  return round(((end / start) ** (1 / years) - 1) * 100, 2);
}

// Market-price total returns (adjusted close) anchored to the last trading day
// at or before `now`. Quarter-end anchors come from the same helper with an
// earlier `now`, exactly like the sibling's month-end / quarter-end series.
export function priceReturns(days: ChartDay[], now = new Date()): PriceReturns {
  const empty: PriceReturns = {
    asOfDate: '', ytd: null, yr1: null, cagr3y: null, cagr5y: null, cagr10y: null, siAnn: null, mo1: null, qtd: null,
  };
  if (!days.length) return empty;
  const last = days[days.length - 1];
  const lastEpoch = Date.parse(`${last.date}T00:00:00Z`) / 1000;
  const atOrBefore = (iso: string): ChartDay | null => {
    const target = Date.parse(`${iso}T00:00:00Z`) / 1000;
    if (Number.isNaN(target)) return null;
    let found: ChartDay | null = null;
    for (const day of days) {
      if (Date.parse(`${day.date}T00:00:00Z`) / 1000 <= target) found = day;
      else break;
    }
    return found;
  };
  const yearsAgo = (years: number): ChartDay | null => {
    const date = new Date(now.getTime());
    date.setUTCFullYear(date.getUTCFullYear() - years);
    return atOrBefore(date.toISOString().slice(0, 10));
  };
  const ytdStart = atOrBefore(`${now.getUTCFullYear()}-01-01`);
  const mo1Start = new Date(now.getTime() - 31 * 86_400_000).toISOString().slice(0, 10);
  const quarterStart = `${now.getUTCFullYear()}-${String(Math.floor(now.getUTCMonth() / 3) * 3 + 1).padStart(2, '0')}-01`;
  const year1 = yearsAgo(1);
  const year3 = yearsAgo(3);
  const year5 = yearsAgo(5);
  const year10 = yearsAgo(10);
  const first = days[0];
  const siYears = (lastEpoch - Date.parse(`${first.date}T00:00:00Z`) / 1000) / (365.25 * 86_400);
  const mo1StartDay = atOrBefore(mo1Start);
  const qtdStartDay = atOrBefore(quarterStart);
  return {
    asOfDate: last.date,
    ytd: ytdStart && ytdStart.date < last.date && ytdStart.adjClose > 0 ? pctChange(ytdStart.adjClose, last.adjClose) : null,
    yr1: year1 && year1.date < last.date ? pctChange(year1.adjClose, last.adjClose) : null,
    cagr3y: year3 && year3.date < last.date ? annualized(year3.adjClose, last.adjClose, 3) : null,
    cagr5y: year5 && year5.date < last.date ? annualized(year5.adjClose, last.adjClose, 5) : null,
    cagr10y: year10 && year10.date < last.date ? annualized(year10.adjClose, last.adjClose, 10) : null,
    // Annualized only from one full year on: a younger figure is cumulative and would sort and filter as an annual rate.
    siAnn: siYears >= 1 ? annualized(first.adjClose, last.adjClose, siYears) : null,
    mo1: mo1StartDay && mo1StartDay.date < last.date ? pctChange(mo1StartDay.adjClose, last.adjClose) : null,
    qtd: qtdStartDay && qtdStartDay.date < last.date ? pctChange(qtdStartDay.adjClose, last.adjClose) : null,
  };
}

export function lastCompletedQuarterEnd(now = new Date()): Date {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  if (month <= 2) return new Date(Date.UTC(year - 1, 11, 31)); // Jan-Mar -> Dec 31
  if (month <= 5) return new Date(Date.UTC(year, 2, 31)); // Apr-Jun -> Mar 31
  if (month <= 8) return new Date(Date.UTC(year, 5, 30)); // Jul-Sep -> Jun 30
  return new Date(Date.UTC(year, 8, 30)); // Oct-Dec -> Sep 30
}

export function deriveCatalogMetrics(
  returns: PriceReturns,
  latestDistribution: number | null,
  paymentsPerYear: number | null,
  price: number | null,
): JsonRecord {
  const dividendYield = indicatedYield(latestDistribution, paymentsPerYear, price);
  return {
    ytd: returns.ytd,
    tr1y: returns.yr1,
    tr3y: annualizedToTotal(returns.cagr3y, 3),
    tr5y: annualizedToTotal(returns.cagr5y, 5),
    tr10y: annualizedToTotal(returns.cagr10y, 10),
    cagr3y: returns.cagr3y,
    cagr5y: returns.cagr5y,
    cagr10y: returns.cagr10y,
    siAnn: returns.siAnn,
    dividendYield,
    dividendYieldText: dividendYield === null ? '—' : `${dividendYield.toFixed(2)}%`,
    dividendYieldBasis: dividendYieldBasisFor(dividendYield),
    secYield: null, // Fidelity publishes no 30-day SEC yield feed; shown as "—"
    secYieldText: '—',
    returnsBasis: RETURNS_BASIS,
    performanceAsOf: isoDateOrNull(returns.asOfDate),
  };
}

/**
 * Code of the definition behind dividendYield: Fidelity publishes no yield, so the
 * only source is the updater estimate (latest distribution x payments per year / price).
 * null exactly when the yield is null.
 */
export type DividendYieldSource = 'indicated';
export type DividendYieldBasis = 'official-trailing-12m' | 'official-distribution-rate' | 'official-other' | 'computed-trailing-12m' | 'indicated';
export const DIVIDEND_YIELD_BASES: readonly DividendYieldBasis[] = ['official-trailing-12m', 'official-distribution-rate', 'official-other', 'computed-trailing-12m', 'indicated'];

export function dividendYieldBasisFor(dividendYield: number | null, source: DividendYieldSource = 'indicated'): DividendYieldBasis | null {
  if (dividendYield === null) return null;
  switch (source) {
    case 'indicated':
      return 'indicated';
  }
}

export const RETURNS_BASIS =
  'derived from Yahoo Finance adjusted market-price closes (estimate, not official NAV returns); Fidelity publishes no machine-readable performance table';

/** ISO YYYY-MM-DD or null (never an empty string). */
export function isoDateOrNull(value: unknown): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return match ? match[0] : null;
}

/** Inverse of formatEdgarDate ("Sep 25 2026" -> "2026-09-25"); null when unparseable. Plain calendar text, never the local time zone (shared calendar-dates block). */
export function displayDateToIso(value: unknown): string | null {
  return calendarIso(value);
}

/**
 * Metrics carried over from a previous run (no fresh Yahoo chart): keep the
 * numbers, make sure the mandatory returnsBasis / performanceAsOf sit at the
 * end. The as-of date is the stored one, else the stored returns table date.
 */
export function normalizeIndexRow(row: JsonRecord): JsonRecord {
  if (!row.metrics || typeof row.metrics !== 'object') return row;
  return { ...row, metrics: normalizeStoredMetrics(row.metrics as JsonRecord, row.returns as JsonRecord | undefined) };
}

export function normalizeStoredMetrics(metrics: JsonRecord, storedReturns?: JsonRecord | null): JsonRecord {
  const { returnsBasis: _basis, performanceAsOf: storedAsOf, dividendYieldBasis: _storedCode, ...restNoCode } = metrics;
  // The code travels with the stored yield: a null yield has no code, any stored
  // yield was an updater estimate (the only source), never a new yield with an old code.
  const code = dividendYieldBasisFor(numberOrNull(restNoCode.dividendYield));
  const rest: JsonRecord = {};
  for (const [key, value] of Object.entries(restNoCode)) {
    rest[key] = value;
    if (key === 'dividendYieldText') rest.dividendYieldBasis = code;
  }
  if (!('dividendYieldBasis' in rest)) rest.dividendYieldBasis = code;
  const monthEnd = (storedReturns?.monthEnd as JsonRecord | undefined) ?? {};
  return {
    ...rest,
    secYieldText: typeof rest.secYieldText === 'string' ? rest.secYieldText : (numberOrNull(rest.secYield) === null ? '—' : `${Number(rest.secYield).toFixed(2)}%`),
    returnsBasis: RETURNS_BASIS,
    performanceAsOf: isoDateOrNull(storedAsOf) ?? displayDateToIso(monthEnd.asOfDate),
  };
}

// ---------------------------------------------------------------------------
// Eligibility filters (AND logic, iShares semantics)
// ---------------------------------------------------------------------------

function inRange(value: number | null | undefined, range?: Range): boolean {
  if (!range) return true;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

function annualizedValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  if (period === 'YTD') return numberOrNull(metrics.ytd);
  if (period === '1Y') return numberOrNull(metrics.tr1y);
  return numberOrNull(metrics[`cagr${period.toLowerCase()}`]);
}

function cumulativeValue(metrics: JsonRecord, period: ReturnPeriod): number | null {
  const key = period === 'YTD' ? 'ytd' : period === '1Y' ? 'tr1y' : `tr${period.toLowerCase()}`;
  return numberOrNull(metrics[key]);
}

function fundFilterReasons(
  candidate: { ticker: string; aumValue?: number | null; terValue?: number | null; metrics: JsonRecord },
  config: UpdaterConfig,
): string[] {
  const reasons: string[] = [];
  if (config.tickers.length && !config.tickers.includes(candidate.ticker)) reasons.push('TICKERS');
  if (config.aumRange && !inRange(candidate.aumValue ?? null, config.aumRange)) reasons.push('AUM');
  if (config.terRange && !inRange(candidate.terValue ?? null, config.terRange)) reasons.push('TER');
  if (config.dividendYieldRange && !inRange(numberOrNull(candidate.metrics.dividendYield), config.dividendYieldRange)) {
    reasons.push('DIVIDEND_YIELD');
  }
  for (const period of RETURN_PERIODS) {
    const performance = config.performanceRanges[period];
    if (performance && !inRange(annualizedValue(candidate.metrics, period), performance)) reasons.push(`PERFORMANCE_${period}`);
    const total = config.totalReturnRanges[period];
    if (total && !inRange(cumulativeValue(candidate.metrics, period), total)) reasons.push(`TOTAL_RETURN_${period}`);
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Deterministic writers (iShares/SPDR-style)
// ---------------------------------------------------------------------------

export function samePublishedContent(previous: string, value: unknown): boolean {
  const withoutRunTimestamp = (item: unknown): unknown => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const { generatedAt, savedAt, ...content } = item as Record<string, unknown>;
    return content;
  };
  try {
    return JSON.stringify(withoutRunTimestamp(JSON.parse(previous))) === JSON.stringify(withoutRunTimestamp(value));
  } catch { return false; }
}

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const next = `${JSON.stringify(value, null, 1)}\n`;
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === next || (previous !== null && samePublishedContent(previous, value))) return false;
  await writeAtomic(file, next);
  return true;
}

async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: JsonRecord[],
  pageSize: number,
  prune = true,
): Promise<{ pages: string[]; pageSize: number; totalRows: number }> {
  await mkdir(new URL(`${kind}/`, dir), { recursive: true });
  const pages: string[] = [];
  if (rows.length) {
    const pageCount = Math.ceil(rows.length / pageSize);
    for (let page = 1; page <= pageCount; page++) {
      const slice = rows.slice((page - 1) * pageSize, page * pageSize);
      const name = `${kind}/${pad3(page)}.json`;
      await writeIfChanged(new URL(name, dir), {
        ticker,
        page,
        pageSize,
        totalRows: rows.length,
        headers,
        rows: slice,
      });
      pages.push(name);
    }
  }
  if (prune) await removeStalePages(dir, kind, new Set(pages));
  return { pages, pageSize, totalRows: rows.length };
}

async function removeStalePages(fundDir: URL, kind: 'holdings' | 'history', kept: Set<string>): Promise<void> {
  const kindDir = new URL(`${kind}/`, fundDir);
  let entries: string[] = [];
  try {
    entries = await readdir(kindDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith('.json') && !kept.has(`${kind}/${entry}`)) {
      await rm(new URL(entry, kindDir), { force: true });
    }
  }
}

type UpdateState = { cursor: string | null; savedAt: string };

async function readUpdateState(): Promise<UpdateState | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

async function writeUpdateState(lastProcessedTicker: string | null): Promise<void> {
  await writeIfChanged(STATE_FILE, {
    cursor: lastProcessedTicker,
    savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
}

async function readPreviousIndex(): Promise<Map<string, JsonRecord>> {
  const map = new Map<string, JsonRecord>();
  try {
    const payload = JSON.parse(await readFile(INDEX_FILE, 'utf8')) as JsonRecord;
    for (const fund of payload.funds || []) {
      if (fund && typeof fund.ticker === 'string') map.set(fund.ticker, fund);
    }
  } catch {
    // First run.
  }
  return map;
}

/**
 * ISO date a published index row is refreshed up to (the latest of its dated fields),
 * or null when the fund has no published data yet.
 */
export function publishedAsOf(row: JsonRecord | null | undefined): string | null {
  if (!row || row.dataFile === null) return null;
  const dates = [(row.metrics as JsonRecord | undefined)?.performanceAsOf, displayDateToIso(row.asOfDate)].filter(
    (value): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
  );
  return dates.length ? dates.sort()[dates.length - 1] : null;
}

/**
 * Run order of an unbounded run: funds without published data first, then the stalest
 * published as-of, ties alphabetical. A run cut short by the soft deadline therefore
 * leaves the freshest funds for last, and the next run starts where this one stopped.
 */
export function stalestFirst<T extends { ticker: string }>(funds: T[], published: Map<string, JsonRecord>): T[] {
  const key = (fund: T): string => publishedAsOf(published.get(fund.ticker)) ?? '';
  return funds.slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.ticker.localeCompare(b.ticker)));
}

/** One line for the log and the step summary: what a deadline-truncated run left behind. */
export function deadlineSummary(attempted: number, total: number, remaining: Array<{ ticker: string }>, published: Map<string, JsonRecord>): string {
  const ordered = stalestFirst(remaining, published);
  const oldest = ordered.length ? `${publishedAsOf(published.get(ordered[0].ticker)) ?? 'never published'} (${ordered[0].ticker})` : 'none';
  return `${attempted} of ${total} funds refreshed, ${remaining.length} keep their previously published data, oldest remaining published as-of: ${oldest}`;
}

async function readPreviousMeta(ticker: string): Promise<JsonRecord | null> {
  try {
    return JSON.parse(await readFile(new URL(`funds/${ticker}/meta.json`, API_ROOT), 'utf8')) as JsonRecord;
  } catch {
    return null;
  }
}

async function readPreviousSheet(ticker: string, kind: 'holdings' | 'history'): Promise<JsonRecord[]> {
  const rows: JsonRecord[] = [];
  let page = 1;
  for (;;) {
    let payload: JsonRecord;
    try {
      payload = JSON.parse(await readFile(new URL(`funds/${ticker}/${kind}/${pad3(page)}.json`, API_ROOT), 'utf8')) as JsonRecord;
    } catch {
      return rows;
    }
    rows.push(...(payload.rows || []));
    const totalRows = numberOrNull(payload.totalRows);
    if (totalRows !== null && rows.length >= totalRows) return rows;
    if (!(payload.rows || []).length) return rows;
    page += 1;
  }
}

// ---------------------------------------------------------------------------
// Fund assembly
// ---------------------------------------------------------------------------

type SeedFund = (typeof FIDELITY_FUNDS)[number];

// Yahoo's adjusted close is float32 and its last digits move with the request's period2, so a value
// sitting on a cent boundary (31.544998 vs 31.545001) flips between runs. Within that noise the
// published cent is kept: a rerun with the same source data changes nothing. Close and Volume
// update as usual; a real change beyond the noise is written.
export const ADJ_CLOSE_NOISE = 1e-4;
export function keepPublishedAdjClose(days: ChartDay[], published: JsonRecord[]): ChartDay[] {
  const cents = new Map<string, number>();
  for (const row of published) {
    const value = numberOrNull(row['Adj Close']);
    if (value !== null) cents.set(String(row.Date), value);
  }
  return days.map((day) => {
    const prior = cents.get(formatEdgarDate(day.date));
    const raw = day.adjCloseRaw ?? day.adjClose;
    return prior !== undefined && prior !== day.adjClose && Math.abs(raw - prior) <= 0.005 + ADJ_CLOSE_NOISE ? { ...day, adjClose: prior } : day;
  });
}

function historyRows(chart: ParsedChart): JsonRecord[] {
  return chart.days.map((day) => ({
    Date: formatEdgarDate(day.date),
    Close: String(day.close),
    'Adj Close': String(day.adjClose),
    Volume: String(day.volume),
  }));
}

// Array rows (not objects): meta.distributions feeds renderDistributionsTable
// directly, same as the SPDR/iShares worksheet shape.
function distributionRows(chart: ParsedChart): string[][] {
  return chart.dividends.map((dividend) => [formatUsDate(dividend.epoch), String(round(dividend.amount, 6))]);
}

export function returnsBlock(returns: PriceReturns | null, previous: JsonRecord): JsonRecord | null {
  if (!returns || !returns.asOfDate) return (previous.returns as JsonRecord) ?? null;
  const text = (value: number | null): string => (value === null ? '—' : `${value.toFixed(2)}%`);
  const quarterAnchor = lastCompletedQuarterEnd();
  return {
    derivedFrom: 'adjusted market-price closes (Yahoo chart API), not official NAV returns',
    monthEnd: {
      asOfDate: formatEdgarDate(returns.asOfDate),
      mo1: returns.mo1,
      mo1Text: text(returns.mo1),
      qtd: returns.qtd,
      qtdText: text(returns.qtd),
      ytd: returns.ytd,
      ytdText: text(returns.ytd),
      yr1: returns.yr1,
      yr1Text: text(returns.yr1),
      yr3: returns.cagr3y,
      yr3Text: text(returns.cagr3y),
      yr5: returns.cagr5y,
      yr5Text: text(returns.cagr5y),
      yr10: returns.cagr10y,
      yr10Text: text(returns.cagr10y),
      sinceInception: returns.siAnn,
      sinceInceptionText: text(returns.siAnn),
    },
    quarterEnd: emptyReturnRow(formatEdgarDate(quarterAnchor.toISOString().slice(0, 10))),
  };
}

/** A returns row with every value unavailable (null, never 0 and never a stray key). */
export function emptyReturnRow(asOfDate: string): JsonRecord {
  const row: JsonRecord = { asOfDate };
  for (const key of ['mo1', 'qtd', 'ytd', 'yr1', 'yr3', 'yr5', 'yr10', 'sinceInception']) {
    row[key] = null;
    row[`${key}Text`] = '—';
  }
  return row;
}

async function processFund(
  seed: SeedFund,
  config: UpdaterConfig,
  previous: JsonRecord,
  resolver: TickerResolver,
): Promise<JsonRecord | null> {
  const ticker = seed.ticker;
  const previousMeta = await readPreviousMeta(ticker);

  // 1) Yahoo chart: history, distributions, quote meta, derived metrics.
  let chart: ParsedChart | null = null;
  if (!config.skipYahoo) {
    try {
      const fetched = parseChart(await fetchJson(chartUrl(ticker, config), `[chart   ] ${ticker}`, yahooHeaders(), config));
      const publishedHistory = await readPreviousSheet(ticker, 'history');
      // A HISTORY_RANGE window never shrinks the published history (and with it 3y, 5y, 10y and since inception).
      const publishedDistributionRows = ((previousMeta?.distributions as JsonRecord | undefined)?.rows as unknown[] | undefined) ?? [];
      const merged = mergeWindowedChart(fetched, publishedHistory, publishedDistributionRows);
      if (!merged) throw new Error(`chart window does not join the published history (${config.historyRange})`);
      // History is rebuilt from the chart on every run: compare with the published rows first.
      merged.days = keepPublishedAdjClose(merged.days, publishedHistory);
      chart = merged;
    } catch (error) {
      outputNote(`[ ${'chart'.padEnd(9)}] ${ticker}: ${error instanceof Error ? error.message : String(error)} — keeping previous history`);
    }
  }

  // The shared "younger than one year" rule on the final returns: no 1y or since-inception figure before the first
  // anniversary of the inception date, no 3, 5 or 10-year one before those (calendar anniversary, inclusive).
  const inception = chart?.firstTradeDate ? epochToIsoDate(chart.firstTradeDate) : seed.inception;
  const fresh = chart ? priceReturns(chart.days) : null;
  const returns = fresh ? withoutYoungReturns(fresh, inception, fresh.asOfDate, { yr1: 1, cagr3y: 3, cagr5y: 5, cagr10y: 10, siAnn: 1 }) : null;
  const metrics: JsonRecord = chart && returns
    ? deriveCatalogMetrics(
        returns,
        chart.dividends.length ? chart.dividends[chart.dividends.length - 1].amount : null,
        inferDistributionFrequency(chart.dividends).paymentsPerYear,
        chart.regularMarketPrice,
      )
    : (previous.metrics
        ? normalizeStoredMetrics(previous.metrics as JsonRecord, previous.returns as JsonRecord | undefined)
        : deriveCatalogMetrics(priceReturns([]), null, null, null));

  const candidate = {
    ticker,
    aumValue: numberOrNull(previous.aumValue),
    terValue: numberOrNull(seed.ter),
    metrics,
  };
  const reasons = fundFilterReasons(candidate, config);
  if (reasons.length) {
    return null;
  }

  // 2) SEC N-PORT: official holdings + net assets (sum of reported valUSD), read by the shared nport-reader block: the
  // fund's own series (SEC table, else the seed), newest report period first, used only when strictly newer than the
  // published holdings. REFRESH_CATALOG=false and the catalog-only funds (no N-PORT) keep holdings and AUM as published.
  const series = config.refreshCatalog && !seed.catalogOnly ? await nportSeriesOf(seed, config) : null;
  const seriesId = series ? series.seriesId : seed.seriesId;
  // Holdings published for another series (before a seed correction) are no baseline for freshness or the guard's row count.
  const published = (previousMeta?.seed as JsonRecord | undefined)?.seriesId === seriesId ? previousMeta : null;
  let nport: { filing: NportFiling; accession: string; cik: string; url: string; totalValue: number } | null = null;
  if (series) {
    try {
      const raw = new Map<string, string>();
      const read = await readNportHoldings(
        { ticker, cik: series.cik, seriesId: series.seriesId, name: seed.shareClassOf || chart?.longName || seed.name },
        { asOf: calendarIso((published?.holdings as JsonRecord | undefined)?.asOf), rows: numberOrNull((published?.holdings as JsonRecord | undefined)?.totalRows) ?? 0 },
        async (url, label) => {
          const text = await fetchText(url, `[nport   ] ${label}`, secHeaders(config), config);
          if (config.storeRawDownloads && url.endsWith('/primary_doc.xml')) raw.set(url, text);
          return text;
        },
        { cache: secState.reader },
      );
      if ('problem' in read) {
        // An older or equal report period is the normal case (VERBOSE only); a filing of another series or none is always reported.
        if (/ is not newer than /.test(read.problem)) outputNote(`[ ${'nport'.padEnd(9)}] ${read.problem}; keeping previous holdings`);
        else console.warn(`[ ${'nport'.padEnd(9)}] ${read.problem} — N-PORT not used, keeping previous holdings`);
      } else {
        const totalValue = read.filing.positions.reduce((sum, position) => sum + (position.value === null ? 0 : position.value), 0);
        nport = { filing: read.filing, accession: read.candidate.accession, cik: Number(read.candidate.cik) ? read.candidate.cik : series.cik, url: read.url, totalValue };
        const xml = raw.get(read.url);
        if (xml !== undefined) {
          const rawDir = new URL(`raw/${ticker}/`, API_ROOT);
          await mkdir(rawDir, { recursive: true });
          await writeFile(new URL(`nport-${(read.filing.repPdDate || 'latest').replace(/-/g, '')}.xml`, rawDir), xml, 'utf8');
        }
      }
    } catch (error) {
      outputNote(`[ ${'nport'.padEnd(9)}] ${ticker}: ${error instanceof Error ? error.message : String(error)} — keeping previous holdings`);
    }
  }

  const holdingsHeaders = HOLDINGS_HEADERS;
  const holdingsRows: JsonRecord[] = nport
    ? nportHoldingsSheet(nport.filing, await nportHoldingTickers(nport.filing.positions, await loadCompanyNames(config).catch(() => new Map<string, string>()), resolver))
    : await readPreviousSheet(ticker, 'holdings');
  // A fund is either fully updated or fully kept: fresh N-PORT holdings that look broken (no weight column,
  // non-numeric weights, a bad weight sum, half the rows gone, no numeric weight where the published sheet had them)
  // fail the fund before anything of it is written, so its previous complete state stays published. The previous sheet
  // re-read as retention is not checked.
  const publishedWeights = nport && published ? holdingsWeightCount(HOLDINGS_HEADERS, await readPreviousSheet(ticker, 'holdings')) : null;
  const holdingsProblem = nport ? holdingsGuard(holdingsHeaders, holdingsRows, numberOrNull(published?.holdings?.totalRows), HOLDINGS_GUARD_RELAX[ticker] ?? HOLDINGS_GUARD_RELAX['*'] ?? [], publishedWeights) : null;
  if (holdingsProblem) throw new Error(`holdings guard: ${holdingsProblem}; ${previousMeta ? 'kept the previous complete data' : 'no data published for this fund yet'}`);

  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  await mkdir(fundDir, { recursive: true });

  const holdingsManifest = await writePages(fundDir, ticker, 'holdings', holdingsHeaders, holdingsRows, config.holdingsPageSize, false);

  const historyHeaders = ['Date', 'Close', 'Adj Close', 'Volume'];
  const history = chart ? historyRows(chart) : await readPreviousSheet(ticker, 'history');
  const historyManifest = await writePages(fundDir, ticker, 'history', historyHeaders, history, config.historyPageSize, false);

  const previousDistributions = (previousMeta?.distributions as JsonRecord | undefined) ?? {};
  const distributions = chart ? distributionRows(chart) : ((previousDistributions.rows as string[][]) || []);
  const frequency = chart
    ? inferDistributionFrequency(chart.dividends)
    : {
        frequency: String(previousDistributions.frequency || (previous.distributions as JsonRecord | undefined)?.frequency || '—'),
        paymentsPerYear: numberOrNull(previousDistributions.paymentsPerYear),
      };
  const latestDividend = chart && chart.dividends.length ? chart.dividends[chart.dividends.length - 1] : null;

  const name = seed.shareClassOf ? seed.name : (nport?.filing.seriesName || seed.name);
  // Yahoo's chart meta carries no NAV for these funds and Fidelity publishes no
  // machine-readable NAV, so nav and premium stay null (never guessed). When the
  // chart request failed, the previously published quote block is kept as one unit.
  const nav = chart ? (chart.navPrice ?? null) : numberOrNull(previous.navValue);
  const price = chart ? (chart.regularMarketPrice ?? null) : numberOrNull(previous.closePriceValue);
  const premiumDiscount = chart ? (nav && price ? round(((price - nav) / nav) * 100, 2) : null) : numberOrNull(previous.premiumDiscountValue);
  const previousQuoteDate = (key: 'nav' | 'marketPrice'): string => String(((previousMeta?.[key] as JsonRecord | undefined)?.asOfDate as string | undefined) ?? '—');
  const quoteDate = chart?.regularMarketTime ? formatEpochDate(chart.regularMarketTime) : null;
  // A share class has no AUM of its own in N-PORT: the reported net assets are the whole multi-class fund's.
  const netAssets = seed.shareClassOf ? null : nport ? nport.totalValue : numberOrNull(previous.aumValue);
  const returnsData = returnsBlock(returns, previous);
  // The filing links and the accession describe the published holdings: while no N-PORT filing is used (REFRESH_CATALOG=false,
  // no filing newer than the published holdings, a filing of another series, a failed request) they stay as published with the holdings.
  const keptFiling = !nport && previousMeta ? { source: (previousMeta.source as JsonRecord | undefined) ?? {}, seed: (previousMeta.seed as JsonRecord | undefined) ?? {} } : null;

  const meta: JsonRecord = {
    ticker,
    name,
    category: seed.category,
    source: {
      fundPage: seed.fundPage,
      edgarFiling: keptFiling
        ? (keptFiling.source.edgarFiling ?? null)
        : nport ? `${EDGAR_ARCHIVES}/${Number(nport.cik)}/${nport.accession.replace(/-/g, '')}/${nport.accession.replace(/-/g, '')}-index.htm` : null,
      nportDoc: keptFiling ? (keptFiling.source.nportDoc ?? null) : nport ? nport.url : null,
      // A stable provenance URL, not the live fetch URL: chartUrl(ticker, config)
      // embeds the current timestamp in period2, which would make this field
      // (and the file's digest) change on every single run.
      yahooChart: `${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}`,
      provider: 'SEC EDGAR (N-PORT-P) + Yahoo Finance public chart API',
    },
    expenseRatio: numberOrNull(seed.ter) === null ? { display: '—', value: null } : { display: `${seed.ter}%`, value: numberOrNull(seed.ter) },
    nav: {
      display: nav === null ? '—' : `$${nav.toFixed(2)}`,
      value: nav,
      asOfDate: nav === null ? '—' : (chart ? (quoteDate ?? '—') : previousQuoteDate('nav')),
    },
    marketPrice: {
      display: price === null ? '—' : `$${price.toFixed(2)}`,
      value: price,
      asOfDate: price === null ? '—' : (chart ? (quoteDate ?? '—') : previousQuoteDate('marketPrice')),
    },
    premiumDiscount: { display: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`, value: premiumDiscount },
    aum: {
      display: netAssets === null ? '—' : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: seed.shareClassOf ? '—' : nport ? formatEdgarDate(nport.filing.repPdDate) : (((previousMeta?.aum as JsonRecord | undefined)?.asOfDate as string) ?? '—'),
      source: seed.shareClassOf
        ? `not published: the N-PORT net assets cover every share class of ${seed.shareClassOf}`
        : nport ? 'sum of reported N-PORT position values' : ((previousMeta?.aum as JsonRecord | undefined)?.source ?? 'previous run'),
    },
    returns: returnsData,
    distributions: { frequency: frequency.frequency, paymentsPerYear: frequency.paymentsPerYear, headers: ['Ex-Date', 'Amount'], rows: distributions },
    holdings: {
      ...holdingsManifest,
      asOf: nport ? formatEdgarDate(nport.filing.repPdDate) : (((previousMeta?.holdings as JsonRecord | undefined)?.asOf as string) ?? '—'),
    },
    history: {
      ...historyManifest,
      asOf: returns ? formatEdgarDate(returns.asOfDate) : (((previousMeta?.history as JsonRecord | undefined)?.asOf as string) ?? '—'),
    },
    seed: {
      // The series of the published holdings: kept from before while N-PORT data is not used, so a corrected seed
      // never makes another series' retained holdings the baseline of the next run.
      seriesId: nport || !previousMeta?.seed ? seriesId : (previousMeta.seed.seriesId ?? null),
      seriesName: nport || !previousMeta?.seed ? (seed.shareClassOf || seed.name) : (previousMeta.seed.seriesName ?? null),
      trustCik: seed.trustCik,
      trustName: FIDELITY_TRUSTS[seed.trustCik] || null,
      accession: keptFiling ? (keptFiling.seed.accession ?? null) : nport ? nport.accession : null,
    },
  };
  // Order: pages first, then meta.json, then stale pages go (a crash in between never leaves meta pointing at removed pages).
  await writeIfChanged(new URL('meta.json', fundDir), meta);
  await removeStalePages(fundDir, 'holdings', new Set(holdingsManifest.pages));
  await removeStalePages(fundDir, 'history', new Set(historyManifest.pages));

  const monthEnd = (returnsData?.monthEnd as JsonRecord) || {};
  const fundRow: JsonRecord = {
    ticker,
    name,
    category: seed.category,
    fundPage: seed.fundPage,
    dataFile: `./funds/${ticker}/meta.json`,
    ter: numberOrNull(seed.ter) === null ? '—' : `${seed.ter}%`,
    terValue: numberOrNull(seed.ter),
    nav: nav === null ? '—' : `$${nav.toFixed(2)}`,
    navValue: nav,
    aum: netAssets === null ? '—' : formatAumDisplay(netAssets),
    aumValue: netAssets,
    asOfDate: returns ? formatEdgarDate(returns.asOfDate) : (previous.asOfDate || '—'),
    inceptionDate: chart?.firstTradeDate ? formatEpochDate(chart.firstTradeDate) : (previous.inceptionDate || '—'),
    exchange: chart?.exchangeName || (previous.exchange || ''),
    closePrice: price === null ? '—' : `$${price.toFixed(2)}`,
    closePriceValue: price,
    premiumDiscount: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`,
    premiumDiscountValue: premiumDiscount,
    distributions: chart || !previous.distributions
      ? {
          frequency: frequency.frequency,
          exDate: latestDividend ? formatUsDate(latestDividend.epoch) : '—',
          dividend: latestDividend ? String(round(latestDividend.amount, 6)) : '—',
        }
      : previous.distributions,
    returns: {
      monthEnd: monthEnd,
      quarterEnd: (returnsData?.quarterEnd as JsonRecord) || null,
    },
    metrics,
    holdings: holdingsRows.length,
    history: history.length,
  };
  return fundRow;
}

/** Index row of a seed fund with nothing published (its first refresh failed): seed facts only, no meta.json, dataFile null, every metric null. */
export function catalogOnlyRow(seed: SeedFund): JsonRecord {
  return {
    ticker: seed.ticker,
    name: seed.name,
    category: seed.category,
    fundPage: seed.fundPage,
    dataFile: null,
    ter: numberOrNull(seed.ter) === null ? '—' : `${seed.ter}%`,
    terValue: numberOrNull(seed.ter),
    nav: '—',
    navValue: null,
    aum: '—',
    aumValue: null,
    asOfDate: '—',
    inceptionDate: '—',
    exchange: '',
    closePrice: '—',
    closePriceValue: null,
    premiumDiscount: '—',
    premiumDiscountValue: null,
    distributions: { frequency: '—', exDate: '—', dividend: '—' },
    returns: { monthEnd: {}, quarterEnd: null },
    metrics: deriveCatalogMetrics(priceReturns([]), null, null, null),
    holdings: 0,
    history: 0,
  };
}

// ---------------------------------------------------------------------------
// --backfill-tickers: offline re-stamp of already generated holdings data
//
// Applies the name -> ticker seed to the committed api/fidelity holdings
// pages without touching the network. Used right after the seed gains new
// entries (or when this fix lands) so previously generated feeds pick up
// real tickers before the next full EDGAR/Yahoo run.
// ---------------------------------------------------------------------------

async function backfillTickers(): Promise<void> {
  console.log('Fidelity ETF static data updater — holdings ticker backfill (offline, seed only)');
  const resolver = new TickerResolver(await readHeldTickers());
  console.log(`[ticker  ] ${resolver.size} known holding names in api/fidelity/held-tickers.json`);

  const fundsDir = new URL('funds/', API_ROOT);
  let fundDirs: string[] = [];
  try {
    fundDirs = await readdir(fundsDir);
  } catch {
    console.log('[done    ] no api/fidelity/funds directory yet — nothing to backfill');
    return;
  }

  let funds = 0;
  let pages = 0;
  let rowsFilled = 0;
  let rowsScanned = 0;
  for (const dir of fundDirs) {
    let firstPage: JsonRecord;
    try {
      firstPage = JSON.parse(await readFile(new URL(`funds/${dir}/holdings/001.json`, API_ROOT), 'utf8')) as JsonRecord;
    } catch {
      continue; // no holdings sheet (e.g. catalog-only FBTC/FETH)
    }
    const headers = Array.isArray(firstPage.headers) ? (firstPage.headers as string[]) : [];
    if (!headers.length) continue;
    const pageSize = parsePositiveInt(String(firstPage.pageSize), HOLDINGS_PAGE_SIZE_FALLBACK);

    const rows = (await readPreviousSheet(dir, 'holdings')) as JsonRecord[];
    rowsScanned += rows.length;
    if (!rows.length) continue;

    let changed = false;
    for (const row of rows) {
      // Only equity and preferred rows: a bond, loan or fund row of a listed issuer never takes the issuer's stock ticker
      if (String(row.Ticker ?? '-') !== '-' || !/^(EC|EP)$/.test(String(row['Asset Category'] ?? ''))) continue;
      const symbol = resolver.lookup(String(row.Name ?? ''));
      if (symbol) {
        row.Ticker = symbol;
        rowsFilled += 1;
        changed = true;
      }
    }
    if (changed) {
      const manifest = await writePages(new URL(`funds/${dir}/`, API_ROOT), dir, 'holdings', headers, rows, pageSize);
      pages += manifest.pages.length;
      funds += 1;
    }
  }

  console.log('');
  console.log(`[done    ] ${funds} funds rewritten (${pages} holdings pages), ${rowsFilled} of ${rowsScanned} holding rows gained a ticker`);
  console.log(`[cursor  ] rows still "-" are no equity or preferred row (bonds, private debt, funds, derivatives) or are not in the seed yet (a live run resolves them via Yahoo search)`);
}

// ---------------------------------------------------------------------------
// Controls: one resolver shared by the CLI and the GitHub Actions workflow
// ---------------------------------------------------------------------------

// Precedence: config file < advanced JSON < nonblank named inputs < environment
// (`FIDELITY_<KEY>` and legacy aliases are honored; explicit env wins).
export const CONTROL_NAMES = [
  'MAX_FETCHES', 'REQUEST_SLEEP', 'CONCURRENCY', 'AUM', 'TER', 'DIVIDEND_YIELD', 'TICKERS',
  'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'STORE_RAW_DOWNLOADS', 'MAX_RETRIES', 'HISTORY_RANGE',
  'SEC_UA', 'SKIP_YAHOO', 'REFRESH_CATALOG', 'VERBOSE', 'USE_SYSTEM_CA',
  ...['PERFORMANCE', 'TOTAL_RETURN'].flatMap((prefix) => ['YTD', '1Y', '3Y', '5Y', '10Y'].map((period) => `${prefix}_${period}`)),
] as const;
export type ControlName = (typeof CONTROL_NAMES)[number];
export const CONFIG_FILE_URL = new URL('./update-data.config.json', import.meta.url);
const CONTROL_ENV_ALIASES: Partial<Record<ControlName, string[]>> = {
  MAX_FETCHES: ['FIDELITY_LIMIT'],
  HISTORY_PAGE_SIZE: ['HISTORICAL_PAGE_SIZE'],
};

export function resolveControls(
  file: unknown = {},
  advanced: unknown = {},
  inputs: unknown = {},
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  const known = new Set<string>(CONTROL_NAMES);
  const apply = (value: unknown, skipEmpty = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
    for (const [key, raw] of Object.entries(value)) {
      if (!known.has(key)) throw new Error(`Unknown updater control: ${key}`);
      if (skipEmpty && (raw === '' || raw === undefined || raw === null)) continue;
      if (!['string', 'number', 'boolean'].includes(typeof raw)) throw new Error(`${key}: expected string, number or boolean`);
      const text = String(raw);
      if (/[\r\n\0]/.test(text)) throw new Error(`${key}: multiline/control characters are not allowed`);
      result[key] = text;
    }
  };
  apply(file);
  apply(advanced);
  apply(inputs, true);
  for (const key of CONTROL_NAMES) {
    const value = [`FIDELITY_${key}`, key, ...(CONTROL_ENV_ALIASES[key] ?? [])].map((name) => env[name]).find((v) => v !== undefined);
    if (value !== undefined) apply({ [key]: value });
  }
  for (const key of ['MAX_FETCHES', 'CONCURRENCY', 'HOLDINGS_PAGE_SIZE', 'HISTORY_PAGE_SIZE', 'MAX_RETRIES']) {
    const v = result[key]?.trim();
    if (v === undefined || v === '') continue;
    const min = key === 'MAX_FETCHES' ? 0 : 1;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)) || Number(v) < min) throw new Error(`${key}: expected integer >= ${min}`);
  }
  const sleep = result.REQUEST_SLEEP?.trim();
  if (sleep && (!Number.isFinite(Number(sleep)) || Number(sleep) < 0)) throw new Error('REQUEST_SLEEP: expected nonnegative seconds');
  for (const key of ['STORE_RAW_DOWNLOADS', 'SKIP_YAHOO', 'REFRESH_CATALOG', 'VERBOSE']) {
    if (result[key]?.trim() && !/^(0|1|true|false|yes|no|y|n|on|off)$/i.test(result[key].trim())) throw new Error(`${key}: expected boolean`);
  }
  if (result.USE_SYSTEM_CA !== undefined && !/^(auto|true|false)$/i.test(result.USE_SYSTEM_CA.trim())) throw new Error('USE_SYSTEM_CA: expected auto, true or false');
  const range = result.HISTORY_RANGE?.trim();
  if (range && !/^(max|\d+y)$/i.test(range)) throw new Error('HISTORY_RANGE: expected "max" or "<N>y"');
  readConfig(result); // validate every min:max filter before any request or write
  return result;
}

export async function runtimeControls(env: Record<string, string | undefined> = process.env): Promise<Record<string, string>> {
  let file: unknown = {};
  try { file = JSON.parse(await readFile(CONFIG_FILE_URL, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return resolveControls(file, {}, {}, env);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  const runStartedAt = Date.now();
  const controls = await runtimeControls(env);
  if (env === process.env) process.env.VERBOSE = controls.VERBOSE ?? '';
  if (env === process.env) installSystemCa((controls.USE_SYSTEM_CA ?? 'auto').trim().toLowerCase());
  const config = readConfig(controls);
  configureRequestLanes(config.concurrency, config.requestSleep);

  outputPrintConfig('Fidelity', config);

  const seedFunds = FIDELITY_FUNDS.slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[ ${'catalog'.padEnd(9)}] ${seedFunds.length} Fidelity ETFs (built-in seed across ${Object.keys(FIDELITY_TRUSTS).length} SEC registrants)`);
  const heldTickers = await readHeldTickers();
  console.log(`[ ${'ticker'.padEnd(9)}] ${Object.keys(heldTickers).length} known holding names in api/fidelity/held-tickers.json${config.skipYahoo ? ' (live Yahoo resolution off: SKIP_YAHOO)' : ''}`);

  // Unknown holding names are resolved through the Yahoo symbol search
  // (strict name match). Every search is globally paced like the rest of the
  // run's requests and cached for the whole run.
  const searchHoldingTicker = async (name: string): Promise<string | null> => {
    const payload = await fetchJson(yahooSearchUrl(name), `[ticker   ] ${name}`, yahooHeaders(), config);
    return pickSearchTicker(name, payload);
  };
  const persistedMisses = await readMisses();
  const resolver = new TickerResolver(heldTickers, config.skipYahoo ? null : searchHoldingTicker, persistedMisses);
  console.log(`[ ${'ticker'.padEnd(9)}] ${Object.keys(persistedMisses).length} remembered search misses in api/fidelity/held-ticker-misses.json (retried after ${MISS_TTL_DAYS} days)`);

  // One run, one SEC state: the SEC ticker tables and the N-PORT reader cache (submissions and documents shared by the funds of a trust).
  resetSecState();

  const previousIndex = await readPreviousIndex();
  const previousRows = Array.from(previousIndex.values());
  const state = await readUpdateState();
  // The seed is the live catalog: a catalog-only row of a ticker it no longer lists is dropped, never retried.
  const live = seedFunds.map((fund) => fund.ticker);
  // TICKERS is strict and scopes the run: a ticker that is neither in the seed nor a published fund (a closed fund that left
  // the seed stays known) stops the run before any request (open-items etfs Q27); unselected funds neither count against
  // MAX_FETCHES nor move the cursor.
  assertKnownTickers(config.tickers.length ? config.tickers : null, knownTickers(live, previousRows), 'the Fidelity seed or published feed');
  const selected = config.tickers.length ? seedFunds.filter((fund) => config.tickers.includes(fund.ticker)) : seedFunds;
  const cursor = config.maxFetches > 0 && !config.tickers.length ? state?.cursor || null : null;
  const cursorIndex = cursor ? selected.findIndex((fund) => fund.ticker === cursor) : -1;
  // A bounded unscoped run keeps walking the alphabetical cursor; every other run goes stalest first.
  // Closed funds leave the run here: never fetched, never guarded, no MAX_FETCHES budget, no fund line.
  const cursorMode = config.maxFetches > 0 && !config.tickers.length;
  const ordered = withoutClosedFunds(
    cursorMode
      ? cursorIndex >= 0
        ? selected.slice(cursorIndex + 1).concat(selected.slice(0, cursorIndex + 1))
        : selected.slice()
      : stalestFirst(selected, previousIndex),
    (seed) => seed.ticker,
    CLOSED_FUNDS,
  );

  const queue = ordered.map((seed) => ({ seed }));
  const results: JsonRecord[] = [];
  const catalogOnly: JsonRecord[] = [];
  let processed = 0;
  let lastDispatchedTicker: string | null = cursor;
  let failures = 0;
  // Counted from the start of the run, not after the N-PORT scan: the 30 min workflow timeout counts the scan too.
  const deadline = runStartedAt + softDeadlineMs;
  let deadlineHit = false;

  outputPrintFilter(selected.length, seedFunds.length, outputHasOutputFilters(config));
  const output = outputCreateReporter(API_ROOT, config.maxFetches > 0 ? Math.min(config.maxFetches, ordered.length) : ordered.length);
  async function worker(): Promise<void> {
    for (;;) {
      if (config.maxFetches > 0 && processed >= config.maxFetches) return;
      if (!queue.length) return;
      if (Date.now() > deadline) { deadlineHit = true; return; }
      const item = queue.shift()!;
      const seed = item.seed;
      const previous = previousIndex.get(seed.ticker) || {};
      processed += 1;
      lastDispatchedTicker = seed.ticker;
      const before = await output.before(seed.ticker);
      try {
        const row = await processFund(seed, config, previous, resolver);
        if (row) results.push(row);
        await output.result(seed.ticker, before, row ? undefined : 'skipped', undefined, row ? { metrics: row.metrics } : {});
      } catch (error) {
        failures += 1;
        // A new fund (nothing published) that failed, e.g. its first holdings were rejected by the guard, is still listed.
        if (!previousIndex.has(seed.ticker) && !(await readPreviousMeta(seed.ticker))) catalogOnly.push(catalogOnlyRow(seed));
        await output.result(seed.ticker, before, 'failed', String(error));
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));
  const deadlineText = deadlineHit ? deadlineSummary(processed, ordered.length, queue.map((item) => item.seed), previousIndex) : '';
  if (deadlineHit) console.log(`[ ${'deadline'.padEnd(9)}] soft run deadline reached: ${deadlineText}; the next run starts with them`);

  // Funds not selected for a successful update keep their previously published rows; a fund with published data (a closed
  // fund that left the seed too) keeps its row, a catalog-only row of a ticker the seed no longer lists is dropped.
  const keptFromPrevious = withoutStalePlaceholders(previousRows, live)
    .filter((row) => !results.some((fresh) => fresh.ticker === row.ticker))
    .map((row) => normalizeIndexRow(row));
  const funds = markClosedFunds([...results, ...keptFromPrevious, ...catalogOnly].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker))), CLOSED_FUNDS);

  const counts = {
    funds: funds.length,
    holdings: funds.reduce((sum, fund) => sum + (numberOrNull(fund.holdings) || 0), 0),
    history: funds.reduce((sum, fund) => sum + (numberOrNull(fund.history) || 0), 0),
  };

  await writeIfChanged(INDEX_FILE, {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    source: {
      provider: 'Fidelity Investments (ETFs)',
      market: 'us',
      site: 'https://digital.fidelity.com/prgw/digital/research/etfs',
      catalog: 'SEC EDGAR N-PORT-P filings of the Fidelity ETF trusts',
      history: 'Yahoo Finance public chart API (adjusted close)',
      holdingTickers: 'U.S. equities traded in USD only: SEC EDGAR company_tickers.json names, then the held-tickers.json seed extended live by the Yahoo Finance symbol search',
      trusts: FIDELITY_TRUSTS,
    },
    counts,
    funds,
  });
  // Q28: a fund is announced on its first successful publish (a catalog-only row is not published), new catalog-only rows as pending
  const newFunds = newFundsLines(newFundsReport(previousRows, funds));
  for (const line of newFunds) console.log(line);
  if (newFunds.length && process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### NEW FUNDS\n\n${newFunds.join('\n')}\n`, 'utf8');

  // Persist tickers learned from live searches so the next run (and the
  // --backfill-tickers mode) can serve them without re-querying Yahoo.
  if (resolver.fresh.length) {
    const merged: Record<string, string> = { ...heldTickers, ...resolver.freshEntries() };
    const seedChanged = await writeTextIfChanged(HELD_TICKERS_FILE, formatHeldTickers(merged));
    if (seedChanged) {
      console.log(`[ ${'ticker'.padEnd(9)}] ${resolver.fresh.length} new name -> ticker mappings added to api/fidelity/held-tickers.json`);
    }
  }

  // Remember genuine search misses (sorted, only when the content changed) so the next run does not repeat them.
  if (!config.skipYahoo) {
    const missesChanged = await writeTextIfChanged(MISSES_FILE, formatMisses(resolver.missEntries()), true);
    if (missesChanged) console.log(`[ ${'ticker'.padEnd(9)}] search misses updated in api/fidelity/held-ticker-misses.json`);
  }
  console.log(`[ ${'ticker'.padEnd(9)}] name searches: ${resolver.stats.searches} sent, ${resolver.stats.skippedCategory} skipped (no-ticker asset category), ${resolver.stats.skippedKnownMiss} skipped (remembered miss)`);

  // Only an unscoped bounded run owns the cursor; full passes reset it, TICKERS runs never touch it.
  if (!config.tickers.length) await writeUpdateState(config.maxFetches > 0 ? lastDispatchedTicker : null);

  console.log(output.summary(runStartedAt));
  console.log(outputCounts(counts.funds, counts.holdings, counts.history));
  console.log(`[ ${'cursor'.padEnd(9)}] ${config.maxFetches > 0 && !config.tickers.length && lastDispatchedTicker ? `next run continues after ${lastDispatchedTicker}` : 'cursor reset'}`);
  if (failures > 0 && results.length === 0) {
    console.error(`[ ${'failed'.padEnd(9)}] every selected fund failed`);
    process.exitCode = 1;
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Fidelity data update\n\n- updated: ${results.length}\n- kept from previous runs: ${keptFromPrevious.length}\n- failed: ${failures}\n${deadlineHit ? `- soft deadline: ${deadlineText}\n` : ''}- counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows\n`,
      'utf8',
    );
  }
}

// ---------------------------------------------------------------------------
// Entry point (kept at the end: main() relies on the let bindings above)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    console.log(USAGE.trim());
  } else if (process.argv.includes('--backfill-tickers')) {
    await backfillTickers().catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  } else {
    await main().catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  }
}

// <holdings-guard> shared block of .claude/tools/etfs/etf-std/holdings-guard.block.ts, applied by apply-holdings-guard.ts: never edit it in one repo
/**
 * Sanity check of a fund's new holdings before they replace the published ones. Returns why they must be rejected
 * (the caller then keeps the fund's previous state and reports it as failed), or null when they may be written.
 * An empty sheet passes only when nothing was published before. Otherwise a Name and a weight column (Weight,
 * Weight (%) or Market Weight) are required, >= 80% of the rows carry a numeric weight, the weights add up to
 * 50..150 and the sheet keeps >= 50% of the previously published rows. `relax` switches off the checks a fund
 * legitimately fails: 'numeric' and 'sum' (geared, inverse, futures, look-through, top-N lists) and 'count'. No relax lets
 * a sheet without a single numeric weight replace a published sheet that had numeric weights (`previousWeights`: how many
 * rows of the published sheet carry a numeric weight, see holdingsWeightCount; open-items etfs Q24).
 * Rows are arrays in header order or objects keyed by the header text. A fund in the brand's CLOSED_FUNDS never reaches the guard.
 */
export function holdingsGuard(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, previousRows: number | null | undefined, relax: ReadonlyArray<string> = [], previousWeights: number | null = null): string | null {
  const previous = Number(previousRows) > 0 ? Number(previousRows) : 0;
  if (!rows.length) return previous ? `no holdings rows (${previous} published)` : null;
  const names = headers.map((header) => String(header).trim().toLowerCase());
  const nameAt = names.indexOf('name');
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  if (nameAt < 0 || weightAt < 0) return `no ${nameAt < 0 ? 'Name' : 'weight'} column (headers: ${headers.join(', ') || 'none'})`;
  const weights = holdingsGuardWeights(headers, rows, weightAt);
  const numeric = weights.count;
  const sum = weights.sum;
  if (numeric === 0 && Number(previousWeights) > 0) return `no row has a numeric weight, the published sheet had ${Number(previousWeights)}`;
  if (relax.indexOf('numeric') < 0 && numeric < rows.length * 0.8) return `only ${numeric} of ${rows.length} rows have a numeric weight`;
  if (relax.indexOf('sum') < 0 && (sum < 50 || sum > 150)) return `weights add up to ${sum.toFixed(2)}, outside 50..150`;
  if (relax.indexOf('count') < 0 && previous && rows.length < previous * 0.5) return `${rows.length} rows, less than half of the ${previous} published`;
  return null;
}

/** How many rows carry a numeric weight (Weight, Weight (%) or Market Weight column), 0 without such a column: pass it for the published sheet as holdingsGuard's previousWeights. */
export function holdingsWeightCount(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>): number {
  const names = headers.map((header) => String(header).trim().toLowerCase());
  let weightAt = names.indexOf('weight');
  if (weightAt < 0) weightAt = names.indexOf('weight (%)');
  if (weightAt < 0) weightAt = names.indexOf('market weight');
  return weightAt < 0 ? 0 : holdingsGuardWeights(headers, rows, weightAt).count;
}

/** Count and sum of the numeric weights in column weightAt; rows are arrays in header order or objects keyed by the header text. */
function holdingsGuardWeights(headers: ReadonlyArray<string>, rows: ReadonlyArray<unknown>, weightAt: number): { count: number; sum: number } {
  let count = 0;
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const row: any = rows[i];
    const weight = holdingsGuardNumber(Array.isArray(row) ? row[weightAt] : row && typeof row === 'object' ? row[headers[weightAt]] : undefined);
    if (weight !== null) {
      count++;
      sum += weight;
    }
  }
  return { count, sum };
}

/** A weight cell as a number: %, $, commas and spaces are ignored, (x) is negative; null when it is no plain number (a zero-width character inside counts as broken). */
function holdingsGuardNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value === null || value === undefined ? '' : value).replace(/[ \t ,%$]/g, '').replace(/−/g, '-');
  const negative = /^\(.*\)$/.test(text);
  if (negative) text = text.slice(1, -1);
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  return negative ? -Number(text) : Number(text);
}

/** A fund its issuer closed (liquidated, delisted or merged away), confirmed from an official source: an SEC filing or the issuer's notice. */
export type ClosedFund = { ticker: string; closed: string; source: string };

/**
 * The brand's CLOSED_FUNDS entry for a ticker, or null. A closed fund is never fetched, never guarded and never reported failed: it keeps
 * its last published data and its index row carries `status: 'closed'`, `closedDate` and `closedSource`. A malformed entry throws, so a
 * typo (no ISO date, no https source) never ships.
 */
export function closedFund(list: ReadonlyArray<ClosedFund>, ticker: unknown): ClosedFund | null {
  const wanted = String(ticker === null || ticker === undefined ? '' : ticker).trim().toUpperCase();
  let found: ClosedFund | null = null;
  for (let i = 0; i < list.length; i++) {
    const fund = list[i];
    if (!/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(fund.ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(fund.closed) || !/^https:\/\/\S+$/.test(fund.source)) throw new Error(`CLOSED_FUNDS: ${fund.ticker} needs an upper-case ticker, an ISO closing date and an https source`);
    if (fund.ticker === wanted) found = fund;
  }
  return found;
}

/** The index rows with every closed fund marked (`status: 'closed'`, `closedDate`, `closedSource`); other rows are returned as they are. */
export function markClosedFunds<T extends object>(rows: ReadonlyArray<T>, list: ReadonlyArray<ClosedFund>): T[] {
  return rows.map((row) => {
    const fund = closedFund(list, (row as { ticker?: unknown }).ticker);
    return fund ? ({ ...row, status: 'closed', closedDate: fund.closed, closedSource: fund.source } as T) : row;
  });
}

/** A run's queue without the closed funds, which are named once in the log: they are neither fetched nor counted as failed. */
export function withoutClosedFunds<T>(queue: ReadonlyArray<T>, tickerOf: (item: T) => string, list: ReadonlyArray<ClosedFund>): T[] {
  const closed: string[] = [];
  const open: T[] = [];
  for (let i = 0; i < queue.length; i++) {
    if (closedFund(list, tickerOf(queue[i]))) closed.push(tickerOf(queue[i]));
    else open.push(queue[i]);
  }
  if (closed.length) console.log(`[ closed   ] ${closed.join(', ')}: closed by the issuer, published data kept`);
  return open;
}
// </holdings-guard>

// <nport-reader> shared block of .claude/tools/etfs/etf-std/nport-reader.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * SEC EDGAR Form N-PORT-P holdings reader (open-items etfs ETF-H2), one copy for every brand. Pure functions plus one reader
 * that takes the brand's own `getText(url, label)` (its SEC User-Agent, timeout, retries and pacing). Rules it enforces:
 * - identifiers come from the position itself: `<cusip>` text (or a `value` attribute), `<isin value>`, `<ticker value>`,
 *   `<other value>`; a derivative's reference instrument (inside `<derivativeInfo>`) never lends its identifiers to the position
 * - CUSIP `000000000` and `N/A` are missing; a missing weight or value is null (an empty cell), never 0
 * - a ticker only for a common-stock row (assetCat EC, not a CVR, right, warrant or escrow line) traded in USD with a U.S.
 *   ISIN or none, and never one ticker on two different securities (`nportTickers`)
 * - identity: the filing must name the fund's own series id, or, with no series id known, the fund's name (`nportIdentity`)
 * - freshness: the report period must be strictly newer than the published holdings (`nportIsFresh`)
 * - filings come newest report period first from the registrant's own archive folder, never from the filer agent's CIK
 *   (the accession number prefix)
 */
export type NportPosition = {
  name: string;
  title: string;
  lei: string;
  cusip: string;
  isin: string;
  ticker: string;
  other: string;
  otherDesc: string;
  balance: number | null;
  units: string;
  currency: string;
  /** valUSD, null when the filing has none */
  value: number | null;
  /** pctVal: percent of net assets (0.5 = 0.5%), null when the filing has none */
  weight: number | null;
  payoff: string;
  assetCat: string;
  issuerCat: string;
  country: string;
  /** derivCat of the position's derivativeInfo (FUT, FWD, SWP, OPT, ...), empty for a security */
  derivative: string;
  /** debtSec annualizedRt and maturityDt (ISO), null and '' for a non-debt row */
  coupon: number | null;
  maturity: string;
};

export type NportFiling = {
  seriesId: string;
  seriesName: string;
  regName: string;
  regCik: string;
  /** report period end (genInfo repPdDate) as ISO, '' when missing */
  repPdDate: string;
  netAssets: number | null;
  totalAssets: number | null;
  positions: NportPosition[];
};

export type NportCandidate = { accession: string; filed: string; period: string; cik: string };
export type NportSeriesRef = { cik: string; seriesId: string; classId: string };

/** XML text: entities decoded, tags dropped, whitespace collapsed. */
function nportText(raw: string): string {
  return String(raw)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m: string, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m: string, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();
}

/** Text of the first `<tag>` (any namespace prefix) in `xml`, '' when absent. */
function nportTag(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${tag}>`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** The `attribute` of the first `<tag ...>` (any namespace prefix) in `xml`, '' when absent. */
function nportAttr(xml: string, tag: string, attribute: string): string {
  const match = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${tag}\\s[^>]*?\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(xml);
  return match ? nportText(match[1]) : '';
}

/** A plain decimal or exponent number, null for an empty, N/A or broken cell. */
function nportNumber(raw: string): number | null {
  const text = String(raw).replace(/[\s,]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** An identifier code, '' for N/A, NONE and all zeros (CUSIP 000000000 means "no CUSIP"). */
function nportCode(raw: string): string {
  const text = String(raw).trim().toUpperCase();
  return !text || /^(N\/?A|NONE|-+|0+)$/.test(text) ? '' : text;
}

/** ISO date of an N-PORT date (YYYY-MM-DD, possibly with a time), '' otherwise. */
function nportIso(raw: unknown): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw === null || raw === undefined ? '' : raw).trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

/** One N-PORT-P primary_doc.xml (or the full submission .txt that embeds it) as series facts and positions. */
export function parseNportFiling(xml: string): NportFiling {
  const text = String(xml === null || xml === undefined ? '' : xml);
  const genInfo = /<(?:[A-Za-z0-9_.-]+:)?genInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?genInfo>/i.exec(text);
  const fundInfo = /<(?:[A-Za-z0-9_.-]+:)?fundInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?fundInfo>/i.exec(text);
  const gen = genInfo ? genInfo[1] : '';
  const fund = fundInfo ? fundInfo[1].replace(/<(?:[A-Za-z0-9_.-]+:)?returnInfo\b[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?returnInfo>/gi, ' ') : '';
  const positions: NportPosition[] = [];
  const blocks = /<(?:[A-Za-z0-9_.-]+:)?invstOrSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?invstOrSec>/gi;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(text)) !== null) {
    const raw = block[1];
    const derivativeInfo = /<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/i.exec(raw);
    // The reference instrument of a derivative (SPY for a SPY option, a bond for a CDS) is another security: drop it first.
    const own = raw.replace(/<(?:[A-Za-z0-9_.-]+:)?derivativeInfo\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_.-]+:)?derivativeInfo>/gi, ' ');
    const identifiers = /<(?:[A-Za-z0-9_.-]+:)?identifiers\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?identifiers>/i.exec(own);
    const ids = identifiers ? identifiers[1] : '';
    const debt = /<(?:[A-Za-z0-9_.-]+:)?debtSec\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?debtSec>/i.exec(own);
    const name = nportTag(own, 'name');
    positions.push({
      name: name && !/^N\/?A$/i.test(name) ? name : nportTag(own, 'title'),
      title: nportTag(own, 'title'),
      lei: nportCode(nportTag(own, 'lei')),
      cusip: nportCode(nportTag(own, 'cusip') || nportAttr(ids, 'cusip', 'value')),
      isin: nportCode(nportAttr(ids, 'isin', 'value')),
      ticker: nportCode(nportAttr(ids, 'ticker', 'value')),
      other: nportCode(nportAttr(ids, 'other', 'value')),
      otherDesc: nportAttr(ids, 'other', 'otherDesc'),
      balance: nportNumber(nportTag(own, 'balance')),
      units: nportTag(own, 'units'),
      currency: (nportTag(own, 'curCd') || nportAttr(own, 'currencyConditional', 'curCd')).toUpperCase(),
      value: nportNumber(nportTag(own, 'valUSD')),
      weight: nportNumber(nportTag(own, 'pctVal')),
      payoff: nportTag(own, 'payoffProfile'),
      assetCat: (nportTag(own, 'assetCat') || nportAttr(own, 'assetConditional', 'assetCat')).toUpperCase(),
      issuerCat: (nportTag(own, 'issuerCat') || nportAttr(own, 'issuerConditional', 'issuerCat')).toUpperCase(),
      country: nportTag(own, 'invCountry').toUpperCase(),
      derivative: derivativeInfo ? (/\bderivCat\s*=\s*"([^"]*)"/i.exec(derivativeInfo[1]) || ['', 'OTHER'])[1].toUpperCase() : '',
      coupon: debt ? nportNumber(nportTag(debt[1], 'annualizedRt')) : null,
      maturity: debt ? nportIso(nportTag(debt[1], 'maturityDt')) : '',
    });
  }
  return {
    seriesId: nportTag(gen, 'seriesId').toUpperCase(),
    seriesName: nportTag(gen, 'seriesName'),
    regName: nportTag(gen, 'regName'),
    regCik: nportTag(gen, 'regCik').replace(/\D/g, ''),
    repPdDate: nportIso(nportTag(gen, 'repPdDate')),
    netAssets: nportNumber(nportTag(fund, 'netAssets')),
    totalAssets: nportNumber(nportTag(fund, 'totAssets')),
    positions,
  };
}

/**
 * A number as sheet text: '' for null, no exponent, at most `digits` decimals (trailing zeros dropped), and no binary float
 * artifact: `115797518.01` stays `115797518.01`, not the `115797518.01000001` of `toFixed(8)`.
 */
export function nportCell(value: number | null, digits = 8): string {
  if (value === null || !Number.isFinite(value)) return '';
  const fixed = value.toFixed(digits);
  // the shortest text of the rounded number; toFixed only where that text would be an exponent (very small or large numbers)
  const shortest = String(Number(fixed));
  if (!/e/i.test(shortest)) return shortest;
  return fixed.indexOf('.') < 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
}

/** The position's own identifier for a sheet: CUSIP, else ISIN, else the "other" code (a Bloomberg or internal id), else ''. */
export function nportIdentifier(position: NportPosition): string {
  return position.cusip || position.isin || position.other;
}

/**
 * A company name as a lookup key: upper case, punctuation and legal suffixes dropped, `CLASS A` -> `CL A`. Initials are one
 * word whether written with dots, spaces or a slash (`N.V.` = `N V` = `NV`, `C.H. ROBINSON` = `C H ROBINSON`, `A/S` = `A S`,
 * `S.A.B. de C.V.` = `SAB DE CV`), `PUBLIC LIMITED COMPANY` is `plc`, and a leading `US` stays (`U.S. BANCORP` is not
 * `BANCORP, INC.`), so both spellings of one issuer give one key.
 */
export function nportNameKey(value: unknown): string {
  // EDGAR adds a state or qualifier suffix to company titles ("COSTCO WHOLESALE CORP /NEW", "BANK OF AMERICA CORP /DE/",
  // "US BANCORP \DE\", "ACUITY INC. (DE)"): drop a trailing one
  const raw = String(value === null || value === undefined ? '' : value).replace(/(?:\s*(?:[\/\\]\s*[A-Za-z]{2,3}\s*[\/\\]?|\(\s*[A-Za-z]{2,3}\s*\)))+\s*$/, '');
  let text = nportText(raw).toUpperCase().replace(/['’]/g, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  text = text.replace(/\bCLASS\s+([A-Z])\b/g, 'CL $1').replace(/\bCL\s+([A-Z])\b/g, 'CL $1');
  // a run of single letters is one word, never the class letter after CL
  const words: string[] = [];
  let joining = false;
  text.split(' ').forEach((word) => {
    const letter = /^[A-Z]$/.test(word);
    if (letter && joining) words[words.length - 1] += word;
    else words.push(word);
    joining = letter && (joining || words[words.length - 2] !== 'CL');
  });
  text = words.join(' ').replace(/\bPUBLIC (?:(?:LIMITED|LTD)(?: (?:COMP[A-Z]*|CO))?|(?:COMPANY|CO) (?:LIMITED|LTD))\b/g, 'PLC').replace(/\b(?:S DE RL )?DE CV\b/g, ' ');
  const share = /\bCL [A-Z]\b/.exec(text);
  text = text.replace(/\b(THE|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|PLC|SA|SAB|NV|AG|SE|SPA|AS|ASA|ORDINARY|COMMON|STOCK|SHS|SHARES|ADR|DEPOSITARY|RECEIPT|USD|US|REG|REGISTERED)\b/g, (word: string, _name: string, at: number) => (word === 'US' && at === 0 ? word : ' ')).replace(/\s+/g, ' ').trim();
  if (share && !/\bCL [A-Z]\b/.test(text)) text = `${text} ${share[0]}`;
  return text;
}

/** SEC company_tickers.json -> name key -> ticker (the first, largest company wins a shared key; the class-less key is added too). */
export function parseSecCompanyNames(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const rows = payload && typeof payload === 'object' ? Object.keys(payload as object).map((key) => (payload as Record<string, unknown>)[key]) : [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as { ticker?: unknown; title?: unknown } | null;
    if (!row || typeof row !== 'object') continue;
    const ticker = String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
    const key = nportNameKey(row.title);
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) || !key) continue;
    if (!names.has(key)) names.set(key, ticker);
    const core = key.replace(/ CL [A-Z]$/, '');
    if (core && !names.has(core)) names.set(core, ticker);
  }
  return names;
}

/** SEC company_tickers_mf.json -> fund ticker -> registrant CIK (10 digits), series id, class id. */
export function parseSecFundTickers(payload: unknown): Map<string, NportSeriesRef> {
  const map = new Map<string, NportSeriesRef>();
  const record = (payload && typeof payload === 'object' ? payload : {}) as { fields?: unknown; data?: unknown };
  const fields = Array.isArray(record.fields) ? record.fields.map(String) : [];
  const rows = Array.isArray(record.data) ? record.data : [];
  const at = (row: unknown[], field: string): string => (fields.indexOf(field) < 0 ? '' : String(row[fields.indexOf(field)] === null || row[fields.indexOf(field)] === undefined ? '' : row[fields.indexOf(field)]).trim());
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const ticker = at(row, 'symbol').toUpperCase();
    const cik = at(row, 'cik').replace(/\D/g, '');
    const seriesId = at(row, 'seriesId').toUpperCase();
    if (!ticker || !Number(cik) || !/^S\d{9}$/.test(seriesId) || map.has(ticker)) continue;
    map.set(ticker, { cik: `0000000000${Number(cik)}`.slice(-10), seriesId, classId: at(row, 'classId').toUpperCase() });
  }
  return map;
}

/**
 * Is the row a contingent value right, a right, a warrant or an escrow line filed as equity? A placeholder CUSIP or ISIN
 * (`436CVR021`, `US009CVR0445`, `549ESC028`, `866CNT017`) says so; so does the name or title (`NOVO NORDISK A/S - CVR`,
 * `XYZ INC RIGHTS`, `... WARRANT FEB 2026`, `Luby's Inc Escrow`), except on a CUSIP with the common-stock issue number 10
 * (Schwab titles Enovix common stock 293594107 "Enovix Corp Warrants"). `CVR` as the first word is a company (CVR Energy).
 */
function nportIsRight(position: NportPosition): boolean {
  if (/^[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.cusip) || /^US[0-9A-Z]{3}(?:CVR|ESC|CNT)/.test(position.isin)) return true;
  if (/^[0-9A-Z]{6}10[0-9]$/.test(position.cusip)) return false;
  return [position.name, position.title].some((text) => /\S\s*\bCVRS?\b|\bCONTINGENT\b|\bRIGHTS?\b|\bRTS\b|\bWARRANTS?\b|\bWTS\b|\bESCROW\b/i.test(text));
}

/**
 * Exchange tickers for the positions, in their order ('' for none). A ticker is given only to a common-stock row (assetCat
 * EC; a preferred EP, a CVR, right, warrant or escrow line gets none, a name match would give it the issuer's common ticker)
 * traded in USD (or with no currency) whose ISIN is U.S. or missing: first the filer's own `<ticker value>`, else the
 * SEC issuer-name table (`names`) when the row has a CUSIP or a U.S. ISIN. A ticker that lands on two different securities
 * (Alphabet A and C, an ordinary share and its ADR) is dropped from the name-matched rows; when the filer itself gave it
 * to two securities it is dropped from all of them. Bonds, cash, funds and derivatives stay identifier-keyed.
 */
export function nportTickers(positions: ReadonlyArray<NportPosition>, names: Map<string, string> | null = null): string[] {
  const fromFiler: boolean[] = [];
  const tickers = positions.map((position, index) => {
    fromFiler[index] = false;
    const equity = position.assetCat === 'EC' && !position.derivative && !nportIsRight(position);
    const usd = !position.currency || position.currency === 'USD';
    if (!equity || !usd || (position.isin && position.isin.slice(0, 2) !== 'US')) return '';
    if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(position.ticker)) {
      fromFiler[index] = true;
      return position.ticker;
    }
    if (!names || !(/^[0-9A-Z]{9}$/.test(position.cusip) || /^US[0-9A-Z]{10}$/.test(position.isin))) return '';
    const key = nportNameKey(position.name);
    return names.get(key) || names.get(key.replace(/ CL [A-Z]$/, '')) || '';
  });
  const securities = new Map<string, { keys: string[]; filer: string[] }>();
  tickers.forEach((ticker, index) => {
    if (!ticker) return;
    const position = positions[index];
    const key = position.cusip || position.isin || position.other || nportNameKey(position.name);
    const seen = securities.get(ticker) || { keys: [], filer: [] };
    if (seen.keys.indexOf(key) < 0) seen.keys.push(key);
    if (fromFiler[index] && seen.filer.indexOf(key) < 0) seen.filer.push(key);
    securities.set(ticker, seen);
  });
  return tickers.map((ticker, index) => {
    const seen = ticker ? securities.get(ticker) : undefined;
    if (!seen || seen.keys.length < 2) return ticker;
    return seen.filer.length === 1 && fromFiler[index] ? ticker : '';
  });
}

/** The browse-edgar Atom feed of one series' NPORT-P filings. */
export function nportSeriesFeedUrl(seriesId: string, count = 10): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(String(seriesId).toUpperCase())}&type=NPORT-P&dateb=&owner=include&count=${count}&output=atom`;
}

/** The registrant's submissions JSON (report periods of its recent filings). */
export function nportSubmissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${`0000000000${Number(String(cik).replace(/\D/g, '')) || 0}`.slice(-10)}.json`;
}

/** primary_doc.xml of a filing in the registrant's own folder. Throws without a registrant CIK: the accession prefix is the filer agent. */
export function nportDocumentUrl(registrantCik: string, accession: string): string {
  const cik = Number(String(registrantCik).replace(/\D/g, ''));
  if (!cik) throw new Error(`N-PORT ${accession}: no registrant CIK (the accession prefix is the filer agent, never used as the folder)`);
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${String(accession).replace(/-/g, '')}/primary_doc.xml`;
}

/** NPORT-P entries of a browse-edgar Atom feed (amendments and other forms skipped), with the registrant CIK of the filing link. */
export function parseNportFeed(atom: string): NportCandidate[] {
  const out: NportCandidate[] = [];
  const entries = /<entry>([\s\S]*?)<\/entry>/gi;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(String(atom === null || atom === undefined ? '' : atom))) !== null) {
    const body = entry[1];
    const form = (nportTag(body, 'filing-type') || nportAttr(body, 'category', 'term')).toUpperCase();
    const accession = nportTag(body, 'accession-number');
    if (form !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    const folder = /\/Archives\/edgar\/data\/(\d+)\//i.exec(nportTag(body, 'filing-href'));
    out.push({ accession, filed: nportIso(nportTag(body, 'filing-date')), period: nportIso(nportTag(body, 'period')), cik: folder ? folder[1] : '' });
  }
  return out;
}

/** NPORT-P filings of a registrant's submissions JSON (`filings.recent`), with report periods; the registrant is the JSON's own CIK. */
export function parseNportSubmissions(payload: unknown): NportCandidate[] {
  const record = (payload && typeof payload === 'object' ? payload : {}) as { cik?: unknown; filings?: { recent?: Record<string, unknown> } };
  const recent = record.filings && record.filings.recent ? record.filings.recent : {};
  const column = (name: string): unknown[] => (Array.isArray(recent[name]) ? (recent[name] as unknown[]) : []);
  const forms = column('form'), accessions = column('accessionNumber'), filed = column('filingDate'), periods = column('reportDate');
  const cik = String(record.cik === null || record.cik === undefined ? '' : record.cik).replace(/\D/g, '');
  const out: NportCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const accession = String(accessions[i] === null || accessions[i] === undefined ? '' : accessions[i]);
    if (String(forms[i]).toUpperCase() !== 'NPORT-P' || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) continue;
    out.push({ accession, filed: nportIso(filed[i]), period: nportIso(periods[i]), cik });
  }
  return out;
}

/**
 * Candidates newest report period first, then newest filing: a late filing for an older period never wins. A missing
 * period is taken from `known` (the registrant's submissions) by accession; candidates still without one go last.
 */
export function nportNewestFirst(candidates: ReadonlyArray<NportCandidate>, known: ReadonlyArray<NportCandidate> = []): NportCandidate[] {
  const periods = new Map<string, string>();
  for (let i = 0; i < known.length; i++) if (known[i].period) periods.set(known[i].accession, known[i].period);
  return candidates
    .map((candidate) => (candidate.period ? candidate : { ...candidate, period: periods.get(candidate.accession) || '' }))
    .sort((a, b) => (a.period && b.period ? b.period.localeCompare(a.period) : a.period ? -1 : b.period ? 1 : 0) || b.filed.localeCompare(a.filed));
}

/**
 * Does the filing belong to the fund? With a series id: only the same series id. Without one: the normalized series name
 * equals the fund name, or (`loose`, reported to the caller) one contains the other. Returns the problem, or null.
 */
export function nportIdentity(filing: Pick<NportFiling, 'seriesId' | 'seriesName'>, fund: { seriesId?: string | null; name?: string | null }): { problem: string | null; loose: boolean } {
  const wantedSeries = String(fund.seriesId || '').trim().toUpperCase();
  if (wantedSeries) return { problem: filing.seriesId === wantedSeries ? null : `names series ${filing.seriesId || 'none'}, not ${wantedSeries}`, loose: false };
  const filed = nportNameKey(filing.seriesName), wanted = nportNameKey(fund.name);
  if (!filed || !wanted) return { problem: 'no series id and no fund name to match', loose: false };
  if (filed === wanted) return { problem: null, loose: false };
  if (filed.indexOf(wanted) >= 0 || wanted.indexOf(filed) >= 0) return { problem: null, loose: true };
  return { problem: `names series "${filing.seriesName}", not "${String(fund.name)}"`, loose: false };
}

/**
 * May a filing replace the published holdings? Nothing published (no rows): any dated or undated report. Otherwise only a
 * report period strictly newer than the published holdings date; both must be ISO dates (convert the brand's display
 * date first), an unknown date on either side keeps the published sheet.
 */
export function nportIsFresh(repPdDate: unknown, publishedAsOf: unknown, publishedRows: unknown): boolean {
  if (!(Number(publishedRows) > 0)) return true;
  const report = nportIso(repPdDate), published = nportIso(publishedAsOf);
  return Boolean(report && published && String(publishedAsOf).trim().length === 10 && report > published);
}

export type NportRead = { filing: NportFiling; candidate: NportCandidate; url: string; loose: boolean } | { problem: string };

/**
 * The newest N-PORT-P filing of one fund, or why there is none. Candidates: the series' Atom feed (when a series id is known;
 * an empty feed means no filing yet) with periods from the registrant's submissions, else (no series id, or the feed failed)
 * the registrant's NPORT-P filings themselves; newest period first.
 * Documents are read until one passes the identity check (at most `maxDocuments`); that newest own filing is returned only
 * when it is fresh against the published holdings (`published.asOf` ISO, `published.rows`). Errors of the optional
 * submissions request are tolerated; others come back as `problem`. `cache` (one Map per run) keeps the submissions and
 * the parsed documents, so funds of one registrant share requests.
 */
export async function readNportHoldings(
  fund: { ticker: string; cik: string; seriesId?: string | null; name?: string | null },
  published: { asOf?: unknown; rows?: unknown },
  getText: (url: string, label: string) => Promise<string>,
  options: { maxDocuments?: number; cache?: Map<string, unknown> } = {},
): Promise<NportRead> {
  const cache = options.cache || new Map<string, unknown>();
  const once = async <T>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load().catch((error: unknown) => { cache.delete(key); throw error; }));
    return (await cache.get(key)) as T;
  };
  const cik = String(fund.cik || '').replace(/\D/g, '');
  if (!Number(cik)) return { problem: `${fund.ticker}: no registrant CIK` };
  let known: NportCandidate[] = [];
  try {
    known = await once(`submissions:${Number(cik)}`, async () => parseNportSubmissions(JSON.parse(await getText(nportSubmissionsUrl(cik), `${fund.ticker} N-PORT periods`))));
  } catch {
    known = [];
  }
  // null: no series feed (no series id, or the feed failed), so the registrant's own NPORT-P filings are scanned instead
  let candidates: NportCandidate[] | null = null;
  try {
    if (fund.seriesId) candidates = parseNportFeed(await getText(nportSeriesFeedUrl(fund.seriesId), `${fund.ticker} N-PORT filings`));
  } catch (error) {
    if (!known.length) return { problem: `${fund.ticker}: N-PORT filings unavailable (${error instanceof Error ? error.message : String(error)})` };
  }
  const sorted = nportNewestFirst(candidates || known, known);
  if (!sorted.length) return { problem: `${fund.ticker}: no NPORT-P filing yet` };
  const limit = Math.max(1, options.maxDocuments || (candidates ? 3 : 12));
  const misses: string[] = [];
  for (let i = 0; i < sorted.length && i < limit; i++) {
    const candidate = sorted[i];
    const url = nportDocumentUrl(Number(candidate.cik) ? candidate.cik : cik, candidate.accession);
    let filing: NportFiling;
    try {
      filing = await once(`document:${url}`, async () => parseNportFiling(await getText(url, `${fund.ticker} N-PORT ${candidate.accession}`)));
    } catch (error) {
      misses.push(`${candidate.accession} unreadable (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    const identity = nportIdentity(filing, fund);
    if (identity.problem) {
      misses.push(`${candidate.accession} ${identity.problem}`);
      continue;
    }
    if (!filing.positions.length) return { problem: `${fund.ticker}: ${candidate.accession} has no positions` };
    if (!nportIsFresh(filing.repPdDate, published.asOf, published.rows)) return { problem: `${fund.ticker}: N-PORT ${filing.repPdDate || 'undated'} is not newer than the published holdings (${String(published.asOf || 'undated')})` };
    return { filing, candidate, url, loose: identity.loose };
  }
  return { problem: `${fund.ticker}: no N-PORT-P filing of its own${misses.length ? `: ${misses.join('; ')}` : ''}` };
}
// </nport-reader>

// <calendar-dates> shared block of .claude/tools/etfs/etf-std/calendar-dates.block.ts, applied by apply-block.ts: never edit it in one repo
/**
 * A calendar date as ISO `YYYY-MM-DD`, or null. Pure text work, never `Date.parse` or local getters, so a run in Tokyo
 * publishes the same day as CI (open-items etfs ETF-H4). Accepts ISO (`2026-10-24`, with a time the date part is kept as
 * written), `2026/10/24`, U.S. `10/24/2026` and `10-24-26` (two-digit years up to 69 are 20xx), month names in either order
 * (`Oct 24, 2026`, `October 24 2026`, `Sept. 30, 2026`, `24 Oct 2026`, `24-Oct-26`), an optional weekday or `as of` in front.
 * A day that does not exist (`02/30/2026`) is null.
 */
export function calendarIso(value: unknown): string | null {
  const text = String(value === null || value === undefined ? '' : value).replace(/[\s ]+/g, ' ').trim()
    .replace(/^as of:? /i, '').replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,? /i, '');
  const year = (raw: string): number => (raw.length === 2 ? (Number(raw) <= 69 ? 2000 : 1900) + Number(raw) : Number(raw));
  const month = (raw: string): number => {
    const word = raw.toLowerCase();
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    for (let i = 0; i < names.length; i++) if (word.length >= 3 && names[i].indexOf(word) === 0) return i + 1;
    return 0;
  };
  let y = 0, m = 0, d = 0, match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text)) || (match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = Number(match[1]); d = Number(match[2]);
  } else if ((match = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text))) {
    y = Number(match[3]); m = month(match[1]); d = Number(match[2]);
  } else if ((match = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?[ -](\d{4}|\d{2})$/.exec(text))) {
    y = year(match[3]); m = month(match[2]); d = Number(match[1]);
  } else {
    return null;
  }
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return null;
  return `${y}-${m < 10 ? '0' : ''}${m}-${d < 10 ? '0' : ''}${d}`;
}

/**
 * Is the fund at least `years` old on `asOf`? Calendar anniversary, inclusive: a fund started 2025-10-24 is one year old on
 * 2026-10-24 (a 29 February start on 1 March). Unknown or unreadable dates answer true, so a value is never dropped for want
 * of a date. The shared "younger than one year" rule: since-inception returns are annualized only from one year on.
 */
export function fundAgeAtLeast(inception: unknown, asOf: unknown, years: number): boolean {
  const start = calendarIso(inception), end = calendarIso(asOf);
  if (!start || !end) return true;
  return end >= `${Number(start.slice(0, 4)) + years}${start.slice(4)}`;
}

/**
 * The returns with every horizon the fund is too young for set to null: `horizons` maps a key of `returns` to the years it
 * needs (`{ yr1: 1, cagr3y: 3, siAnn: 1 }`). Keys that are absent or already null stay as they are; the object is copied.
 */
export function withoutYoungReturns<T extends object>(returns: T, inception: unknown, asOf: unknown, horizons: Record<string, number>): T {
  const out: Record<string, unknown> = { ...(returns as Record<string, unknown>) };
  const keys = Object.keys(horizons);
  for (let i = 0; i < keys.length; i++) {
    if (out[keys[i]] !== undefined && out[keys[i]] !== null && !fundAgeAtLeast(inception, asOf, horizons[keys[i]])) out[keys[i]] = null;
  }
  return out as T;
}
// </calendar-dates>

// <windowed-chart> shared block of .claude/tools/etfs/etf-std/windowed-chart.block.ts, applied by apply-block.ts: never edit it in one repo
export type WindowedChartDay = { date: string; close: number; adjClose: number; volume: number; adjCloseRaw?: number };
export type WindowedChartDividend = { epoch: number; amount: number };

/**
 * A HISTORY_RANGE window (`period1` N years back) never shrinks the published history, and with it the 3y, 5y, 10y and
 * since-inception returns (open-items etfs Q25; was a byte-identical copy in Fidelity, Invesco and JPMorgan). The published
 * rows older than the first fresh day are put in front of the fresh days; their Adj Close is rescaled by the ratio measured on
 * the overlapping days (Yahoo re-adjusts the whole series after each distribution). Published distributions older than the
 * window are kept as well. Returns the chart unchanged when nothing published is older, and null when the window cannot be
 * joined safely (no overlap, Close changed, inconsistent or implausible ratio): the caller then keeps the fund as published.
 * `published` rows carry `Date` (any calendarIso form), `Close`, `Adj Close`, `Volume`; distribution rows are
 * [date, amount, ...] arrays. The chart's days must be sorted by ISO date.
 */
export function mergeWindowedChart<C extends { days: WindowedChartDay[]; dividends: WindowedChartDividend[] }>(chart: C, published: ReadonlyArray<Record<string, unknown>>, publishedDistributions: ReadonlyArray<unknown> = []): C | null {
  if (!chart.days.length || !published.length) return chart;
  const num = (value: unknown): number | null => {
    const text = String(value === null || value === undefined ? '' : value).replace(/[\s,$]/g, '');
    return text && Number.isFinite(Number(text)) ? Number(text) : null;
  };
  const firstFresh = chart.days[0].date;
  const rows: Array<{ date: string; close: number; adjClose: number; volume: number }> = [];
  for (let i = 0; i < published.length; i++) {
    const date = calendarIso(published[i].Date), close = num(published[i].Close), adjClose = num(published[i]['Adj Close']);
    if (date && close !== null && adjClose !== null && adjClose > 0) rows.push({ date, close, adjClose, volume: num(published[i].Volume) || 0 });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const older = rows.filter((row) => row.date < firstFresh);
  if (!older.length) return chart;
  const byDate = new Map<string, { close: number; adjClose: number }>();
  for (let i = 0; i < rows.length; i++) byDate.set(rows[i].date, rows[i]);
  const adjRatios: number[] = [];
  const closeRatios: number[] = [];
  for (let i = 0; i < chart.days.length; i++) {
    const day = chart.days[i];
    const prior = byDate.get(day.date);
    if (!prior) continue;
    adjRatios.push((day.adjCloseRaw === undefined ? day.adjClose : day.adjCloseRaw) / prior.adjClose);
    if (prior.close > 0) closeRatios.push(day.close / prior.close);
  }
  if (!adjRatios.length) return null;
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  if (closeRatios.length && Math.abs(mean(closeRatios) - 1) > 1e-3) return null;
  if (Math.max.apply(null, adjRatios) / Math.min.apply(null, adjRatios) - 1 > 5e-3) return null;
  const measured = mean(adjRatios);
  if (measured < 0.5 || measured > 1.001) return null;
  const factor = Math.abs(measured - 1) < 1e-4 ? 1 : measured;
  const days: WindowedChartDay[] = older.map((row) => {
    const raw = row.adjClose * factor;
    return { date: row.date, close: row.close, adjClose: factor === 1 ? row.adjClose : Math.round(raw * 100) / 100, volume: row.volume, adjCloseRaw: raw };
  });
  const firstFreshEpoch = Date.UTC(Number(firstFresh.slice(0, 4)), Number(firstFresh.slice(5, 7)) - 1, Number(firstFresh.slice(8, 10))) / 1000;
  const kept: WindowedChartDividend[] = [];
  for (let i = 0; i < publishedDistributions.length; i++) {
    const cells = publishedDistributions[i];
    const date = Array.isArray(cells) ? calendarIso(cells[0]) : null;
    const amount = Array.isArray(cells) ? num(cells[1]) : null;
    if (!date || amount === null || amount <= 0) continue;
    const epoch = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 1000;
    if (epoch < firstFreshEpoch) kept.push({ epoch, amount });
  }
  kept.sort((a, b) => a.epoch - b.epoch);
  return { ...chart, days: days.concat(chart.days), dividends: kept.concat(chart.dividends.filter((dividend) => dividend.epoch >= firstFreshEpoch)) };
}
// </windowed-chart>

// <fund-selection> shared block of .claude/tools/etfs/etf-std/fund-selection.block.ts, applied by apply-block.ts: never edit it in one repo
/** An index row as far as these helpers read it: the ticker and whether it has published data (`dataFile`, null for a catalog-only row). */
export type FundSelectionRow = { ticker?: unknown; dataFile?: unknown };

function fundSelectionTicker(row: FundSelectionRow): string {
  return String(row.ticker === null || row.ticker === undefined ? '' : row.ticker).trim().toUpperCase();
}

/**
 * The tickers a TICKERS entry may name: the live catalog plus every fund with published data (closed funds included). When
 * the live catalog could not be read (`live` null) every previous index row counts, since nothing tells a real catalog-only
 * row from a stale one. A catalog-only row from an earlier mistyped TICKERS run is therefore not "known" (open-items etfs Q27).
 */
export function knownTickers(live: ReadonlyArray<string> | null, previous: ReadonlyArray<FundSelectionRow>): string[] {
  const out: string[] = [];
  const add = (ticker: string): void => { if (ticker && out.indexOf(ticker) < 0) out.push(ticker); };
  if (live) for (let i = 0; i < live.length; i++) add(String(live[i]).trim().toUpperCase());
  for (let i = 0; i < previous.length; i++) if (!live || previous[i].dataFile) add(fundSelectionTicker(previous[i]));
  return out;
}

/** Throws before any fund request when TICKERS names a fund outside `known` (see knownTickers): a clear error, nothing fetched or written. */
export function assertKnownTickers(selected: ReadonlyArray<string> | null, known: ReadonlyArray<string>, where: string): void {
  const unknown = (selected || []).map((ticker) => String(ticker).trim().toUpperCase()).filter((ticker) => ticker && known.indexOf(ticker) < 0);
  if (unknown.length) throw new Error(`TICKERS: ${unknown.join(', ')} not in ${where}; nothing was fetched or written`);
}

/**
 * The index rows without stale catalog-only rows: a row with no published data whose ticker the live catalog no longer lists
 * (an earlier mistyped TICKERS entry, a fund withdrawn before launch). Rows with data always stay; nothing is dropped when the
 * live catalog could not be read (`live` null).
 */
export function withoutStalePlaceholders<T extends FundSelectionRow>(rows: ReadonlyArray<T>, live: ReadonlyArray<string> | null): T[] {
  if (!live) return rows.slice();
  const listed = live.map((ticker) => String(ticker).trim().toUpperCase());
  return rows.filter((row) => Boolean(row.dataFile) || listed.indexOf(fundSelectionTicker(row)) >= 0);
}

/**
 * New funds of a run (open-items etfs Q28): `published` - first published in this run (the previous index had no row for it,
 * or only a catalog-only one), so a fund whose first read failed is announced when it finally succeeds; `pending` - new in the
 * catalog this run but not published yet. Nothing is reported on a first run (empty previous index).
 */
export function newFundsReport(previous: ReadonlyArray<FundSelectionRow>, next: ReadonlyArray<FundSelectionRow>): { published: string[]; pending: string[] } {
  const report = { published: [] as string[], pending: [] as string[] };
  if (!previous.length) return report;
  const before = new Map<string, boolean>();
  for (let i = 0; i < previous.length; i++) before.set(fundSelectionTicker(previous[i]), Boolean(previous[i].dataFile));
  for (let i = 0; i < next.length; i++) {
    const ticker = fundSelectionTicker(next[i]);
    if (!ticker || before.get(ticker)) continue;
    if (next[i].dataFile) report.published.push(ticker);
    else if (!before.has(ticker)) report.pending.push(ticker);
  }
  report.published.sort();
  report.pending.sort();
  return report;
}

/** The log and step-summary lines of a newFundsReport: `NEW FUNDS: A, B` and `NEW FUNDS (not published yet): C`; none when empty. */
export function newFundsLines(report: { published: ReadonlyArray<string>; pending: ReadonlyArray<string> }): string[] {
  const lines: string[] = [];
  if (report.published.length) lines.push(`NEW FUNDS: ${report.published.join(', ')}`);
  if (report.pending.length) lines.push(`NEW FUNDS (not published yet): ${report.pending.join(', ')}`);
  return lines;
}
// </fund-selection>
