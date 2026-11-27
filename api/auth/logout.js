// /api/auth/logout.js
import { serializeCookie } from './_lib.js';

export default function handler(req, res) {
  const isLocal = (req.headers?.host || '').includes('localhost') || (req.headers?.host || '').includes('127.0.0.1');
  res.setHeader(
    'Set-Cookie',
    serializeCookie('cz_session', '', { maxAge: 0, secure: !isLocal })
  );
  return res.status(200).json({ ok: true });
}
