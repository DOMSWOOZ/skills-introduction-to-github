// /api/backpack-webhook.js
// Hybrid Bridge #1 (PC ContentLog Auto-Watcher / BDS Webhook) + Bridge #3 (Signed In-Game Claim Code Verifier)

const LEVEL_SLOTS = {
  1: 27, // Barrels (27 x 64 = 1,728)
  2: 54, // Double Chests (54 x 64 = 3,456)
  3: 27, // Ender Chest (27 x 64 = 1,728)
  4: 27, // Shulker Boxes (27 x 64 = 1,728)
  5: 13, // Hoppers & Droppers Automated Pipeline (13 items/stacks)
};

// Deterministic 32-bit FNV-1a signature matching the in-game Bedrock Behavior Pack (scripts/main.js)
export function computeChibiClaimSignature(player, levelId, filledSlots, foodId) {
  const payload = `CHIBI_BP_V4::${String(player).toUpperCase()}::L${levelId}::S${filledSlots}::${String(foodId).toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
}

export function generateInGameClaimCode(player, levelId, filledSlots, foodId) {
  const sig = computeChibiClaimSignature(player, levelId, filledSlots, foodId);
  return `BP${levelId}-${player}-${filledSlots}-${foodId}-${sig}`;
}

export function parseAndVerifyClaimCode(codeStr) {
  if (!codeStr || typeof codeStr !== 'string') {
    return { valid: false, error: 'Empty claim code' };
  }
  // Format: BP<levelId>-<player>-<filledSlots>-<foodId>-<sig>
  const clean = codeStr.trim();
  const match = clean.match(/^BP([1-5])-([A-Za-z0-9_~.-]+)-(\d+)-([a-z0-9_]+)-([A-Z0-9]{6})$/i);
  if (!match) {
    return {
      valid: false,
      error: 'Invalid format. Expected: BP<1..5>-<Gamertag>-<Slots>-<food_id>-<6CHAR_SIG>',
    };
  }
  const levelId = Number(match[1]);
  const player = match[2];
  const filledSlots = Number(match[3]);
  const foodId = match[4].toLowerCase();
  const providedSig = match[5].toUpperCase();

  const expectedSig = computeChibiClaimSignature(player, levelId, filledSlots, foodId);
  if (providedSig !== expectedSig) {
    return {
      valid: false,
      error: 'Cryptographic signature mismatch — code was altered or invalid.',
    };
  }

  const maxSlots = LEVEL_SLOTS[levelId] || 27;
  return {
    valid: true,
    player,
    levelId,
    filledSlots: Math.min(maxSlots, Math.max(0, filledSlots)),
    maxSlots,
    foodId,
    signature: expectedSig,
    claimCode: clean,
  };
}

export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  // Mode A: Verify a Bridge #3 In-Game Claim Code
  if (body?.claimCode) {
    const verified = parseAndVerifyClaimCode(body.claimCode);
    if (!verified.valid) {
      return res.status(400).json({ ok: false, error: verified.error });
    }
    return res.status(200).json({
      ok: true,
      bridge: 'BRIDGE_3_CLAIM_CODE',
      player: verified.player,
      levelId: verified.levelId,
      filledSlots: verified.filledSlots,
      maxSlots: verified.maxSlots,
      complete: verified.filledSlots >= verified.maxSlots,
      foodId: verified.foodId,
      claimCode: verified.claimCode,
      timestamp: Date.now(),
    });
  }

  // Mode B: Direct Webhook / Bridge #1 ContentLog Auto-Watcher / Test Trigger
  const player = (body?.player || 'DOMSWOOZ').trim();
  const levelId = Number(body?.levelId || 1);
  const maxSlots = LEVEL_SLOTS[levelId] || 27;
  const filledSlots = Math.min(maxSlots, Math.max(0, Number(body?.filledSlots ?? maxSlots)));
  const foodId = body?.foodId || 'spider_eye';
  const claimCode = generateInGameClaimCode(player, levelId, filledSlots, foodId);

  return res.status(200).json({
    ok: true,
    bridge: body?.bridge || 'BRIDGE_1_CONTENT_LOG',
    player,
    levelId,
    filledSlots,
    maxSlots,
    complete: filledSlots >= maxSlots,
    foodId,
    claimCode,
    titleCommand:
      levelId === 5 && filledSlots >= maxSlots
        ? `title @a title "§6ULTIMATE BACKPACKER"`
        : `title @a title "§aLEVEL ${levelId} COMPLETE"`,
    timestamp: Date.now(),
  });
}
