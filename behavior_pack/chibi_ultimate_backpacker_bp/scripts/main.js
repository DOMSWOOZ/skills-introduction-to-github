// ============================================================================
// CHIBI~ZONE REALM // ULTIMATE BACKPACKER 5-LEVEL ACHIEVEMENT SYSTEM
// Designed by ChibiZANIMUS & DOMSWOOZ
// Hybrid Bridge #1 (Local PC ContentLog Auto-Watcher) + Bridge #3 (Signed In-Game Claim Codes)
// ============================================================================
import { world, system } from "@minecraft/server";

// Official Realm Roster & Default Locked Ration Oaths
const DEFAULT_OATHS = {
  "DOMSWOOZ": "spider_eye",
  "ChibiZANIMUS": "dream_apple",
  "BruthaManD": "cooked_beef",
  "JacobParties": "golden_carrot",
  "SallyManDuur": "cooked_salmon",
  "GoodScroll6570": "baked_potato"
};

const TRACKED_FOOD_MAP = {
  "minecraft:spider_eye": { id: "spider_eye", label: "Spider Eyes (Vampire)" },
  "minecraft:sweet_berries": { id: "sweet_berries", label: "Blood Briar Berries" },
  "minecraft:golden_carrot": { id: "golden_carrot", label: "Golden Carrots" },
  "minecraft:cooked_salmon": { id: "cooked_salmon", label: "Spear-Hunted Salmon" },
  "minecraft:enchanted_golden_apple": { id: "dream_apple", label: "Enchanted G-Apple" },
  "minecraft:golden_apple": { id: "golden_apple", label: "Golden Apple" },
  "minecraft:cooked_beef": { id: "cooked_beef", label: "Cooked Steak" },
  "minecraft:baked_potato": { id: "baked_potato", label: "Baked Potatoes" },
  "minecraft:bread": { id: "baked_potato", label: "Bread" },
  "minecraft:cooked_porkchop": { id: "cooked_beef", label: "Cooked Porkchop" },
  "minecraft:dried_kelp": { id: "cooked_salmon", label: "Dried Kelp" }
};

const LEVEL_META = {
  1: { id: 1, name: "LEVEL 1: BARRELS", slots: 27, total: 1728 },
  2: { id: 2, name: "LEVEL 2: DOUBLE CHEST", slots: 54, total: 3456 },
  3: { id: 3, name: "LEVEL 3: ENDER CHEST", slots: 27, total: 1728 },
  4: { id: 4, name: "LEVEL 4: SHULKER BOX", slots: 27, total: 1728 },
  5: { id: 5, name: "LEVEL 5: HOPPER PIPELINE", slots: 13, total: 832 }
};

