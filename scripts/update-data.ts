#!/usr/bin/env bun

// Fidelity ETF static data updater.
// Fetches official SEC EDGAR N-PORT-P holdings filings for the Fidelity ETF
// trusts and daily market/NAV history plus distributions from the public
// Yahoo Finance chart API, then writes a deterministic, paginated static
// JSON API under ./api/fidelity, following the daggerok/iShares and
// daggerok/SPDR repository design (no dependencies, Bun only).

import { mkdir, readFile, writeFile, readdir, rm, appendFile } from 'node:fs/promises';
import { FIDELITY_FUNDS, FIDELITY_TRUSTS } from './fidelity-funds';
import { HELD_TICKERS } from './held-tickers';

// ---------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, any>;

const SEC_DATA_HOST = 'https://data.sec.gov';
const EDGAR_ARCHIVES = 'https://www.sec.gov/Archives/edgar/data';
// Yahoo symbol-search endpoint used to resolve holding names that the static
// name -> ticker seed (scripts/held-tickers.ts) does not cover yet.
const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';
// SEC requires a declared User-Agent for automated access:
// https://www.sec.gov/os/accessing-edgar-data
// SEC's WAF accepts the strict "Company Name contact@domain" shape: no
// parentheses, no URLs. Override with SEC_UA when running from CI.
const SEC_UA_DEFAULT = 'DaggerOk Fidelity Feed admin@daggerok.example.com';
const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const API_ROOT = new URL('../api/fidelity/', import.meta.url);
const INDEX_FILE = new URL('index.json', API_ROOT);
const STATE_FILE = new URL('update-state.json', API_ROOT);

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

// "2.97057744E8" -> "297057744"; keeps non-numeric text untouched (same as SPDR).
export function normalizeNumberText(raw: unknown): string {
  const text = String(raw ?? '').trim();
  if (text === '' || text === '-') return text;
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.replace(/,/g, ''))) return text;
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(number) || Math.abs(number) >= 1e21) return text;
  return number.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 10 });
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

