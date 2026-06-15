import { Hono } from 'hono';
import { runAllCollectors } from './collectors';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ALLOW_ORIGIN: string;
  DATA_GO_KR_KEY?: string;
  OPENDART_KEY?: string;
  MOLIT_KEY?: string;
  ADMIN_TOKEN?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ---- CORS (Pages origin only) ----
app.use('*', async (c, next) => {
  const origin = c.env.ALLOW_ORIGIN || '*';
  if (c.req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  await next();
  c.header('Access-Control-Allow-Origin', origin);
});

// small KV cache helper for GET responses
async function cached<T>(c: any, key: string, ttl: number, build: () => Promise<T>): Promise<T> {
  const hit = await c.env.CACHE.get(key, 'json');
  if (hit) return hit as T;
  const data = await build();
  await c.env.CACHE.put(key, JSON.stringify(data), { expirationTtl: ttl });
  return data;
}

const parseJson = (s: string | null, fallback: any) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// ---- health ----
app.get('/v1/health', async (c) => {
  const last = await c.env.DB.prepare(
    "SELECT job, status, ended_at FROM batch_runs ORDER BY id DESC LIMIT 1"
  ).first();
  return c.json({ ok: true, time: new Date().toISOString(), lastBatch: last ?? null });
});

// ---- market ----
app.get('/v1/market', async (c) => {
  const data = await cached(c, 'market:latest', 300, async () => {
    const m: any = await c.env.DB.prepare(
      "SELECT * FROM market_snapshots ORDER BY as_of DESC LIMIT 1"
    ).first();
    if (!m) return null;
    return {
      asOf: m.as_of,
      asOfDate: m.as_of,
      totalReits: m.total_reits,
      totalAumTn: m.total_aum_tn,
      listedReits: m.listed_reits,
      listedMarketCapTn: m.listed_market_cap_tn,
      listedAumTn: m.listed_aum_tn,
      listedDividendYieldPaidInCapital: m.yield_paid_in_capital,
      listedDividendYieldPriceBasis: m.yield_price_basis,
      sectorAum: parseJson(m.sector_aum, []),
      growth: parseJson(m.growth, []),
      source: m.source,
      fetchedAt: m.fetched_at,
    };
  });
  if (!data) return c.json({ error: 'no market snapshot yet' }, 404);
  return c.json(data);
});

// ---- reits list (merge latest price) ----
app.get('/v1/reits', async (c) => {
  const data = await cached(c, 'reits:list', 120, async () => {
    const rows = await c.env.DB.prepare(`
      SELECT r.*, p.close AS price, p.market_cap, p.date AS price_date, p.change_pct
      FROM reits r
      LEFT JOIN price_snapshots p
        ON p.ticker = r.ticker
       AND p.date = (SELECT MAX(date) FROM price_snapshots p2 WHERE p2.ticker = r.ticker)
      ORDER BY r.name COLLATE NOCASE
    `).all();
    return (rows.results || []).map(mapReitRow);
  });
  return c.json({ reits: data });
});

// ---- reit detail ----
app.get('/v1/reits/:ticker', async (c) => {
  const t = c.req.param('ticker');
  const r: any = await c.env.DB.prepare(`
    SELECT r.*, p.close AS price, p.market_cap, p.date AS price_date, p.change_pct
    FROM reits r
    LEFT JOIN price_snapshots p
      ON p.ticker = r.ticker
     AND p.date = (SELECT MAX(date) FROM price_snapshots p2 WHERE p2.ticker = r.ticker)
    WHERE r.ticker = ?1
  `).bind(t).first();
  if (!r) return c.json({ error: 'not found' }, 404);
  const divs = await c.env.DB.prepare(
    "SELECT record_month, pay_date, dps, div_type, period, source FROM dividends WHERE ticker=?1 ORDER BY period DESC LIMIT 12"
  ).bind(t).all();
  const filings = await c.env.DB.prepare(
    "SELECT rcept_no, title, filed_at, url, category FROM filings WHERE ticker=?1 ORDER BY filed_at DESC LIMIT 10"
  ).bind(t).all();
  return c.json({
    ...mapReitRow(r),
    dividends: divs.results || [],
    filings: (filings.results || []).map((f: any) => ({ ...f, category: parseJson(f.category, []) })),
  });
});

// ---- price series ----
app.get('/v1/reits/:ticker/prices', async (c) => {
  const t = c.req.param('ticker');
  const from = c.req.query('from') || '0000-00-00';
  const to = c.req.query('to') || '9999-99-99';
  const rows = await c.env.DB.prepare(
    "SELECT date, close, volume, market_cap, change_pct FROM price_snapshots WHERE ticker=?1 AND date BETWEEN ?2 AND ?3 ORDER BY date"
  ).bind(t, from, to).all();
  return c.json({ ticker: t, prices: rows.results || [] });
});

// ---- filings feed ----
app.get('/v1/filings', async (c) => {
  const since = c.req.query('since') || '0000-00-00';
  const rows = await c.env.DB.prepare(
    "SELECT rcept_no, ticker, title, filed_at, url, category FROM filings WHERE filed_at >= ?1 ORDER BY filed_at DESC LIMIT 100"
  ).bind(since).all();
  return c.json({ filings: (rows.results || []).map((f: any) => ({ ...f, category: parseJson(f.category, []) })) });
});

// ---- admin: manual refresh ----
app.post('/admin/refresh', async (c) => {
  const auth = c.req.header('Authorization') || '';
  if (!c.env.ADMIN_TOKEN || auth !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const result = await runAllCollectors(c.env);
  await c.env.CACHE.delete('market:latest');
  await c.env.CACHE.delete('reits:list');
  return c.json({ ok: true, result });
});

app.get('/', (c) => c.json({ name: '리츠온 REITs ON API', docs: '/v1/health, /v1/market, /v1/reits' }));

function mapReitRow(r: any) {
  const price = r.price ?? null;
  const recentDiv = r.recent_div ?? null;
  const divMonths = parseJson(r.div_months, []);
  // 현재가 기준 배당수익률(연환산 추정): recent_div × 횟수 / price
  const annualDps = recentDiv != null && divMonths.length ? recentDiv * divMonths.length : null;
  const yieldPriceBasis = price && annualDps ? Math.round((annualDps / price) * 1000) / 10 : null;
  return {
    name: r.name,
    ticker: r.ticker,
    sector: parseJson(r.sectors, []),
    primary: r.primary_sector,
    divMonths,
    recentDiv,
    assetText: r.asset_text,
    assetBn: r.asset_bn,
    homepage: r.homepage,
    note: r.note,
    difficulty: r.difficulty,
    tags: parseJson(r.tags, []),
    // --- live fields (null이면 프론트는 "공시 확인 필요"/링크 유지) ---
    price,
    marketCap: r.market_cap ?? null,
    changePct: r.change_pct ?? null,
    priceAsOf: r.price_date ?? null,
    annualDpsEst: annualDps,
    yieldPriceBasis,
  };
}

export default {
  fetch: app.fetch,
  // Cron Triggers
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAllCollectors(env).then(async () => {
      await env.CACHE.delete('market:latest');
      await env.CACHE.delete('reits:list');
    }));
  },
};
