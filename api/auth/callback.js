// /api/auth/callback.js
import {
  ALLOWED_GAMERTAGS,
  CANONICAL_GAMERTAGS,
  DISCORD_TO_GAMERTAG,
  parseCookies,
  serializeCookie,
  signSession,
  verifySession,
} from './_lib.js';

async function exchangeMicrosoftForXboxProfile(code, verifier, redirectUri) {
  // 1. Exchange OAuth2 code for Microsoft Access Token
  const tokenRes = await fetch('https://login.live.com/oauth20_token.srf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET || '',
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`MS token exchange failed: ${errText}`);
  }
  const { access_token: msAccessToken } = await tokenRes.json();

  // 2. Authenticate with Xbox Live User Auth (user.auth.xboxlive.com)
  const xblRes = await fetch('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });

  if (!xblRes.ok) {
    throw new Error(`Xbox Live user auth failed: ${xblRes.status}`);
  }
  const xblData = await xblRes.json();
  const xblToken = xblData.Token;
  const userHash = xblData.DisplayClaims?.xui?.[0]?.uhs;

  // 3. Authorize with Xbox Security Token Service (xsts.auth.xboxlive.com) to get signed Gamertag (gtg) & XUID (xid)
  const xstsRes = await fetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xblToken],
      },
      RelyingParty: 'http://xboxlive.com',
      TokenType: 'JWT',
    }),
  });

  if (!xstsRes.ok) {
    throw new Error(`XSTS authorization failed: ${xstsRes.status}`);
  }
  const xstsData = await xstsRes.json();
  const claims = xstsData.DisplayClaims?.xui?.[0] || {};

  // 4. Optional OpenXBL Live Presence / Gamerpic enrichment if XBL_API_KEY is configured
  let presence = null;
  let gamerpic = null;
  if (process.env.XBL_API_KEY && claims.xid) {
    try {
      const openXblRes = await fetch(`https://xbl.io/api/v2/account/${claims.xid}`, {
        headers: {
          'X-Authorization': process.env.XBL_API_KEY,
          Accept: 'application/json',
        },
      });
      if (openXblRes.ok) {
        const openXblData = await openXblRes.json();
        const person = openXblData?.people?.[0];
        if (person) {
          presence = person.presenceState || person.presenceText || null;
          gamerpic = person.displayPicRaw || null;
        }
      }
    } catch {}
  }

  return {
    provider: 'xbox',
    gamertag: claims.gtg, // Cryptographically signed Xbox Gamertag
    xuid: claims.xid || null,
    uhs: userHash,
    presence,
    avatar: gamerpic,
  };
}

async function exchangeDiscordProfile(code, verifier, redirectUri) {
  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET || '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Discord token exchange failed: ${tokenRes.status}`);
  }
  const { access_token: accessToken } = await tokenRes.json();

  const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!userRes.ok) {
    throw new Error(`Discord profile fetch failed: ${userRes.status}`);
  }
  const user = await userRes.json();
  const rawName = (user.username || '').toLowerCase();
  const mappedGamertag =
    DISCORD_TO_GAMERTAG[user.id] ||
    DISCORD_TO_GAMERTAG[rawName] ||
    user.global_name ||
    user.username;

  return {
    provider: 'discord',
    gamertag: mappedGamertag,
    discordUsername: user.username,
    discordId: user.id,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : null,
  };
}

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  if (error) {
    return res.redirect(302, `/?auth_error=${encodeURIComponent(error)}`);
  }

  const isLocal = (req.headers?.host || '').includes('localhost') || (req.headers?.host || '').includes('127.0.0.1');
  const proto = isLocal ? 'http' : 'https';
  const cookies = parseCookies(req);
  const tx = verifySession(cookies.cz_oauth_tx);

  // Clear one-time PKCE transaction cookie
  const clearTxCookie = serializeCookie('cz_oauth_tx', '', { maxAge: 0, secure: !isLocal });

  if (!tx || !code || !state || tx.state !== state) {
    res.setHeader('Set-Cookie', clearTxCookie);
    return res.redirect(302, '/?auth_error=invalid_state');
  }

  const baseUrl = process.env.APP_BASE_URL || `${proto}://${req.headers.host}`;
  const redirectUri = `${baseUrl}/api/auth/callback`;

  try {
    const profile =
      tx.provider === 'discord'
        ? await exchangeDiscordProfile(code, tx.verifier, redirectUri)
        : await exchangeMicrosoftForXboxProfile(code, tx.verifier, redirectUri);

    const normalizedTag = (profile.gamertag || '').trim().toLowerCase();

    // Enforce CHIBI~ZONE Realm Roster Allowlist
    if (!ALLOWED_GAMERTAGS.has(normalizedTag)) {
      res.setHeader('Set-Cookie', clearTxCookie);
      return res.redirect(
        302,
        `/?auth_error=unauthorized_gamertag&gt=${encodeURIComponent(profile.gamertag || 'unknown')}`
      );
    }

    const canonicalGamertag = CANONICAL_GAMERTAGS[normalizedTag] || profile.gamertag;

    // Issue 7-day HMAC-SHA256 Session Cookie
    const sessionToken = signSession({
      gamertag: canonicalGamertag,
      provider: profile.provider,
      xuid: profile.xuid || null,
      discordId: profile.discordId || null,
      presence: profile.presence || null,
      avatar: profile.avatar || null,
      exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
    });

    const sessionCookie = serializeCookie('cz_session', sessionToken, {
      maxAge: 7 * 24 * 60 * 60,
      secure: !isLocal,
    });

    res.setHeader('Set-Cookie', [clearTxCookie, sessionCookie]);
    return res.redirect(302, `/?auth_success=${encodeURIComponent(canonicalGamertag)}&provider=${encodeURIComponent(profile.provider)}`);
  } catch (err) {
    console.error('[CHIBI~ZONE AUTH ERROR]', err);
    res.setHeader('Set-Cookie', clearTxCookie);
    return res.redirect(302, '/?auth_error=oauth_exchange_failed');
  }
}
