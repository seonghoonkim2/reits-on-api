-- 리츠온 REITs ON · D1(SQLite) 스키마 v1
-- 적용: wrangler d1 execute reitson --file db/schema.sql

PRAGMA foreign_keys = ON;

-- 종목 마스터 (seed에서 1회 적재, 이후 관리자 갱신)
CREATE TABLE IF NOT EXISTS reits (
  ticker       TEXT PRIMARY KEY,          -- 거래소 종목코드(예: 395400). 일부 신규는 0030R0 형태
  stock_code   TEXT,                       -- 시세 API 조회용 6자리(없으면 ticker)
  corp_code    TEXT,                       -- OpenDART 고유번호(8자리)
  name         TEXT NOT NULL,
  primary_sector TEXT,
  sectors      TEXT,                        -- JSON 배열
  div_months   TEXT,                        -- JSON 배열 [3,6,9,12]
  tags         TEXT,                        -- JSON 배열
  difficulty   TEXT,
  asset_text   TEXT,
  asset_bn     REAL,                        -- 자산총계(십억원 단위, seed 그대로)
  homepage     TEXT,
  note         TEXT,
  recent_div   INTEGER,                     -- 최근 1회 배당금(원), 미표기 시 NULL
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- 일자별 시장 요약
CREATE TABLE IF NOT EXISTS market_snapshots (
  as_of                       TEXT PRIMARY KEY,  -- 'YYYY-MM-DD'
  total_reits                 INTEGER,
  total_aum_tn                REAL,
  listed_reits                INTEGER,
  listed_market_cap_tn        REAL,
  listed_aum_tn               REAL,
  yield_paid_in_capital       REAL,
  yield_price_basis           REAL,
  sector_aum                  TEXT,              -- JSON
  growth                      TEXT,              -- JSON
  source                      TEXT,
  fetched_at                  TEXT DEFAULT (datetime('now'))
);

-- 일별 시세 스냅샷 (EOD)
CREATE TABLE IF NOT EXISTS price_snapshots (
  ticker      TEXT NOT NULL,
  date        TEXT NOT NULL,                 -- 'YYYY-MM-DD' (거래일)
  close       INTEGER,                       -- 종가(원)
  change_pct  REAL,
  volume      INTEGER,
  market_cap  REAL,                          -- 시가총액(원 또는 억원 — 수집기에서 단위 고정)
  shares_out  INTEGER,                       -- 상장주식수
  source      TEXT,
  fetched_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, date),
  FOREIGN KEY (ticker) REFERENCES reits(ticker)
);
CREATE INDEX IF NOT EXISTS idx_price_ticker_date ON price_snapshots(ticker, date DESC);

-- 배당 이력
CREATE TABLE IF NOT EXISTS dividends (
  ticker       TEXT NOT NULL,
  record_month INTEGER,                      -- 배당기준월(1~12)
  pay_date     TEXT,                         -- 실제 지급일(있으면)
  dps          INTEGER,                      -- 주당 배당금(원)
  div_type     TEXT DEFAULT 'unknown',       -- recurring | special | unknown
  period       TEXT,                         -- 회계기간 라벨
  source       TEXT,
  fetched_at   TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (ticker, record_month, period),
  FOREIGN KEY (ticker) REFERENCES reits(ticker)
);

-- 공시 (중복 방지 = rcept_no UNIQUE)
CREATE TABLE IF NOT EXISTS filings (
  rcept_no    TEXT PRIMARY KEY,              -- DART 접수번호
  ticker      TEXT,
  corp_code   TEXT,
  title       TEXT,
  filed_at    TEXT,                          -- 'YYYY-MM-DD'
  url         TEXT,
  category    TEXT,                          -- JSON 배열(키워드 분류)
  summary     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_filings_filed ON filings(filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_filings_ticker ON filings(ticker, filed_at DESC);

-- 값 변경 추적(거버넌스)
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT,
  ticker    TEXT,
  field     TEXT,
  old_value TEXT,
  new_value TEXT,
  source    TEXT,
  at        TEXT DEFAULT (datetime('now'))
);

-- 배치 실행 기록(신선도 모니터)
CREATE TABLE IF NOT EXISTS batch_runs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  job       TEXT,
  status    TEXT,            -- ok | partial | error
  detail    TEXT,
  started_at TEXT,
  ended_at  TEXT DEFAULT (datetime('now'))
);

-- (v2) 알림 구독 — 스키마만 미리 정의
-- CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, email TEXT, ticker TEXT, topic TEXT, created_at TEXT, confirmed INTEGER DEFAULT 0);
