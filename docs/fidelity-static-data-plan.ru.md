# План: статические данные Fidelity ETF по отдельным JSON-файлам

Сестринский план к `daggerok/iShares/docs/ishares-static-data-plan.ru.md`.

## Цель

Получать воспроизводимые данные всех ETF Fidelity (США) из публичных источников и публиковать их как статический API `api/fidelity/**` без пустых коммитов — в той же структуре файлов, что и `api/ishares/**` и `api/spdr/**`. Данные одного фонда живут в отдельном JSON-файле: изменение FBND не должно переписывать FDIS и весь каталог.

## Проблема источника

У Fidelity нет публичного API фондов:

- `screener.fidelity.com/ftgw/etf/goto/snapshot/*.jhtml` (бывшие CSV-выгрузки holdings) — выведены из строя, редирект на новое SPA;
- `digital.fidelity.com/…/research/quote` — данные приходят через XHR-апи за Akamai bot manager (`_abck`), из CI-раннеров недоступны;
- `fundresearch.fidelity.com` — редирект на логин.

Поэтому лента собирается из двух полностью публичных источников:

1. **SEC EDGAR, форма N-PORT-P** — официальные ежеквартальные (~с задержкой 60 дней) декларации портфелей трастов Fidelity:
   - Fidelity Covington Trust (CIK 0000945908) — акционные ETF (секторные MSCI, факторные, тематические Disruptive, Enhanced, Fundamental и др.);
   - Fidelity Merrimack Street Trust (CIK 0001562565) — облигационные ETF;
   - Fidelity Wise Origin Bitcoin Fund (CIK 0001852317, FBTC) и Fidelity Ethereum Fund (CIK 0002000046, FETH) — N-PORT не подают (коммодитные фонды), в каталоге присутствуют с историей, но без holdings.
   SEC требует объявленный User-Agent и допускает максимум 10 запросов/сек.
2. **Yahoo Finance chart API** (`/v8/finance/chart/…?events=div`) — ежедневная история (close, adjclose), NAV, дистрибуции, дата листинга; авторизация не нужна.

## Целевая структура

```text
api/fidelity/
  index.json
  update-state.json
  raw/{TICKER}/nport-YYYYMMDD.xml      (STORE_RAW_DOWNLOADS=1)
  funds/{TICKER}/
    meta.json
    holdings/001.json …
    history/001.json …
```

- `index.json` — манифест каталога (тот же набор полей, что у SPDR: ter/nav/aum/asOf/inception/exchange/close/premium-discount, distributions, returns.monthEnd/quarterEnd, metrics, holdings/history);
- `funds/{TICKER}/meta.json` — метаданные фонда + ссылки на EDGAR (index, primary_doc.xml) и Yahoo;
- страницы holdings (250 строк) и history (1000 строк) — детерминированные, переписываются только при изменении содержимого.

## Сид `scripts/fidelity-funds.ts`

Тикер ↔ seriesId ↔ CIK траста: строится один раз из EDGAR submissions + проверки через Yahoo (instrumentType, longName, firstTradeDate, expense ratio) и включает категорию (Sector / US Equity / Factor / International / Thematic / Bond / Digital Assets), accession последнего N-PORT, дату инцепции и TER. Обновление каталога (`REFRESH_CATALOG=1`) автоматически подхватывает более свежие N-PORT-файлы из submissions-фидов трастов.

## Честные ограничения (печатаются в README)

- holdings обновляются поквартально (N-PORT), а не ежедневно;
- доходности (YTD/TR/CAGR) считаются по рыночной цене (adjclose), а не по официальным NAV-доходностям;
- SEC Yield — «—» (источника нет); TER — из проверенного сида (у 8 фондов 2026 года листинга профиля ещё нет);
- позиции N-PORT не содержат биржевых тикеров — апдейтер заполняет колонку Ticker по словарю `scripts/held-tickers.ts` (SEC EDGAR company_tickers + каталоги Nasdaq/NYSE/AMEX) и по строгому совпадению названий в Yahoo Finance symbol search (новые маппинги дописываются в словарь и коммитятся вместе с данными); позиции без тикера (облигации, private debt) остаются `"-"` с CUSIP/ISIN (как у облигаций SPDR);
- дивидендная доходность — указанная (indicated), не trailing-12M.

## Тесты

`bun test scripts/update-data.test.ts`: строгие парсеры диапазонов, N-PORT-фикстуры (акции, N/A-CUSIP, пустое тело), фикстуры chart (пропуски close, adjclose, сортировка дивидендов), вывод доходностей (включая null для молодых фондов), якорь квартала, `annualizedToTotal`/`totalToAnnualized`, `indicatedYield`, `deriveCatalogMetrics`.
