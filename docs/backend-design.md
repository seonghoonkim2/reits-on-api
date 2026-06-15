# 리츠온 REITs ON — 백엔드 설계서 (v1: 공개 소스 일배치)

> 목표: 정적 사이트(GitHub Pages)를 **동적 사이트**로 전환. 매일 공개·무료·합법 데이터를 수집·검증·저장하고, 프론트가 호출하는 읽기 전용 API로 제공한다.
> 선택 사항(확정): **무료 티어 우선 / 스택은 TypeScript / 데이터는 공개 소스 일배치**.

---

## 0. 핵심 원칙 (프론트와 동일하게 유지)
1. **수치 날조 금지.** 모든 숫자는 출처(source)와 수집시각(fetched_at)을 함께 저장한다. 값이 없으면 `null` → 프론트는 "공시 확인 필요"로 표기.
2. **일배치(EOD), 실시간 아님.** v1은 장중 실시간이 아니라 종가·일별 스냅샷. UI에 "YYYY-MM-DD 종가 기준"을 명시.
3. **읽기 전용 공개 API + 관리자 전용 쓰기.** 일반 트래픽은 GET만. 수집/갱신은 Cron과 토큰 보호 관리자 엔드포인트로만.
4. **투자 권유 아님.** 면책·"as of" 라벨을 API 응답에도 포함.
5. **점진적 향상(graceful degradation).** 프론트는 API가 죽어도 내장 seed로 동작. API가 살아있으면 가격·시총·수익률을 덮어쓴다.

---

## 1. 아키텍처 개요

```
[사용자 브라우저]
   │  HTTPS (GET, CORS 허용 origin = Pages)
   ▼
[Cloudflare Pages]  ← 정적 프론트(index.html, 기존 그대로) — reits-on
   │  fetch(API_BASE + '/v1/...')
   ▼
[Cloudflare Workers]  ← API (Hono, TypeScript)  — reits-on-api
   ├─ 읽기: D1 조회 + KV 캐시(60~300s)
   └─ Cron Triggers (일/시간 배치)
        ├─ collectMarket()   → MOLIT/KAREIT  → market_snapshots
        ├─ collectPrices()   → data.go.kr 금융위 주식시세 → price_snapshots
        └─ collectFilings()  → OpenDART list → filings (+ 키워드 분류)
   ▼
[D1 (SQLite)]  영속 저장   /   [KV]  핫 캐시   /   [R2]  공시 원문 스냅샷(선택)
```

- **왜 Cloudflare인가:** 무료 티어가 가장 넉넉하고(요청 10만/일, D1 500만 read row/일, Cron 무료), 콜드스타트·서버 관리가 없다. 프론트(Pages)와 같은 플랫폼이라 운영 단순.
- **대안:** Vercel(API Routes) + Supabase(Postgres) + Vercel Cron, 또는 Render/Railway + Postgres. 설계(스키마·API·수집기)는 그대로 이식 가능하도록 의존성을 얇게 둔다.

---

## 2. 데이터 소스 (전부 무료·합법, API 키 필요)

| 데이터 | 소스 | 형태 | 비고 |
|---|---|---|---|
| 일별 시세(종가·거래량·시총·상장주식수) | **data.go.kr 금융위_주식시세정보** `getStockPriceInfo` | REST/JSON | 정부 공개데이터, 무료 키. EOD 기준(실시간 아님) |
| 공시(투자보고서·수시공시·주요사항) | **OpenDART** `list.json`, `document.xml` | REST/JSON·XML | 무료 키. `corp_code`로 종목 매핑 |
| 리츠 현황·기본정보 | **MOLIT 리츠정보 OpenAPI** (data.go.kr) | REST | 무료 키. 운용리츠 수·AUM 등 시장통계 보조 |
| 시장 통계(요약) | 한국리츠협회(KAREIT) 공개 통계 | HTML | API 없음 → 수동/반자동 갱신, 출처·기준일 명시 |

