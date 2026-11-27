// /api/auth/me.js
import { parseCookies, verifySession } from './_lib.js';

export default function handler(req, res) {
  const cookies = parseCookies(req);
  const session = verifySession(cookies.cz_session);

  const configuredProviders = {
    xbox: !!process.env.MICROSOFT_CLIENT_ID,
    discord: !!process.env.DISCORD_CLIENT_ID,
    openxbl: !!process.env.XBL_API_KEY,
  };

  if (!session) {
    return res.status(401).json({
      authenticated: false,
      configuredProviders,
    });
  }

  return res.status(200).json({
    authenticated: true,
    gamertag: session.gamertag,
    provider: session.provider,
    xuid: session.xuid,
    discordId: session.discordId || null,
    presence: session.presence || null,
    avatar: session.avatar || null,
    configuredProviders,
  });
}
