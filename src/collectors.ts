import type { Env } from './index';

// ───────────────────────────────────────────────────────────
// 수집기: 전부 무료·합법 공개 API. 키가 없으면 안전하게 skip.
// 각 수집기는 idempotent UPSERT + audit_log + batch_runs 기록.
// ───────────────────────────────────────────────────────────

export async function runAllCollectors(env: Env) {
  const out: Record<string, string> = {};
  out.prices = await safe(env, 'prices', () => collectPrices(env));
  out.market = await safe(env, 'market', () => collectMarket(env));
  out.filings = await safe(env, 'filings', () => collectFilings(env));
  return out;
}

async function safe(env: Env, job: string, fn: () => Promise<string>): Promise<string> {
  const started = new Date().toISOString();
  try {
    const detail = await fn();
    await logRun(env, job, 'ok', detail, started);
    return detail;
  } catch (e: any) {
    const msg = (e && e.message) || String(e);
    await logRun(env, job, 'error', msg, started);
    return 'error: ' + msg;
  }
}

async function logRun(env: Env, job: string, status: string, detail: string, started: string) {
  try {
    await env.DB.prepare(
      "INSERT INTO batch_runs (job,status,detail,started_at) VALUES (?1,?2,?3,?4)"
    ).bind(job, status, detail.slice(0, 500), started).run();
  } catch {}
}

const today = () => new Date().toISOString().slice(0, 10);

// ── 1) 일별 시세: data.go.kr 금융위_주식시세정보 getStockPriceInfo (EOD) ──
// 문서: https://www.data.go.kr/data/15094808/openapi.do (예시)
export async function collectPrices(env: Env): Promise<string> {
  if (!env.DATA_GO_KR_KEY) return 'skip: DATA_GO_KR_KEY 없음';
  const reits = await env.DB.prepare("SELECT ticker, stock_code FROM reits").all();
  let ok = 0, fail = 0;
  for (const r of (reits.results || []) as any[]) {
    const code = (r.stock_code || r.ticker || '').toString();
    if (!/^\d{6}$/.test(code)) { fail++; continue; } // 6자리 표준코드만(0030R0류는 매핑 필요)
    try {
      const url = new URL('https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo');
      url.searchParams.set('serviceKey', env.DATA_GO_KR_KEY);
      url.searchParams.set('resultType', 'json');
      url.searchParams.set('numOfRows', '1');
      url.searchParams.set('likeSrtnCd', code);
      const res = await fetch(url.toString());
      const data: any = await res.json();
      const item = data?.response?.body?.items?.item?.[0];
      if (!item) { fail++; continue; }
      const date = String(item.basDt).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const close = Number(item.clpr) || null;          // 종가
      const volume = Number(item.trqu) || null;          // 거래량
      const marketCap = Number(item.mrktTotAmt) || null; // 시가총액(원)
      const sharesOut = Number(item.lstgStCnt) || null;  // 상장주식수
      const changePct = item.vs && item.mkp ? Math.round((Number(item.vs) / (Number(item.clpr) - Number(item.vs))) * 1000) / 10 : null;
      await upsertPrice(env, r.ticker, date, close, changePct, volume, marketCap, sharesOut);
      ok++;
    } catch { fail++; }
  }
  return `prices ok=${ok} fail=${fail}`;
}

async function upsertPrice(env: Env, ticker: string, date: string, close: number | null, change: number | null, volume: number | null, cap: number | null, shares: number | null) {
  await env.DB.prepare(`
    INSERT INTO price_snapshots (ticker,date,close,change_pct,volume,market_cap,shares_out,source,fetched_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,'data.go.kr',datetime('now'))
    ON CONFLICT(ticker,date) DO UPDATE SET
      close=excluded.close, change_pct=excluded.change_pct, volume=excluded.volume,
      market_cap=excluded.market_cap, shares_out=excluded.shares_out, fetched_at=datetime('now')
  `).bind(ticker, date, close, change, volume, cap, shares).run();
}

