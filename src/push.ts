import type { Env } from './index';

// 웹 푸시(VAPID, payload 없음). 본문 암호화(aes128gcm) 없이 알림 트리거만 보냄 →
// 서비스워커가 일반 문구("새 공시가 있어요")로 표시. 신뢰성↑·구현 단순.
// VAPID 공개키는 프론트(index.html)와 동일해야 함. 개인키는 Worker 시크릿(VAPID_PRIVATE_KEY).
export const VAPID_PUBLIC = 'BEpt_ghugX3gqW6z2SgCclHj7Dk9c2Qjdn9eTimlSmg07RwW5qAcXdE34y0WFHRHaC-WG9ZuNeJ4qHrx2fiFKGY';
const VAPID_SUBJECT = 'mailto:seonghoon.kim2@gmail.com';

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s + pad);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
function bytesToB64url(buf: ArrayBuffer | Uint8Array): string {
  const u = new Uint8Array(buf as ArrayBuffer);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function importVapidKey(privB64: string): Promise<CryptoKey> {
  const pub = b64urlToBytes(VAPID_PUBLIC); // 0x04 | X(32) | Y(32)
  const x = bytesToB64url(pub.slice(1, 33));
  const y = bytesToB64url(pub.slice(33, 65));
  const jwk: JsonWebKey = { kty: 'EC', crv: 'P-256', d: privB64, x, y, ext: true, key_ops: ['sign'] };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

async function vapidAuth(endpoint: string, privB64: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const enc = (o: any) => bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
  const header = enc({ typ: 'JWT', alg: 'ES256' });
  const payload = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT });
  const signingInput = header + '.' + payload;
  const key = await importVapidKey(privB64);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  const jwt = signingInput + '.' + bytesToB64url(sig);
  return 'vapid t=' + jwt + ', k=' + VAPID_PUBLIC;
}

async function ensureTable(env: Env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created_at TEXT)').run();
}

export async function savePushSub(env: Env, sub: any): Promise<boolean> {
  if (!sub || !sub.endpoint) return false;
  await ensureTable(env);
  await env.DB.prepare(
    'INSERT INTO push_subs (endpoint,p256dh,auth,created_at) VALUES (?1,?2,?3,datetime(\'now\')) ON CONFLICT(endpoint) DO NOTHING'
  ).bind(sub.endpoint, (sub.keys && sub.keys.p256dh) || '', (sub.keys && sub.keys.auth) || '').run();
  return true;
}

// 새 '주요' 공시가 있으면 구독자에게 payload 없는 푸시 발송(cron에서 호출).
const IMPORTANT = /유상증자|증자|감자|합병|분할|매각|처분|취득|편입|차입|사채|배당|특별|상장폐지|관리종목|회생|파산/;
export async function pushNewFilings(env: Env): Promise<string> {
  if (!env.VAPID_PRIVATE_KEY) return 'skip: VAPID_PRIVATE_KEY 없음';
  await ensureTable(env);
  const last = (await env.CACHE.get('push:lastFiledAt')) || '0000-00-00';
  const rows = await env.DB.prepare(
    'SELECT title, filed_at FROM filings WHERE filed_at > ?1 ORDER BY filed_at DESC LIMIT 30'
  ).bind(last).all();
  const list = (rows.results || []) as any[];
  if (list.length && list[0].filed_at) await env.CACHE.put('push:lastFiledAt', list[0].filed_at);
  const important = list.filter((f) => IMPORTANT.test(f.title || ''));
  if (!important.length) return `no new important (scanned ${list.length})`;
  const subs = await env.DB.prepare('SELECT endpoint FROM push_subs').all();
  const auths: Record<string, string> = {};
  let ok = 0, gone = 0, fail = 0;
  for (const s of (subs.results || []) as any[]) {
    try {
      const origin = new URL(s.endpoint).origin;
      if (!auths[origin]) auths[origin] = await vapidAuth(s.endpoint, env.VAPID_PRIVATE_KEY);
      const res = await fetch(s.endpoint, { method: 'POST', headers: { Authorization: auths[origin], TTL: '86400' } });
      if (res.status === 201 || res.status === 200) ok++;
      else if (res.status === 404 || res.status === 410) { await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?1').bind(s.endpoint).run(); gone++; }
      else fail++;
    } catch { fail++; }
  }
  return `push ok=${ok} gone=${gone} fail=${fail} important=${important.length}`;
}