function readConfig(env: Record<string, string | undefined> = process.env): UpdaterConfig {
  return {
    concurrency: parsePositiveInt(envValue(env, 'CONCURRENCY'), CONCURRENCY_FALLBACK),
    requestSleep: parseNonNegativeFloat(envValue(env, 'REQUEST_SLEEP'), REQUEST_SLEEP_FALLBACK),
    maxFetches: parsePositiveInt(envValue(env, 'MAX_FETCHES', ['FIDELITY_LIMIT']), 0),
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

const USAGE = `
Fidelity ETF static data updater (Bun, no dependencies).

  bun ./scripts/update-data.ts            update ./api/fidelity from SEC EDGAR + Yahoo
  ./scripts/update-data.ts --backfill-tickers
                                          offline: stamp real exchange tickers from
                                          scripts/held-tickers.ts into already
                                          generated holdings data (no network)
  ./scripts/update-data.ts -h | --help    print this help

Environment variables (all optional; strict "min:max" ranges; AND logic):

  MAX_FETCHES          Batch size: continue after the ticker cursor saved in
                       api/fidelity/update-state.json. Empty or 0 means all.
                       Legacy alias: FIDELITY_LIMIT.
  REQUEST_SLEEP        Minimum seconds between outgoing request starts,
                       including retries (default 1). SEC allows at most 10
                       requests per second; Yahoo throttles hard, keep >= 1.
  CONCURRENCY          Parallel fund workers (default 2). Starts are still
                       globally spaced by REQUEST_SLEEP.
  MAX_RETRIES          Retries after the initial request (default 2). Only
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
  REFRESH_CATALOG      0/false to skip scanning EDGAR submissions for N-PORT
                       filings newer than the seed accessions (default on).

Holding tickers: N-PORT positions publish no exchange tickers, so the
updater fills the holdings Ticker column from the name -> ticker seed in
scripts/held-tickers.ts (SEC EDGAR company tickers + exchange symbol
directories). Names the seed does not cover yet are resolved live through
the Yahoo Finance symbol search with a strict name match; new mappings are
written back to scripts/held-tickers.ts (commit it with the data update).
Bond / private positions have no exchange ticker and keep "-".

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

let nextRequestAt = 0;
let requestSleepMs = REQUEST_SLEEP_FALLBACK * 1000;

async function paceRequests(): Promise<void> {
  const waitFor = nextRequestAt - Date.now();
  if (waitFor > 0) await sleep(waitFor);
  nextRequestAt = Date.now() + requestSleepMs;
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

export async function fetchWithRetry(
  url: string,
  label: string,
  init: RequestInit = {},
  maxRetries = 2,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceRequests();
    try {
      const response = await fetch(url, { redirect: 'follow', ...init });
      if (response.ok) return response;
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

function secHeaders(config: UpdaterConfig): Record<string, string> {
  return { 'User-Agent': config.secUa, Accept: 'application/json,*/*' };
}

function yahooHeaders(): Record<string, string> {
  return { 'User-Agent': YAHOO_BROWSER_UA, Accept: 'application/json' };
}

async function fetchText(url: string, label: string, headers: Record<string, string>, config: UpdaterConfig): Promise<string> {
  const response = await fetchWithRetry(url, label, { headers }, config.maxRetries);
  return await response.text();
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
// them from the name -> ticker seed in scripts/held-tickers.ts and, for names
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

// Memoized name -> ticker lookup over the seed plus live Yahoo searches.
// Unknown names are searched at most once per run (hits are learned into the
// index, misses are cached) and can never throw: resolution degrades to "-".
export class TickerResolver {
  private readonly byName = new Map<string, string>();
  private readonly byNorm = new Map<string, string>();
  private readonly byNormCore = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly missed = new Map<string, true>();
  readonly fresh: Array<{ name: string; ticker: string }> = [];
  private readonly search: TickerSearchFn | null;

  constructor(seed: Record<string, string>, search: TickerSearchFn | null = null) {
    this.search = search;
    for (const [name, ticker] of Object.entries(seed)) this.learn(name, ticker, false);
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

  async resolve(name: string): Promise<string> {
    const known = this.lookup(name);
    if (known) return known;
    const norm = normalizeHoldingName(name);
    if (!norm || !this.search || this.missed.has(norm)) return '-';
    const inflight = this.inFlight.get(norm) ?? (async () => {
      let symbol: string | null = null;
      try {
        symbol = await this.search(name);
      } catch {
        symbol = null; // offline/throttled: keep "-" instead of failing the fund
      }
      if (symbol) this.learn(name, symbol, true);
      else this.missed.set(norm, true);
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
}

async function attachHoldingTickers(nport: ParsedNport, resolver: TickerResolver): Promise<number> {
  let resolved = 0;
  for (const holding of nport.holdings) {
    if (holding.Ticker !== '-') continue;
    const symbol = await resolver.resolve(holding.Name);
    if (symbol !== '-') {
      holding.Ticker = symbol;
      resolved += 1;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Seed file persistence (scripts/held-tickers.ts grows with live resolutions)
// ---------------------------------------------------------------------------

const HELD_TICKERS_FILE = new URL('held-tickers.ts', import.meta.url);

export function formatHeldTickersSeed(entries: Record<string, string>): string {
  const rows = Object.entries(entries)
    .map(([name, ticker]) => [name, cleanHoldingTicker(ticker)] as const)
    .filter(([name, ticker]) => name && ticker)
    .sort((a, b) => {
      const ka = a[0].toLowerCase();
      const kb = b[0].toLowerCase();
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
  const lines = [
    '// N-PORT holding name -> exchange ticker (GENERATED FILE: do not edit by hand).',
    '//',
    '// Seeded 2026-08-26 from public data:',
    '//   - SEC EDGAR company_tickers.json (CIK/ticker/title directory, all US-listed and FPI ADRs)',
    '//   - Nasdaq Trader, NYSE and NYSE American daily symbol directories (incl. ETFs)',
    '// Keys are the holding names exactly as filed in N-PORT positions (case preserved).',
    '// scripts/update-data.ts extends this file with tickers it resolves live through the',
    '// Yahoo Finance search API (strict name match only) and commits it with the generated',
    '// api/fidelity data. Positions without an exchange ticker (bonds, private debt) are',
    '// intentionally absent: their rows keep Ticker "-" and the app falls back to CUSIP/ISIN.',
    '',
    'export const HELD_TICKERS: Record<string, string> = {',
  ];
  for (const [name, ticker] of rows) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(ticker)},`);
  lines.push('};', '');
  return lines.join('\n');
}