// ── 2) 시장 요약: MOLIT 리츠정보 OpenAPI / KAREIT (보조) ──
// 자동 소스가 부분적이라 v1은 "기존 값 유지 + 갱신 가능한 필드만 덮어쓰기".
export async function collectMarket(env: Env): Promise<string> {
  // 가격 스냅샷이 있으면 상장 시가총액 합계를 재계산(파생, 날조 아님).
  const agg: any = await env.DB.prepare(`
    SELECT SUM(p.market_cap) AS cap_sum, COUNT(*) AS n
    FROM price_snapshots p
    WHERE p.date = (SELECT MAX(date) FROM price_snapshots)
  `).first();
  const prev: any = await env.DB.prepare("SELECT * FROM market_snapshots ORDER BY as_of DESC LIMIT 1").first();
  if (!prev) return 'skip: 초기 시장 스냅샷 없음(seed 적재 필요)';
  const capTn = agg?.cap_sum ? Math.round((agg.cap_sum / 1e12) * 10000) / 10000 : prev.listed_market_cap_tn;
  const asOf = today();
  await env.DB.prepare(`
    INSERT INTO market_snapshots (as_of,total_reits,total_aum_tn,listed_reits,listed_market_cap_tn,listed_aum_tn,yield_paid_in_capital,yield_price_basis,sector_aum,growth,source,fetched_at)
    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,datetime('now'))
    ON CONFLICT(as_of) DO UPDATE SET listed_market_cap_tn=excluded.listed_market_cap_tn, fetched_at=datetime('now')
  `).bind(asOf, prev.total_reits, prev.total_aum_tn, prev.listed_reits, capTn, prev.listed_aum_tn,
    prev.yield_paid_in_capital, prev.yield_price_basis, prev.sector_aum, prev.growth,
    agg?.cap_sum ? 'derived:data.go.kr' : prev.source).run();
  return `market as_of=${asOf} cap_tn=${capTn}`;
}

// ── 3) 공시: OpenDART list.json + 키워드 분류(프론트 스캐너 재사용) ──
const KW: Record<string, string[]> = {
  '차입/만기': ['차입', '만기', '리파이낸싱', '금리', '대출', '사채'],
  '배당': ['배당', '특별배당', '매각차익', '분배금'],
  '임차인/공실': ['임차', '공실', '임대', '계약'],
  '증자': ['유상증자', '신주', '발행'],
  '자산': ['편입', '매각', '취득', '감정평가'],
  '해외/환율': ['해외', '환율', '환헤지', '외화'],
};
function classify(title: string): string[] {
  const cats: string[] = [];
  for (const [k, words] of Object.entries(KW)) if (words.some(w => title.includes(w))) cats.push(k);
  return cats;
}

export async function collectFilings(env: Env): Promise<string> {
  if (!env.OPENDART_KEY) return 'skip: OPENDART_KEY 없음';
  const reits = await env.DB.prepare("SELECT ticker, corp_code FROM reits WHERE corp_code IS NOT NULL").all();
  const end = today().replace(/-/g, '');
  const start = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  let added = 0;
  for (const r of (reits.results || []) as any[]) {
    try {
      const url = new URL('https://opendart.fss.or.kr/api/list.json');
      url.searchParams.set('crtfc_key', env.OPENDART_KEY);
      url.searchParams.set('corp_code', r.corp_code);
      url.searchParams.set('bgn_de', start);
      url.searchParams.set('end_de', end);
      url.searchParams.set('page_count', '20');
      const res = await fetch(url.toString());
      const data: any = await res.json();
      if (data.status !== '000' || !Array.isArray(data.list)) continue;
      for (const it of data.list) {
        const filedAt = String(it.rcept_dt).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
        const docUrl = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no}`;
        const cats = classify(it.report_nm || '');
        const r2 = await env.DB.prepare(`
          INSERT INTO filings (rcept_no,ticker,corp_code,title,filed_at,url,category)
          VALUES (?1,?2,?3,?4,?5,?6,?7)
          ON CONFLICT(rcept_no) DO NOTHING
        `).bind(it.rcept_no, r.ticker, r.corp_code, it.report_nm, filedAt, docUrl, JSON.stringify(cats)).run();
        if (r2.meta && (r2.meta as any).changes) added++;
      }
    } catch { /* 종목별 격리 */ }
  }
  return `filings new=${added}`;
}