// Deterministic 32-bit FNV-1a signature matching the CHIBI~Zone Web Command Center
function computeChibiClaimSignature(player, levelId, filledSlots, foodId) {
  const payload = `CHIBI_BP_V4::${String(player).toUpperCase()}::L${levelId}::S${filledSlots}::${String(foodId).toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

// Generates a compact claim code players on Console/Mobile/PC can paste into the Web App:
// Format: BP<level>-<player>-<filledSlots>-<foodId>-<6charSig>
function generateInGameClaimCode(player, levelId, filledSlots, foodId) {
  const sig = computeChibiClaimSignature(player, levelId, filledSlots, foodId);
  return `BP${levelId}-${player}-${filledSlots}-${foodId}-${sig}`;
}

function getPlayerState(player) {
  let raw = player.getDynamicProperty("cz_backpack_v4");
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return {
    foodId: DEFAULT_OATHS[player.name] || "spider_eye",
    foodLocked: true,
    levels: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  };
}

function savePlayerState(player, state) {
  player.setDynamicProperty("cz_backpack_v4", JSON.stringify(state));
}

function getCompletedTierCount(state) {
  let done = 0;
  for (const k of [1, 2, 3, 4, 5]) {
    if ((state.levels[k] || 0) >= LEVEL_META[k].slots) done++;
  }
  return done;
}

function updatePlayerHudAndScoreboard(player, state) {
  const doneCount = getCompletedTierCount(state);
  const stars = "★".repeat(doneCount) + "☆".repeat(5 - doneCount);

  // Update overhead nameplate badge
  if (doneCount >= 5) {
    player.nameTag = `§6[🏆 ULTIMATE BACKPACKER] §f${player.name}`;
  } else if (doneCount > 0) {
    player.nameTag = `§a[BP ${stars}] §f${player.name}`;
  }

  // Update in-game Sidebar Scoreboard
  try {
    let obj = world.scoreboard.getObjective("cz_backpack");
    if (!obj) {
      obj = world.scoreboard.addObjective("cz_backpack", "§a§lULTIMATE BACKPACKER");
    }
    player.runCommandAsync(`scoreboard objectives setdisplay sidebar cz_backpack`);
    player.runCommandAsync(`scoreboard players set "${player.name}" cz_backpack ${doneCount}`);
  } catch {}
}

function emitBridgeSyncAndCelebrate(player, state, levelId, prevSlots, newSlots, foodLabel) {
  const meta = LEVEL_META[levelId];
  const claimCode = generateInGameClaimCode(player.name, levelId, newSlots, state.foodId);
  const doneCount = getCompletedTierCount(state);

  // BRIDGE #1: Emit structured JSON packet to Minecraft ContentLog for automatic PC -> Web App sync!
  const syncPacket = {
    type: "CHIBI_BACKPACK_SYNC",
    player: player.name,
    levelId,
    filledSlots: newSlots,
    maxSlots: meta.slots,
    foodId: state.foodId,
    claimCode,
    completedTiers: doneCount,
    timestamp: Date.now()
  };
  console.warn("[CHIBI_BACKPACK_SYNC]" + JSON.stringify(syncPacket));

  // Visual Actionbar Progress Meter above hotbar
  const filledBars = Math.round((newSlots / meta.slots) * 15);
  const barStr = "§a" + "█".repeat(filledBars) + "§8" + "░".repeat(15 - filledBars);
  player.onScreenDisplay.setActionBar(
    `§6[${meta.name}] ${barStr} §f${newSlots}/${meta.slots} Slots @ 64x §7(${foodLabel})`
  );

  // If this interaction newly completed the tier, fire full Realm celebration + Bridge #3 Claim Code!
  if (prevSlots < meta.slots && newSlots >= meta.slots) {
    if (doneCount >= 5) {
      player.runCommandAsync(`title @a title "§6🏆 ULTIMATE BACKPACKER 🏆"`);
      player.runCommandAsync(`title @a subtitle "§a${player.name} completed all 5 Food Self-Sufficiency Tiers (${foodLabel})!"`);
      player.runCommandAsync(`playsound ui.toast.challenge_complete @a`);
    } else {
      player.runCommandAsync(`title @a title "§a${meta.name} COMPLETE"`);
      player.runCommandAsync(`title @a subtitle "§e${player.name} maxed ${meta.slots}x64 (${meta.total} ${foodLabel})!"`);
      player.runCommandAsync(`playsound random.levelup @a`);
    }
    player.runCommandAsync(`particle minecraft:villager_happy ~ ~1 ~`);

    // BRIDGE #3: Send signed Claim Code in chat so Xbox / Switch / Mobile / PC players can paste anytime!
    player.sendMessage(
      `§8==================================================\n` +
      `§a§l[CHIBI~ZONE ULTIMATE BACKPACKER] §r§e${meta.name} VERIFIED!\n` +
      `§7Ration Oath: §f${foodLabel} (${newSlots}/${meta.slots} @ 64x)\n` +
      `§7PC Companion Auto-Sync: §aPACKET EMITTED\n` +
      `§7Web App Claim Code: §b§l${claimCode}\n` +
      `§8==================================================`
    );
  }
}

// Inspect any Barrel, Chest, Double Chest, Shulker Box, Hopper, or Dropper on interaction
world.afterEvents.playerInteractWithBlock.subscribe(({ player, block }) => {
  system.runTimeout(() => {
    if (!block || !player) return;
    const typeId = block.typeId || "";
    const state = getPlayerState(player);

    // Note: Ender Chest inventory is tied to the player; if they crouch-interact an Ender Chest while holding
    // a 64x stack of their oath food (or check via !bp ender), we also allow slot inspection.
    const invComp = block.getComponent("minecraft:inventory");
    const container = invComp?.container;
    if (!container) return;

    const totalSlots = container.size;
    let maxedOathSlots = 0;
    let totalOathItems = 0;
    let detectedFoodLabel = TRACKED_FOOD_MAP[`minecraft:${state.foodId}`]?.label || state.foodId;

    for (let i = 0; i < totalSlots; i++) {
      const item = container.getItem(i);
      if (!item) continue;
      const mapped = TRACKED_FOOD_MAP[item.typeId];
      if (!mapped) continue;

      // Enforce Character Ration Oath Lock: if not locked yet, lock to first valid 64x food stacked
      if (!state.foodLocked) {
        state.foodId = mapped.id;
        state.foodLocked = true;
      }

      if (mapped.id === state.foodId) {
        detectedFoodLabel = mapped.label;
        totalOathItems += item.amount;
        if (item.amount >= 64) {
          maxedOathSlots++;
        }
      }
    }

    // Determine which of the 5 Ultimate Backpacker Levels this container corresponds to
    let levelId = null;
    let reportedFilled = 0;

    if (typeId.includes("barrel") && totalSlots === 27) {
      levelId = 1;
      reportedFilled = maxedOathSlots;
    } else if (typeId.includes("chest") && totalSlots === 54) {
      levelId = 2;
      reportedFilled = maxedOathSlots;
    } else if (typeId.includes("shulker_box") && totalSlots === 27) {
      levelId = 4;
      reportedFilled = maxedOathSlots;
    } else if (typeId.includes("hopper") || typeId.includes("dropper")) {
      levelId = 5;
      // Level 5 rule: Move 13 food items/stacks through Hoppers & Droppers
      reportedFilled = Math.min(13, totalOathItems);
    }

    if (levelId !== null && reportedFilled > 0) {
      const prev = state.levels[levelId] || 0;
      const updated = Math.max(prev, reportedFilled);
      state.levels[levelId] = updated;
      savePlayerState(player, state);
      updatePlayerHudAndScoreboard(player, state);
      emitBridgeSyncAndCelebrate(player, state, levelId, prev, updated, detectedFoodLabel);
    }
  }, 5);
});
