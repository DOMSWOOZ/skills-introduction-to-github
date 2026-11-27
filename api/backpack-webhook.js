// /api/backpack-webhook.js
// Receives live container completion events from Minecraft Bedrock Script API (@minecraft/server-net)
// or the in-app Webhook Test button.

const LEVEL_SLOTS = {
  1: 27, // Barrels (27 x 64 = 1,728)
  2: 54, // Double Chests (54 x 64 = 3,456)
  3: 27, // Ender Chest (27 x 64 = 1,728)
  4: 27, // Shulker Boxes (27 x 64 = 1,728)
  5: 13, // Hoppers & Droppers Automated Pipeline (13 items/stacks)
};

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

  const player = (body?.player || 'DOMSWOOZ').trim();
  const levelId = Number(body?.levelId || 1);
  const maxSlots = LEVEL_SLOTS[levelId] || 27;
  const filledSlots = Math.min(maxSlots, Math.max(0, Number(body?.filledSlots ?? maxSlots)));
  const foodId = body?.foodId || 'golden_apple';

  return res.status(200).json({
    ok: true,
    player,
    levelId,
    filledSlots,
    maxSlots,
    complete: filledSlots >= maxSlots,
    foodId,
    titleCommand:
      levelId === 5 && filledSlots >= maxSlots
        ? `title @a title "§6ULTIMATE BACKPACKER"`
        : `title @a title "§aLEVEL ${levelId} COMPLETE"`,
    timestamp: Date.now(),
  });
}