async function writeTextIfChanged(file: URL, value: string): Promise<boolean> {
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === value) return false;
  await writeFile(file, value, 'utf8');
  return true;
}

// ---------------------------------------------------------------------------
// SEC EDGAR layer: trust submissions + N-PORT-P primary documents
// ---------------------------------------------------------------------------

export type NportAccession = { accession: string; filed: string; reportDate: string; url: string };

function nportUrlFor(trustCik: string, accession: string): string {
  return `${EDGAR_ARCHIVES}/${Number(trustCik)}/${accession.replace(/-/g, '')}/primary_doc.xml`;
}

export function parseNportAccessions(submissions: JsonRecord): NportAccession[] {
  const recent = submissions?.filings?.recent;
  const result: NportAccession[] = [];
  if (!recent || !Array.isArray(recent.form)) return result;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== 'NPORT-P') continue;
    const accession: string = recent.accessionNumber[i];
    const filed: string = recent.filingDate[i];
    const reportDate: string = recent.reportDate[i] || '';
    result.push({ accession, filed, reportDate, url: '' });
  }
  return result;
}

function tagValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  return match ? cleanText(match[1]) : '';
}

export type NportHolding = {
  Name: string;
  Ticker: string;
  Identifier: string;
  Weight: string;
  'Market Value': string;
  'Shares Held': string;
  'Asset Category': string;
};

export type ParsedNport = {
  regName: string;
  seriesName: string;
  seriesId: string;
  repPdDate: string;
  holdings: NportHolding[];
  totalValue: number;
};

// Minimal, forgiving N-PORT-P XML reader (machine-generated schemas only),
// in the same spirit as SPDR's hand-rolled ZIP/OOXML workbook reader.
export function parseNport(xml: string): ParsedNport {
  const genInfoMatch = /<genInfo>([\s\S]*?)<\/genInfo>/i.exec(xml);
  const genInfo = genInfoMatch ? genInfoMatch[1] : xml.slice(0, 4000);
  const holdings: NportHolding[] = [];
  const blockRe = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let block: RegExpExecArray | null;
  let totalValue = 0;
  while ((block = blockRe.exec(xml)) !== null) {
    const body = block[1];
    const name = tagValue(body, 'name') || tagValue(body, 'title') || '-';
    const cusip = tagValue(body, 'cusip');
    let identifier = cusip && cusip.toUpperCase() !== 'N/A' ? cusip : '';
    if (!identifier) {
      // Real EDGAR schema: <identifiers><isin value="..."/><other value="..."/></identifiers>
      for (const tagMatch of body.matchAll(/<(isin|sedol|other|cusip)[^>]*value="([^"]+)"/gi)) {
        identifier = cleanText(tagMatch[2]);
        if (identifier) break;
      }
    }
    const weight = normalizeNumberText(tagValue(body, 'pctVal'));
    const valueMatch = /<valUSD[^>]*>([\s\S]*?)<\/valUSD>/i.exec(body);
    const value = Number(valueMatch ? valueMatch[1].replace(/[,\s]/g, '') : tagValue(body, 'curVal'));
    const balance = normalizeNumberText(tagValue(body, 'balance'));
    holdings.push({
      Name: name,
      Ticker: '-',
      Identifier: identifier || '-',
      Weight: weight === '' ? '0' : weight,
      'Market Value': Number.isFinite(value) ? String(value) : '0',
      'Shares Held': balance === '' ? '-' : balance,
      'Asset Category': tagValue(body, 'assetCat') || '-',
    });
    if (Number.isFinite(value)) totalValue += value;
  }
  return {
    regName: tagValue(genInfo, 'regName'),
    seriesName: tagValue(genInfo, 'seriesName'),
    seriesId: tagValue(genInfo, 'seriesId'),
    repPdDate: tagValue(genInfo, 'repPdDate'),
    holdings,
    totalValue,
  };
}

// ---------------------------------------------------------------------------
// Yahoo chart layer: daily history, distributions, quote meta
// ---------------------------------------------------------------------------

