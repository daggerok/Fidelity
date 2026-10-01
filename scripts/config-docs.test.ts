/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CONTROL_NAMES, readConfig, resolveControls, runtimeControls, USAGE } from './update-data';
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('configuration precedence: file < advanced < nonblank input < environment', () => {
  const c = resolveControls({ CONCURRENCY: 2, TICKERS: 'FDIS' }, { CONCURRENCY: 3, TICKERS: 'FTEC' }, { CONCURRENCY: '4', TICKERS: '' }, { CONCURRENCY: '6' });
  expect(c.CONCURRENCY).toBe('6'); expect(c.TICKERS).toBe('FTEC');
  expect(resolveControls({ CONCURRENCY: 2 }, { CONCURRENCY: 3 }, { CONCURRENCY: '4' }).CONCURRENCY).toBe('4');
  expect(resolveControls({ TICKERS: 'FDIS' }, { TICKERS: '' }, { TICKERS: '' }).TICKERS).toBe('');
  expect(resolveControls({ CONCURRENCY: 2 }, {}, { CONCURRENCY: '' }).CONCURRENCY).toBe('2');
  expect(resolveControls({ SKIP_YAHOO: true }, {}, {}, { SKIP_YAHOO: 'false' }).SKIP_YAHOO).toBe('false');
});

test('legacy FIDELITY_ prefix and aliases keep working and the prefix wins', () => {
  expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { FIDELITY_LIMIT: '7' }).MAX_FETCHES).toBe('7');
  expect(resolveControls({ MAX_FETCHES: 0 }, {}, {}, { FIDELITY_MAX_FETCHES: '5', MAX_FETCHES: '9', FIDELITY_LIMIT: '7' }).MAX_FETCHES).toBe('5');
  expect(resolveControls({}, {}, {}, { HISTORICAL_PAGE_SIZE: '300' }).HISTORY_PAGE_SIZE).toBe('300');
  expect(resolveControls({}, {}, {}, { FIDELITY_STORE_RAW_DOWNLOADS: '1' }).STORE_RAW_DOWNLOADS).toBe('1');
  expect(readConfig(resolveControls({ MAX_RETRIES: 0, MAX_FETCHES: 3 })).maxRetries).toBe(0);
  expect(readConfig(resolveControls({ MAX_FETCHES: 3 })).maxFetches).toBe(3);
});

test('resolver rejects unknown, invalid and environment-file injection values', () => {
  for (const value of [{ UNKNOWN: 1 }, { SEC_UA: 'x\nEVIL=yes' }, { CONCURRENCY: 0 }, { MAX_RETRIES: -1 }, { MAX_FETCHES: 1.5 }, { REQUEST_SLEEP: '-1' }, { VERBOSE: 'maybe' }, { SKIP_YAHOO: 'maybe' }, { HISTORY_RANGE: '5 years' }, { AUM: '5' }, { TER: '1:0' }, { PERFORMANCE_1Y: '5' }, { TICKERS: ['FDIS'] }, { TICKERS: { a: 1 } }, null, []]) {
    expect(() => resolveControls(value)).toThrow();
  }
  expect(() => resolveControls({}, { SEC_UA: 'x\rfoo' })).toThrow();
  expect(() => resolveControls({}, {}, { TICKERS: 'A\nB' })).toThrow();
  expect(() => resolveControls({}, {}, {}, { SEC_UA: 'x\0bad' })).toThrow();
  expect(() => resolveControls({}, [])).toThrow();
});

