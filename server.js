import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import loginHandler from './api/auth/login.js';
import callbackHandler from './api/auth/callback.js';
import meHandler from './api/auth/me.js';
import logoutHandler from './api/auth/logout.js';
import backpackWebhookHandler, { parseAndVerifyClaimCode } from './api/backpack-webhook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load local .env.local if present
const envFile = path.join(__dirname, '.env.local');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

const PORT = process.env.PORT || 3456;
const STATE_FILE = path.join(__dirname, 'realm-state.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mcpack': 'application/octet-stream',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

// ============================================================================
// BRIDGE #1: MINECRAFT FOR WINDOWS CONTENTLOG AUTO-WATCHER
// Automatically tails Minecraft Bedrock ContentLog files for [CHIBI_BACKPACK_SYNC]
// packets and updates realm-state.json in real time!
// ============================================================================
const MC_LOG_DIRS = [
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Packages', 'Microsoft.MinecraftUWP_8wekyb3d8bbwe', 'LocalState', 'logs')
    : null,
  process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Minecraft Bedrock', 'logs')
    : null,
  path.join(__dirname, 'mc_logs'),
].filter(Boolean);

const processedLogSignatures = new Set();
let lastSyncedBridgeEvent = null;

function applyBackpackSyncToStateFile({ player, levelId, filledSlots, foodId, claimCode, bridge }) {
  try {
    let saved = {};
    if (fs.existsSync(STATE_FILE)) {
      saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
    if (!saved.backpackProgress) saved.backpackProgress = {};
    if (!saved.backpackProgress[player]) {
      saved.backpackProgress[player] = {
        foodId: foodId || 'spider_eye',
        foodLocked: true,
        activeLevel: levelId,
        levels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      };
    }
    const bp = saved.backpackProgress[player];
    if (!bp.levels) bp.levels = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    if (foodId && !bp.foodLocked) {
      bp.foodId = foodId;
    }
    bp.foodLocked = true;
    bp.activeLevel = levelId;
    bp.levels[levelId] = Math.max(bp.levels[levelId] || 0, Number(filledSlots || 0));

    lastSyncedBridgeEvent = {
      player,
      levelId,
      filledSlots: bp.levels[levelId],
      foodId: bp.foodId,
      claimCode,
      bridge,
      timestamp: Date.now(),
    };
    saved.lastSyncedBridgeEvent = lastSyncedBridgeEvent;
    fs.writeFileSync(STATE_FILE, JSON.stringify(saved), 'utf8');
  } catch (err) {
    console.error('Failed to persist backpack sync packet:', err.message);
  }
}

function scanMinecraftContentLogs() {
  for (const dir of MC_LOG_DIRS) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().includes('contentlog') || f.endsWith('.txt') || f.endsWith('.log'))
        .map((f) => ({ name: f, fullPath: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 3);

      for (const file of files) {
        const content = fs.readFileSync(file.fullPath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const markerIdx = line.indexOf('[CHIBI_BACKPACK_SYNC]');
          if (markerIdx === -1) continue;
          const jsonStr = line.slice(markerIdx + '[CHIBI_BACKPACK_SYNC]'.length).trim();
          const dedupeKey = `${file.name}::${jsonStr}`;
          if (processedLogSignatures.has(dedupeKey)) continue;
          processedLogSignatures.add(dedupeKey);
          try {
            const pkt = JSON.parse(jsonStr);
            if (pkt && pkt.player && pkt.levelId) {
              console.log(`[BRIDGE #1 AUTO-SYNC] Detected In-Game Completion: ${pkt.player} Level ${pkt.levelId} (${pkt.filledSlots} slots)`);
              applyBackpackSyncToStateFile({
                player: pkt.player,
                levelId: Number(pkt.levelId),
                filledSlots: Number(pkt.filledSlots),
                foodId: pkt.foodId,
                claimCode: pkt.claimCode,
                bridge: 'BRIDGE_1_CONTENT_LOG',
              });
            }
          } catch {}
        }
      }
    } catch {}
  }
}
setInterval(scanMinecraftContentLogs, 2500);

function decorateReqRes(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost:3456'}`);
  req.query = Object.fromEntries(parsedUrl.searchParams.entries());
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(obj));
    return res;
  };
  res.redirect = (codeOrUrl, maybeUrl) => {
    const status = typeof codeOrUrl === 'number' ? codeOrUrl : 302;
    const target = typeof codeOrUrl === 'number' ? maybeUrl : codeOrUrl;
    res.writeHead(status, { Location: target });
    res.end();
    return res;
  };
  return parsedUrl.pathname;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const cleanUrl = decorateReqRes(req, res);

  // Serverless /api/auth/* routes
  if (cleanUrl === '/api/auth/login') return loginHandler(req, res);
  if (cleanUrl === '/api/auth/callback') return callbackHandler(req, res);
  if (cleanUrl === '/api/auth/me') return meHandler(req, res);
  if (cleanUrl === '/api/auth/logout') return logoutHandler(req, res);

  // Bridge #1 & Bridge #3 Webhook + Claim Code Verification
  if (cleanUrl === '/api/backpack-webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch {
        req.body = {};
      }
      if (req.body.claimCode) {
        const verified = parseAndVerifyClaimCode(req.body.claimCode);
        if (verified.valid) {
          applyBackpackSyncToStateFile({
            player: verified.player,
            levelId: verified.levelId,
            filledSlots: verified.filledSlots,
            foodId: verified.foodId,
            claimCode: verified.claimCode,
            bridge: 'BRIDGE_3_CLAIM_CODE',
          });
        }
      } else {
        applyBackpackSyncToStateFile({
          player: req.body.player || 'DOMSWOOZ',
          levelId: Number(req.body.levelId || 1),
          filledSlots: Number(req.body.filledSlots || 27),
          foodId: req.body.foodId || 'spider_eye',
          claimCode: req.body.claimCode,
          bridge: req.body.bridge || 'BRIDGE_1_CONTENT_LOG',
        });
      }
      return backpackWebhookHandler(req, res);
    });
    return;
  }

  if (cleanUrl === '/api/state' && req.method === 'GET') {
    if (fs.existsSync(STATE_FILE)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(fs.readFileSync(STATE_FILE, 'utf8'));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ empty: true }));
    }
  }

  if (cleanUrl === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        JSON.parse(body);
        fs.writeFileSync(STATE_FILE, body, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Serve static files from /assets/
  if (cleanUrl.startsWith('/assets/')) {
    const safeName = path.basename(cleanUrl);
    const assetPath = path.join(__dirname, 'assets', safeName);
    if (fs.existsSync(assetPath)) {
      const ext = path.extname(assetPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=86400',
      };
      if (ext === '.mcpack') {
        headers['Content-Disposition'] = `attachment; filename="${safeName}"`;
      }
      res.writeHead(200, headers);
      return fs.createReadStream(assetPath).pipe(res);
    } else {
      res.writeHead(404);
      return res.end('Asset not found');
    }
  }

  // Serve index.html
  fs.readFile(INDEX_FILE, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`CHIBI~Zone Realm Command Board running at http://localhost:${PORT}`);
});