> **법적 메모:** 위 정부/금융당국 OpenAPI는 이용약관 범위 내 무료 사용 가능(키 발급). **네이버/증권사 화면 스크레이핑은 약관 위반 가능 → 사용하지 않음.** KRX 실시간·정밀 데이터는 별도 유료 라이선스(향후 단계). 모든 응답에 출처·기준일을 보존한다.

키는 Wrangler Secrets로 주입: `DATA_GO_KR_KEY`, `OPENDART_KEY`, `MOLIT_KEY`, `ADMIN_TOKEN`.

---

## 3. 데이터 모델 (D1 / SQLite)

`db/schema.sql` 참조. 요약:

- **reits** — 종목 마스터(티커, 이름, 섹터, 배당기준월, 홈페이지, 태그, 난이도, 자산총계, `corp_code`(DART), `stock_code`). seed에서 1회 적재 후 수동/관리자 갱신.
- **market_snapshots** — 일자별 시장 요약(운용리츠 수, 전체 AUM, 상장 시총, 수익률 2종, 섹터 AUM(json), 성장(json), source, fetched_at). PK=`as_of`.
- **price_snapshots** — `(ticker, date)` 일별 종가/등락/거래량/시총/상장주식수 + source/fetched_at.
- **dividends** — 배당 이력(record_month, pay_date, dps, type[recurring|special|unknown], source).
- **filings** — 공시(`rcept_no` UNIQUE, ticker, title, filed_at, url, category(json), created_at). 중복 방지·신규 감지.
- **audit_log** — 값 변경 추적(entity, ticker, field, old, new, source, at). "어디서 온 숫자인가" 거버넌스.
- **(향후) subscriptions** — 알림 구독(email/topic) — v2.

**출처/신선도**는 스냅샷 테이블에 `source`,`fetched_at` 컬럼으로 내장(필드 단위 provenance가 필요해지면 별도 테이블로 확장).

---

## 4. API 명세 (읽기 전용, `/v1`)

| 메서드/경로 | 설명 | 응답 핵심 |
|---|---|---|
| `GET /v1/health` | 헬스체크 | `{ok, time, lastBatch}` |
| `GET /v1/market` | 최신 시장 스냅샷 | seed의 `market`과 동일 shape + `asOfDate`,`source` |
| `GET /v1/reits` | 종목 목록(+최신 시세 머지) | seed의 `reits[]` + `price`,`marketCap`,`yieldPriceBasis`,`priceAsOf` |
| `GET /v1/reits/:ticker` | 상세 | 종목 + 최근 배당 + 최근 공시 + 최신 시세 |
| `GET /v1/reits/:ticker/prices?from&to` | 가격 시계열 | `[{date,close,volume,marketCap}]` |
| `GET /v1/reits/:ticker/filings` | 종목 공시 | `[{rceptNo,title,filedAt,url,category}]` |
| `GET /v1/filings?since=ISO` | 전체 신규 공시 | 변경 피드(알림/홈 배지용) |
| `POST /admin/refresh` | 수동 배치(토큰) | `Authorization: Bearer ADMIN_TOKEN` |

공통: `Cache-Control` + KV 캐시(60~300s), CORS `Access-Control-Allow-Origin: https://seonghoonkim2.github.io`, 에러는 `{error}` JSON. 응답 shape는 **프론트 seed와 1:1로 맞춰** 교체 비용 0에 가깝게.

---

## 5. 수집 파이프라인 (Cron Triggers)

```
"30 10 * * 1-5"  (평일 19:30 KST, 종가 확정 후)  → collectPrices()  + collectMarket()
"0 */2 * * *"    (2시간마다)                      → collectFilings()
```