test('scheduled path (empty inputs and advanced) equals config defaults, with Fidelity defaults', async () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  const scheduled = resolveControls(file, JSON.parse('{}'), {}, {});
  expect(scheduled).toEqual(Object.fromEntries(Object.entries(file).map(([k, v]) => [k, String(v)])));
  const config = readConfig(scheduled);
  expect(config.tickers).toEqual([]); expect(config.maxFetches).toBe(0); expect(config.requestSleep).toBe(1); expect(config.concurrency).toBe(2);
  expect(config.holdingsPageSize).toBe(250); expect(config.historyPageSize).toBe(1000); expect(config.maxRetries).toBe(2);
  expect(config.historyRange).toBe('max'); expect(config.storeRawDownloads).toBe(false); expect(config.skipYahoo).toBe(false); expect(config.refreshCatalog).toBe(true);
  expect(config.aumRange).toBeUndefined(); expect(config.terRange).toBeUndefined(); expect(config.dividendYieldRange).toBeUndefined();
  expect(config.performanceRanges).toEqual({}); expect(config.totalReturnRanges).toEqual({});
  expect(config.secUa).not.toBe(''); // blank SEC_UA falls back to the declared non-personal default descriptor
  expect(await runtimeControls({})).toEqual(scheduled);
  expect((await runtimeControls({ TICKERS: 'FTEC' })).TICKERS).toBe('FTEC');
});

test('config file has no personal contact and every value is a string', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  for (const value of Object.values(file)) expect(typeof value).toBe('string');
  expect(JSON.stringify(file)).not.toMatch(/@/);
});

test('config keys, CONTROL_NAMES, --help and README controls stay in sync', () => {
  const file = JSON.parse(read('scripts/update-data.config.json'));
  expect(Object.keys(file).sort()).toEqual([...CONTROL_NAMES].sort());
  const doc = read('README.md');
  const section = doc.slice(doc.indexOf('### Update controls'), doc.indexOf('### Examples'));
  const rows = [...section.matchAll(/^\| `([A-Z0-9_]+)`(?: \/ `(_?[A-Z0-9_]+)`)*/gm)].map((m) => m[0]);
  // README groups the five tenors of PERFORMANCE_* / TOTAL_RETURN_* on one row: `PREFIX_YTD` / `_1Y` / ...
  for (const name of CONTROL_NAMES) {
    const tenor = name.match(/^(PERFORMANCE|TOTAL_RETURN)_(1Y|3Y|5Y|10Y)$/);
    expect(section).toContain(tenor ? '`_' + tenor[2] + '`' : '`' + name + '`');
    if (tenor) expect(section).toContain('`' + tenor[1] + '_YTD`');
    expect(USAGE).toMatch(new RegExp(`^  ${tenor ? tenor[1] + '_YTD' : name}\\b`, 'm'));
  }
  expect(rows.length).toBe(CONTROL_NAMES.length - 8); // 10 tenor controls are folded into 2 rows
  expect(doc).toContain('scripts/update-data.config.json');
});

test('workflow: <= 25 inputs, advanced JSON, shared resolver, fixed output directory', () => {
  const actual = read('.github/workflows/update-data.yml');
  const names = [...actual.slice(actual.indexOf('    inputs:'), actual.indexOf('\npermissions:')).matchAll(/^      (\w+):$/gm)].map((m) => m[1]);
  expect(names.length).toBeLessThanOrEqual(25); expect(names).toContain('advanced');
  expect(actual).toContain("advanced:\n        description:"); expect(actual).toContain("default: '{}'");
  for (const name of names.filter((n) => n !== 'advanced')) expect(CONTROL_NAMES).toContain(name.toUpperCase() as never);
  expect(actual).toContain("cron: '0 0 * * 0'"); expect(actual).not.toMatch(/^  push:/m);
  expect(actual).toContain('toJSON(inputs)'); expect(actual).toContain('resolveControls');
  expect(actual).toContain('scripts/update-data.config.json');
  expect(actual).not.toMatch(/\$\{\{\s*(inputs|github\.event\.inputs)\./); // no direct input interpolation
  expect(actual).not.toMatch(/OUTPUT_DIR|OUT_DIR/); expect(actual).not.toContain('bunx tsc');
  expect(actual).toContain('git add api/fidelity scripts/held-tickers.ts\n          if git diff --cached --quiet -- api/fidelity scripts/held-tickers.ts');
  expect(actual).not.toMatch(/git add (?!api\/fidelity scripts\/held-tickers\.ts)/); // never stages outside api/fidelity and the learned ticker seed
  expect(actual).toContain('if: ${{ !cancelled() }}');
  expect(actual.indexOf('bun test')).toBeLessThan(actual.indexOf('bun ./scripts/update-data.ts'));
});