export type ChartDay = { date: string; close: number; adjClose: number; volume: number };
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
      adjClose: round(adjClose, 6),
      volume: typeof volumes[i] === 'number' ? (volumes[i] as number) : 0,
    });
  }
  const events = ((result.events || {}) as JsonRecord).dividends as Record<string, JsonRecord> | undefined;
  const dividends = Object.values(events || {})
    .map((event) => ({ epoch: Number(event.date), amount: Number(event.amount) }))
    .filter((event) => Number.isFinite(event.epoch) && Number.isFinite(event.amount) && event.amount > 0)
    .sort((a, b) => a.epoch - b.epoch);
  return {
    exchangeName: String(meta.fullExchangeName || meta.exchangeName || ''),
    longName: String(meta.longName || meta.shortName || ''),
    navPrice: numberOrNull(meta.navPrice),
    regularMarketPrice: numberOrNull(meta.regularMarketPrice) ?? numberOrNull(meta.previousClose),
    regularMarketTime: numberOrNull(meta.regularMarketTime),
    firstTradeDate: numberOrNull(meta.firstTradeDate),
    days,
    dividends,
  };
}

function chartUrl(ticker: string, config: UpdaterConfig): string {
  // Explicit period1/period2: `range=max` silently downgrades to monthly bars.
  const period2 = Math.floor(Date.now() / 1000);
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
    siAnn: siYears >= 0.75 ? annualized(first.adjClose, last.adjClose, siYears) : null,
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
    secYield: null, // Fidelity publishes no 30-day SEC yield feed; shown as "—"
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

async function writeIfChanged(file: URL, value: unknown): Promise<boolean> {
  const next = `${JSON.stringify(value, null, 1)}\n`;
  let previous: string | null = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    // First write.
  }
  if (previous === next) return false;
  await writeFile(file, next, 'utf8');
  return true;
}

async function writePages(
  dir: URL,
  ticker: string,
  kind: 'holdings' | 'history',
  headers: string[],
  rows: JsonRecord[],
  pageSize: number,
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
  await removeStalePages(dir, kind, new Set(pages));
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

function returnsBlock(returns: PriceReturns | null, previous: JsonRecord): JsonRecord | null {
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
    quarterEnd: { asOfDate: formatEdgarDate(quarterAnchor.toISOString().slice(0, 10)), null: null },
  };
}