각 수집기 공통 규약:
1. **idempotent**: 같은 날짜 재실행해도 UPSERT(`INSERT ... ON CONFLICT DO UPDATE`).
2. **검증 후 저장**: 범위/타입 체크 통과한 값만. 실패 시 이전 값 유지 + audit_log 기록.
3. **변경 감지**: 값이 바뀌면 audit_log, 신규 공시면 filings에 insert(=알림 트리거 후보).
4. **부분 실패 격리**: 종목별 try/catch — 한 종목 실패가 배치 전체를 막지 않음.
5. **레이트리밋/재시도**: 소스별 간격 + 지수 백오프.

`collectFilings()`는 프론트의 키워드 스캐너 로직(차입/배당/임차인/증자/해외/과장광고)을 **서버에서 재사용**해 `category`를 자동 분류 → 홈 "신규 공시" 배지와 향후 이메일 알림의 기반.

---

## 6. 보안·운영
- **공개 API는 GET만.** 쓰기/배치는 Cron 또는 `ADMIN_TOKEN` 필요.
- **시크릿**은 `wrangler secret put`. 저장소에 키 금지(.dev.vars는 .gitignore).
- **CORS**는 Pages origin만 허용.
- **PII 없음.** 관심·포트폴리오는 계속 브라우저 localStorage(서버 미전송). 알림(v2)에서 이메일 받을 때만 최소 저장 + 동의/삭제.
- **관측:** Workers 로그 + `audit_log` + `/v1/health`의 `lastBatch`로 신선도 모니터.

---

## 7. 프론트 연동 (비파괴적)
`index.html`에 `API_BASE` 상수 추가:
- 비어 있으면(기본) 지금처럼 내장 seed로 동작.
- 값이 있으면 로드 시 `/v1/market`,`/v1/reits`를 fetch해 `MARKET`/`REITS`를 **머지**(가격·시총·현재가기준수익률·기준일 갱신), 실패 시 seed로 폴백.
- "실시간 아님" 라벨을 API의 `priceAsOf`로 치환("2026-06-13 종가 기준").
- NAV·LTV·공실 등은 여전히 공시 기반 → "공시 확인 필요" 유지(향후 OpenDART 재무 파싱으로 확장).

이렇게 하면 백엔드가 없어도 사이트는 그대로, 있으면 자동 업그레이드.

---

## 8. 단계별 로드맵
- **MVP (1~2주):** D1 스키마 + seed 적재 + `/v1/market`,`/v1/reits` 서빙 + `collectPrices`(일배치) + `collectFilings`(목록) + 프론트 머지. → "어제 종가 기준" 동적 사이트 완성.
- **v1.1 (3~4주):** 가격 시계열 차트, 공시 신규 배지/피드, audit_log 노출, 배당 이력 자동화.
- **v2 (1~2개월):** 이메일 공시 알림(구독·동의·삭제), OpenDART 재무·배당 파싱으로 커버리지 채우기, 관리자 검수 큐.
- **v3+:** 유료 실시간 시세 라이선스, 운용사 인증 IR 룸(계정·권한), B2B 데이터 API.

---

## 9. 비용 (무료 티어 한도, 2026 기준 개략)
- Workers: 10만 req/일 무료 → 개인 트래픽 충분.
- D1: 5GB 저장 + 일 read/write row 한도 무료 범위 내(종목 25개·일별 스냅샷은 매우 작음).
- KV/Cron/Pages: 무료.
- 외부 API: 정부 OpenAPI 무료(키 발급, 일 호출 한도 존재 → 종목 25개라 여유).
→ **v1 운영비 0원.** 유료 실시간 데이터는 v3 진입 시 별도 검토.

---

## 10. 저장소·배포
- 별도 저장소 권장: `reits-on-api`(Workers). 프론트 `reits-on`(Pages)와 분리.
- 배포: `npm i` → `wrangler d1 create reitson` → `wrangler d1 execute reitson --file db/schema.sql` → seed 적재 → `wrangler secret put ...` → `wrangler deploy`. (README 참조)
- 배포 후 프론트 `API_BASE`에 Worker URL 설정 → push → Pages 반영.
