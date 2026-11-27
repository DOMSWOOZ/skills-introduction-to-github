// /api/auth/_lib.js
import crypto from 'node:crypto';

export const CANONICAL_GAMERTAGS = {
  domswooz: 'DOMSWOOZ',
  'swooz.eth': 'DOMSWOOZ',
  swooz: 'DOMSWOOZ',
  chibizanimus: 'ChibiZANIMUS',
  'chibi~zane': 'ChibiZANIMUS',
  bruthamand: 'BruthaManD',
  jacobparties: 'JacobParties',
  sallymanduur: 'SallyManDuur',
  '47.salamanders': 'SallyManDuur',
  goodscroll6570: 'GoodScroll6570',
  zombieguy: 'GoodScroll6570',
};

export const ALLOWED_GAMERTAGS = new Set(Object.keys(CANONICAL_GAMERTAGS));

// Optional: Map verified Discord usernames/IDs to Realm Gamertags
export const DISCORD_TO_GAMERTAG = {
  domswooz: 'DOMSWOOZ',
  swooz: 'DOMSWOOZ',
  'swooz.eth': 'DOMSWOOZ',
  chibizanimus: 'ChibiZANIMUS',
  bruthamand: 'BruthaManD',
  jacobparties: 'JacobParties',
  sallymanduur: 'SallyManDuur',
  '47.salamanders': 'SallyManDuur',
  goodscroll6570: 'GoodScroll6570',
  zombieguy: 'GoodScroll6570',
};

// Default fallback secret so PKCE cookie signing works immediately before custom env var is added
const DEFAULT_HMAC_FALLBACK = 'e8b47c19f53d21a6c0947f2e84b1a3d5f709c2b84e61d3a59c7f20e41b8d63a9';

function getHmacSecret() {
  return process.env.SESSION_HMAC_SECRET || DEFAULT_HMAC_FALLBACK;
}

export function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function generatePkcePair() {
  const verifier = base64UrlEncode(crypto.randomBytes(32));
  const challenge = base64UrlEncode(
    crypto.createHash('sha256').update(verifier).digest()
  );
  const state = base64UrlEncode(crypto.randomBytes(24));
  return { verifier, challenge, state };
}

export function signSession(payload) {
  const secret = getHmacSecret();
  const data = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(data).digest()
  );
  return `${data}.${sig}`;
}

export function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const secret = getHmacSecret();

  const [data, sig] = token.split('.');
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(data).digest()
  );

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (parsed.exp && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx === -1
          ? [part, '']
          : [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
      })
  );
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (typeof options.maxAge === 'number') parts.push(`Max-Age=${options.maxAge}`);
  return parts.join('; ');
}
