# 리츠온 REITs ON — 백엔드 (Cloudflare Workers + D1)

정적 사이트(GitHub Pages)를 동적으로 키우는 **무료 티어 백엔드**입니다. 매일 공개·무료·합법 데이터를 수집해 읽기 전용 API로 제공합니다.
설계 전체는 [`docs/backend-design.md`](docs/backend-design.md) 참고.

스택: **Cloudflare Workers + Hono(TS) + D1(SQLite) + KV + Cron Triggers**. 데이터: **data.go.kr 금융위 주식시세(EOD) · OpenDART 공시 · MOLIT 리츠정보**.

---

## 빠른 시작

```bash
# 0) 의존성
npm install
npm i -g wrangler   # 또는 npx 사용

# 1) Cloudflare 로그인
wrangler login

# 2) D1 / KV 생성 → 출력된 id를 wrangler.toml에 붙여넣기
wrangler d1 create reitson
wrangler kv namespace create CACHE

# 3) 스키마 적용 (로컬 + 원격)
npm run db:init
npm run db:init:remote

# 4) seed 생성(프론트 index.html에서 추출) 후 적재
npm run seed:build              # → db/seed.sql  (기본 ../reits-on/index.html 사용)
npm run seed:load               # 로컬
npm run seed:load:remote        # 원격(D1)

# 5) 데이터 소스 키 등록 (무료 발급)
wrangler secret put DATA_GO_KR_KEY   # data.go.kr 금융위 주식시세
wrangler secret put OPENDART_KEY     # opendart.fss.or.kr
wrangler secret put MOLIT_KEY        # data.go.kr 리츠정보(선택)
wrangler secret put ADMIN_TOKEN      # 수동 새로고침용 임의 토큰

# 6) 로컬 실행 / 배포
npm run dev                     # http://localhost:8787/v1/health
npm run deploy                  # https://reits-on-api.<계정>.workers.dev
```

배포 후 즉시 동작(시세는 키 등록 + 첫 배치 후 채워짐). 키 없이 배포해도 API는 seed 기반으로 응답하고, 시세 필드는 `null`(프론트에서 "공시 확인 필요").

### 수동 배치 트리거
```bash
curl -X POST https://reits-on-api.<계정>.workers.dev/admin/refresh -H "Authorization: Bearer <ADMIN_TOKEN>"
```

---

## API 요약
- `GET /v1/health` · `GET /v1/market` · `GET /v1/reits` · `GET /v1/reits/:ticker`
- `GET /v1/reits/:ticker/prices?from&to` · `GET /v1/reits/:ticker/filings` · `GET /v1/filings?since=`
- `POST /admin/refresh` (Bearer ADMIN_TOKEN)

## 프론트 연결
프론트 `index.html` 상단 스크립트의 `API_BASE`에 Worker URL을 넣으면, 로드 시 `/v1/market`·`/v1/reits`를 받아 가격·시총·현재가기준 수익률·기준일을 덮어씁니다. 비워두면 기존처럼 내장 seed로 동작(폴백).

## 데이터 키 발급처(무료)
- data.go.kr → "금융위원회 주식시세정보" 활용신청
- opendart.fss.or.kr → 인증키 신청
- data.go.kr → "국토교통부 리츠정보" (선택)

## 주의
교육용. 투자 권유 아님. 정부/금융당국 OpenAPI 약관 내 사용. 네이버·증권사 화면 스크레이핑 금지. 실시간·정밀 시세는 별도 유료 라이선스(v3).
