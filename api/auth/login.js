// /api/auth/login.js
import { generatePkcePair, serializeCookie, signSession } from './_lib.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const provider = (req.query?.provider || 'xbox').toLowerCase();
  const isLocal = (req.headers?.host || '').includes('localhost') || (req.headers?.host || '').includes('127.0.0.1');
  const proto = isLocal ? 'http' : 'https';
  const baseUrl = process.env.APP_BASE_URL || `${proto}://${req.headers.host}`;
  const { verifier, challenge, state } = generatePkcePair();

  // Store PKCE verifier + state in a signed, short-lived HttpOnly cookie (10 mins)
  const oauthCookie = serializeCookie(
    'cz_oauth_tx',
    signSession({
      provider,
      state,
      verifier,
      exp: Date.now() + 10 * 60 * 1000,
    }),
    { maxAge: 600, secure: !isLocal }
  );

  res.setHeader('Set-Cookie', oauthCookie);

  if (provider === 'xbox' || provider === 'microsoft') {
    const clientId = process.env.MICROSOFT_CLIENT_ID;
    if (!clientId) {
      return res.redirect(
        302,
        `/?auth_error=missing_microsoft_client_id&provider=xbox&redirect_uri=${encodeURIComponent(baseUrl + '/api/auth/callback')}`
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: `${baseUrl}/api/auth/callback`,
      response_mode: 'query',
      scope: 'XboxLive.signin offline_access',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });

    return res.redirect(
      302,
      `https://login.live.com/oauth20_authorize.srf?${params.toString()}`
    );
  }

  if (provider === 'discord') {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId) {
      return res.redirect(
        302,
        `/?auth_error=missing_discord_client_id&provider=discord&redirect_uri=${encodeURIComponent(baseUrl + '/api/auth/callback')}`
      );
    }

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: `${baseUrl}/api/auth/callback`,
      scope: 'identify',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    return res.redirect(
      302,
      `https://discord.com/api/oauth2/authorize?${params.toString()}`
    );
  }

  return res.status(400).json({ error: 'Unsupported provider' });
}