async function processFund(
  seed: SeedFund,
  accession: string | null,
  config: UpdaterConfig,
  previous: JsonRecord,
  resolver: TickerResolver,
): Promise<JsonRecord | null> {
  const ticker = seed.ticker;
  const nportUrl = accession && !seed.catalogOnly ? nportUrlFor(seed.trustCik, accession) : null;

  // 1) Yahoo chart: history, distributions, quote meta, derived metrics.
  let chart: ParsedChart | null = null;
  if (!config.skipYahoo) {
    try {
      chart = parseChart(await fetchJson(chartUrl(ticker, config), `[chart   ] ${ticker}`, yahooHeaders(), config));
    } catch (error) {
      console.warn(`[chart   ] ${ticker}: ${error instanceof Error ? error.message : String(error)} — keeping previous history`);
    }
  }

  const metrics: JsonRecord = chart
    ? deriveCatalogMetrics(
        priceReturns(chart.days),
        chart.dividends.length ? chart.dividends[chart.dividends.length - 1].amount : null,
        inferDistributionFrequency(chart.dividends).paymentsPerYear,
        chart.regularMarketPrice,
      )
    : ((previous.metrics as JsonRecord) ?? deriveCatalogMetrics(priceReturns([]), null, null, null));

  const candidate = {
    ticker,
    aumValue: numberOrNull(previous.aumValue),
    terValue: numberOrNull(seed.ter),
    metrics,
  };
  const reasons = fundFilterReasons(candidate, config);
  if (reasons.length) {
    console.log(`[${ticker.padEnd(5)}] skipped (${reasons.join(', ')})`);
    return null;
  }

  // 2) SEC N-PORT: official holdings + net assets (sum of reported valUSD).
  let nport: ParsedNport | null = null;
  if (nportUrl) {
    try {
      const xml = await fetchText(nportUrl, `[nport   ] ${ticker}`, secHeaders(config), config);
      nport = parseNport(xml);
      if (config.storeRawDownloads) {
        const rawDir = new URL(`raw/${ticker}/`, API_ROOT);
        await mkdir(rawDir, { recursive: true });
        await writeFile(new URL(`nport-${(nport.repPdDate || 'latest').replace(/-/g, '')}.xml`, rawDir), xml, 'utf8');
      }
    } catch (error) {
      console.warn(`[nport   ] ${ticker}: ${error instanceof Error ? error.message : String(error)} — keeping previous holdings`);
    }
  }

  // Fill the Ticker column with real exchange tickers (seed + Yahoo search);
  // bonds / private positions stay "-" and keep their CUSIP/ISIN Identifier.
  if (nport) {
    try {
      const resolved = await attachHoldingTickers(nport, resolver);
      if (resolved) console.log(`[ticker   ] ${ticker}: resolved ${resolved}/${nport.holdings.length} holding tickers`);
    } catch (error) {
      console.warn(`[ticker   ] ${ticker}: ${error instanceof Error ? error.message : String(error)} — keeping "-" tickers`);
    }
  }

  const fundDir = new URL(`funds/${ticker}/`, API_ROOT);
  await mkdir(fundDir, { recursive: true });

  const holdingsHeaders = ['Name', 'Ticker', 'Identifier', 'Weight', 'Market Value', 'Shares Held', 'Asset Category'];
  const holdingsRows: JsonRecord[] = nport ? nport.holdings : await readPreviousSheet(ticker, 'holdings');
  const holdingsManifest = await writePages(fundDir, ticker, 'holdings', holdingsHeaders, holdingsRows, config.holdingsPageSize);

  const historyHeaders = ['Date', 'Close', 'Adj Close', 'Volume'];
  const history = chart ? historyRows(chart) : await readPreviousSheet(ticker, 'history');
  const historyManifest = await writePages(fundDir, ticker, 'history', historyHeaders, history, config.historyPageSize);

  const distributions = chart ? distributionRows(chart) : ((previous.distributions?.rows as JsonRecord[]) || []);
  const frequency = chart
    ? inferDistributionFrequency(chart.dividends)
    : { frequency: String((previous.distributions as JsonRecord)?.frequency || '—'), paymentsPerYear: null };
  const latestDividend = chart && chart.dividends.length ? chart.dividends[chart.dividends.length - 1] : null;

  const name = nport?.seriesName || seed.name;
  const nav = chart?.navPrice ?? null;
  const price = chart?.regularMarketPrice ?? null;
  const premiumDiscount = nav && price ? round(((price - nav) / nav) * 100, 2) : null;
  const netAssets = nport ? nport.totalValue : numberOrNull(previous.aumValue);
  const returns = chart ? priceReturns(chart.days) : null;
  const returnsData = returnsBlock(returns, previous);

  const meta: JsonRecord = {
    ticker,
    name,
    category: seed.category,
    source: {
      fundPage: seed.fundPage,
      edgarFiling: accession
        ? `${EDGAR_ARCHIVES}/${Number(seed.trustCik)}/${accession.replace(/-/g, '')}/${accession.replace(/-/g, '')}-index.htm`
        : ((previous.source as JsonRecord)?.edgarFiling ?? null),
      nportDoc: nportUrl || ((previous.source as JsonRecord)?.nportDoc ?? null),
      yahooChart: chartUrl(ticker, config),
      provider: 'SEC EDGAR (N-PORT-P) + Yahoo Finance public chart API',
    },
    expenseRatio: numberOrNull(seed.ter) === null ? { display: '—', value: null } : { display: `${seed.ter}%`, value: numberOrNull(seed.ter) },
    nav: {
      display: nav === null ? '—' : `$${nav.toFixed(2)}`,
      value: nav,
      asOfDate: chart?.regularMarketTime ? formatEpochDate(chart.regularMarketTime) : '—',
    },
    marketPrice: {
      display: price === null ? '—' : `$${price.toFixed(2)}`,
      value: price,
      asOfDate: chart?.regularMarketTime ? formatEpochDate(chart.regularMarketTime) : '—',
    },
    premiumDiscount: { display: premiumDiscount === null ? '—' : `${premiumDiscount.toFixed(2)}%`, value: premiumDiscount },
    aum: {
      display: netAssets === null ? '—' : formatAumDisplay(netAssets),
      value: netAssets,
      asOfDate: nport ? formatEdgarDate(nport.repPdDate) : (((previous.aum as JsonRecord)?.asOfDate as string) ?? '—'),
      source: nport ? 'sum of reported N-PORT position values' : 'previous run',
    },
    returns: returnsData,
    distributions: { frequency: frequency.frequency, paymentsPerYear: frequency.paymentsPerYear, headers: ['Ex-Date', 'Amount'], rows: distributions },
    holdings: {
      ...holdingsManifest,
      asOf: nport ? formatEdgarDate(nport.repPdDate) : (((previous.holdings as JsonRecord)?.asOf as string) ?? '—'),
    },
    history: {
      ...historyManifest,
      asOf: returns ? formatEdgarDate(returns.asOfDate) : (((previous.history as JsonRecord)?.asOf as string) ?? '—'),
    },
    seed: {
      seriesId: seed.seriesId,
      seriesName: seed.name,
      trustCik: seed.trustCik,
      trustName: FIDELITY_TRUSTS[seed.trustCik] || null,
      accession: accession || ((previous.seed as JsonRecord)?.accession ?? null),
    },
  };
  await writeIfChanged(new URL('meta.json', fundDir), meta);

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
    distributions: {
      frequency: frequency.frequency,
      exDate: latestDividend ? formatUsDate(latestDividend.epoch) : '—',
      dividend: latestDividend ? String(round(latestDividend.amount, 6)) : '—',
    },
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
  const resolver = new TickerResolver(HELD_TICKERS);
  console.log(`[ticker  ] ${resolver.size} known holding names in scripts/held-tickers.ts`);

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
      if (String(row.Ticker ?? '-') !== '-') continue;
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
  console.log(`[cursor  ] rows still "-" have no exchange ticker (bonds / private debt) or are not in the seed yet (a live run resolves them via Yahoo search)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = readConfig();
  requestSleepMs = Math.max(0, config.requestSleep) * 1000;

  console.log('Fidelity ETF static data updater');
  console.log('Sources: SEC EDGAR N-PORT-P (holdings, net assets) + Yahoo Finance public chart API (history, distributions)');
  for (const line of configLines(config)) console.log(`  ${line}`);
  console.log('');

  const seedFunds = FIDELITY_FUNDS.slice().sort((a, b) => a.ticker.localeCompare(b.ticker));
  console.log(`[seed    ] ${seedFunds.length} Fidelity ETFs across ${Object.keys(FIDELITY_TRUSTS).length} SEC registrants`);
  console.log(`[ticker  ] ${Object.keys(HELD_TICKERS).length} known holding names in scripts/held-tickers.ts${config.skipYahoo ? ' (live Yahoo resolution off: SKIP_YAHOO)' : ''}`);

  // Unknown holding names are resolved through the Yahoo symbol search
  // (strict name match). Every search is globally paced like the rest of the
  // run's requests and cached for the whole run.
  const searchHoldingTicker = async (name: string): Promise<string | null> => {
    const payload = await fetchJson(yahooSearchUrl(name), `[ticker   ] ${name}`, yahooHeaders(), config);
    return pickSearchTicker(name, payload);
  };
  const resolver = new TickerResolver(HELD_TICKERS, config.skipYahoo ? null : searchHoldingTicker);

  // accession per seriesId: seed baseline, refreshed from EDGAR submissions.
  const accessionBySeries = new Map<string, NportAccession>();
  const seriesKeyOf = (fund: SeedFund): string => fund.seriesId || `__ticker__${fund.ticker}`;
  for (const fund of seedFunds) {
    if (fund.accession && !accessionBySeries.has(seriesKeyOf(fund))) {
      accessionBySeries.set(seriesKeyOf(fund), {
        accession: fund.accession,
        filed: fund.filed || '',
        reportDate: '',
        url: nportUrlFor(fund.trustCik, fund.accession),
      });
    }
  }
  const seedAccessions = new Map(accessionBySeries);

  if (config.refreshCatalog) {
    for (const [cik] of Object.entries(FIDELITY_TRUSTS)) {
      const newestSeed = [...seedAccessions.values()]
        .filter((entry) => entry.url.includes(`/${Number(cik)}/`))
        .reduce((max, entry) => (entry.filed > max ? entry.filed : max), '0000-00-00');
      let accessions: NportAccession[] = [];
      try {
        const submissions = await fetchJson(
          `${SEC_DATA_HOST}/submissions/CIK${cik}.json`,
          `[edgar   ] submissions ${cik}`,
          secHeaders(config),
          config,
        );
        accessions = parseNportAccessions(submissions);
      } catch (error) {
        console.warn(`[edgar   ] submissions ${cik}: ${error instanceof Error ? error.message : String(error)} — using seed accessions`);
        continue;
      }
      const fresh = accessions.filter((entry) => entry.filed > newestSeed).sort((a, b) => (a.filed < b.filed ? 1 : -1));
      for (const entry of fresh) {
        const url = nportUrlFor(cik, entry.accession);
        try {
          const parsed = parseNport(await fetchText(url, `[nport   ] refresh ${entry.accession}`, secHeaders(config), config));
          const key = parsed.seriesId || `__ticker__${seedFunds.find((f) => f.seriesId === parsed.seriesId)?.ticker || ''}`;
          if (!accessionBySeries.has(key)) {
            accessionBySeries.set(key, { ...entry, url });
          }
        } catch {
          // Skip unreachable accessions; seed accessions remain the fallback.
        }
      }
    }
  }

  const previousIndex = await readPreviousIndex();
  const state = await readUpdateState();
  const cursor = state?.cursor || null;
  const cursorIndex = cursor ? seedFunds.findIndex((fund) => fund.ticker === cursor) : -1;
  const ordered =
    cursorIndex >= 0
      ? seedFunds.slice(cursorIndex + 1).concat(seedFunds.slice(0, cursorIndex + 1))
      : seedFunds.slice();

  const queue = ordered.map((seed) => ({ seed }));
  const results: JsonRecord[] = [];
  let processed = 0;
  let lastProcessedTicker: string | null = cursor;
  let failures = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      if (config.maxFetches > 0 && processed >= config.maxFetches) return;
      const seed = item.seed;
      const previous = previousIndex.get(seed.ticker) || {};
      const entry = accessionBySeries.get(seriesKeyOf(seed)) || null;
      processed += 1;
      try {
        const row = await processFund(seed, entry ? entry.accession : null, config, previous, resolver);
        if (row) {
          results.push(row);
          lastProcessedTicker = seed.ticker;
        }
      } catch (error) {
        failures += 1;
        console.warn(`[error   ] ${seed.ticker}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (config.maxFetches > 0 && processed >= config.maxFetches) {
        console.log(`[cursor  ] batch of ${config.maxFetches} reached — rerun to continue after ${lastProcessedTicker}`);
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, config.concurrency) }, () => worker()));

  // Funds not selected for a successful update keep their previously published rows.
  const keptFromPrevious = seedFunds
    .filter((seed) => !results.some((row) => row.ticker === seed.ticker))
    .map((seed) => previousIndex.get(seed.ticker))
    .filter(Boolean) as JsonRecord[];
  const funds = [...results, ...keptFromPrevious].sort((a, b) => String(a.ticker).localeCompare(String(b.ticker)));

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
      holdingTickers: 'scripts/held-tickers.ts seed (SEC EDGAR company tickers + exchange symbol directories) extended live by the Yahoo Finance symbol search',
      trusts: FIDELITY_TRUSTS,
    },
    counts,
    funds,
  });

  // Persist tickers learned from live searches so the next run (and the
  // --backfill-tickers mode) can serve them without re-querying Yahoo.
  if (resolver.fresh.length) {
    const merged: Record<string, string> = { ...HELD_TICKERS, ...resolver.freshEntries() };
    const seedChanged = await writeTextIfChanged(HELD_TICKERS_FILE, formatHeldTickersSeed(merged));
    if (seedChanged) {
      console.log(`[ticker  ] ${resolver.fresh.length} new name -> ticker mappings added to scripts/held-tickers.ts`);
    }
  }

  await writeUpdateState(lastProcessedTicker);

  console.log('');
  console.log(`[done    ] ${results.length} funds updated, ${keptFromPrevious.length} kept from previous runs, ${failures} failures`);
  console.log(`[done    ] counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows`);
  console.log(`[cursor  ] ${lastProcessedTicker ? `next run continues after ${lastProcessedTicker}` : 'full pass complete (cursor reset)'}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### Fidelity data update\n\n- updated: ${results.length}\n- kept from previous runs: ${keptFromPrevious.length}\n- failed: ${failures}\n- counts: ${counts.funds} funds / ${counts.holdings.toLocaleString('en-US')} holdings rows / ${counts.history.toLocaleString('en-US')} history rows\n`,
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
