// 프론트(index.html)의 #seed-data JSON을 읽어 db/seed.sql 생성
// 사용: node scripts/build-seed-sql.mjs [경로(기본 ../reits-on/index.html)]
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2] || path.resolve('../reits-on/index.html');
const html = fs.readFileSync(src, 'utf8');
const m = html.match(/<script id="seed-data"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('seed-data 블록을 찾지 못했습니다:', src); process.exit(1); }
const seed = JSON.parse(m[1]);

const q = (v) => v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const n = (v) => v === null || v === undefined || v === '' ? 'NULL' : Number(v);

let sql = '-- 자동 생성: build-seed-sql.mjs\nBEGIN TRANSACTION;\n\n';

for (const r of seed.reits) {
  const stockCode = /^\d{6}$/.test(r.ticker) ? r.ticker : null;
  sql += `INSERT INTO reits (ticker,stock_code,corp_code,name,primary_sector,sectors,div_months,tags,difficulty,asset_text,asset_bn,homepage,note,recent_div) VALUES (`
    + [q(r.ticker), q(stockCode), 'NULL', q(r.name), q(r.primary), q(JSON.stringify(r.sector)),
       q(JSON.stringify(r.divMonths)), q(JSON.stringify(r.tags)), q(r.difficulty), q(r.assetText),
       n(r.assetBn), q(r.homepage), q(r.note), n(r.recentDiv)].join(',')
    + `)\nON CONFLICT(ticker) DO UPDATE SET name=excluded.name, primary_sector=excluded.primary_sector, sectors=excluded.sectors, div_months=excluded.div_months, tags=excluded.tags, difficulty=excluded.difficulty, asset_text=excluded.asset_text, asset_bn=excluded.asset_bn, homepage=excluded.homepage, note=excluded.note, recent_div=excluded.recent_div, updated_at=datetime('now');\n`;
}

const mk = seed.market;
sql += `\nINSERT INTO market_snapshots (as_of,total_reits,total_aum_tn,listed_reits,listed_market_cap_tn,listed_aum_tn,yield_paid_in_capital,yield_price_basis,sector_aum,growth,source) VALUES (`
  + ['\'2026-05-31\'', n(mk.totalReits), n(mk.totalAumTn), n(mk.listedReits), n(mk.listedMarketCapTn),
     n(mk.listedAumTn), n(mk.listedDividendYieldPaidInCapital), n(mk.listedDividendYieldPriceBasis),
     q(JSON.stringify(mk.sectorAum)), q(JSON.stringify(mk.growth)), q('seed:KAREIT ' + mk.asOf)].join(',')
  + `)\nON CONFLICT(as_of) DO NOTHING;\n`;

sql += '\nCOMMIT;\n';

fs.mkdirSync('db', { recursive: true });
fs.writeFileSync('db/seed.sql', sql, 'utf8');
console.log('db/seed.sql 생성 완료 ·', seed.reits.length, '개 리츠 + 시장 스냅샷 1건');
