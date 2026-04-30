const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { getYisimPath } = require('./runtime_paths');

const YISIM_DIR = getYisimPath();
const DEFAULT_ROLL_MODE = 'average';
const AVERAGE_SIM_RUNS = 100;

let yisimRuntimePromise = null;
let lastSimulationKey = null;
let lastSimulationResult = null;
let cardNameTranslationsCache = null;
let exactDetectedCardIdsCache = null;
let swogiKeySetCache = null;

const DREAM_NAME_ALIASES = {
  '梦·凝意决': '梦·凝意诀'
};

function normalizeDetectedName(name) {
  const normalized = (name || '').replace(/[•·]/g, '·').trim();
  return DREAM_NAME_ALIASES[normalized] || normalized;
}

function loadCardNameTranslations() {
  if (cardNameTranslationsCache) return cardNameTranslationsCache;

  const translations = {};
  try {
    const namesPath = path.join(YISIM_DIR, 'names.json');
    const names = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    if (Array.isArray(names)) {
      names.forEach((entry) => {
        const chineseName = normalizeDetectedName(entry?.namecn);
        const englishName = typeof entry?.name === 'string' ? entry.name.trim() : '';
        if (!chineseName || !englishName || translations[chineseName]) return;
        translations[chineseName] = englishName;
      });
    }
  } catch (error) {
    console.error('Failed to load yi-sim card name translations', error);
  }

  cardNameTranslationsCache = translations;
  return cardNameTranslationsCache;
}

function loadExactDetectedCardIds() {
  if (exactDetectedCardIdsCache) return exactDetectedCardIdsCache;

  const exactIds = {};

  try {
    const namesPath = path.join(YISIM_DIR, 'names.json');
    const swogiPath = path.join(YISIM_DIR, 'swogi.json');
    const names = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    const swogi = JSON.parse(fs.readFileSync(swogiPath, 'utf8'));

    const baseNames = {};
    if (Array.isArray(names)) {
      names.forEach((entry) => {
        const id = String(entry?.id || '');
        const chineseName = normalizeDetectedName(entry?.namecn);
        if (!id || !chineseName) return;
        baseNames[id] = chineseName;
      });
    }

    Object.keys(swogi || {}).forEach((cardId) => {
      const level = Number.parseInt(cardId.slice(-1), 10);
      if (!Number.isFinite(level)) return;
      const baseId = `${cardId.slice(0, -1)}1`;
      const chineseName = baseNames[cardId] || baseNames[baseId];
      if (!chineseName) return;
      exactIds[`${chineseName} (level ${level})`] = cardId;
      if (cardId.endsWith('1')) {
        exactIds[chineseName] = cardId;
      }
    });
  } catch (error) {
    console.error('Failed to load exact yi-sim detected-card ids', error);
  }

  exactDetectedCardIdsCache = exactIds;
  return exactDetectedCardIdsCache;
}

function loadSwogiKeySet() {
  if (swogiKeySetCache) return swogiKeySetCache;
  try {
    const swogi = JSON.parse(fs.readFileSync(path.join(YISIM_DIR, 'swogi.json'), 'utf8'));
    swogiKeySetCache = new Set(Object.keys(swogi || {}));
  } catch (error) {
    console.error('Failed to load swogi key set', error);
    swogiKeySetCache = new Set();
  }
  return swogiKeySetCache;
}

function swogiIdExists(id) {
  if (id == null) return false;
  return loadSwogiKeySet().has(String(id));
}

function findSwogiIdForPrefixLevel(prefix, level) {
  const candidate = `${prefix}${level}`;
  return swogiIdExists(candidate) ? candidate : null;
}

function getMaxLevelForPrefix(prefix) {
  const keys = loadSwogiKeySet();
  let maxLevel = 0;
  for (const key of keys) {
    if (key.length === prefix.length + 1 && key.startsWith(prefix)) {
      const level = Number.parseInt(key.slice(-1), 10);
      if (Number.isFinite(level) && level > maxLevel) maxLevel = level;
    }
  }
  return maxLevel;
}

const RUNTIME_KEY_PLACEHOLDER = /\{n\}/g;

function resolveRuntimeKey(runtimeKey, position) {
  if (!runtimeKey || typeof runtimeKey !== 'string') return null;
  if (!runtimeKey.includes('{n}')) return runtimeKey;
  if (!Number.isFinite(Number(position))) return null;
  return runtimeKey.replace(RUNTIME_KEY_PLACEHOLDER, String(Number(position)));
}

function normalizeTalents(rawTalents) {
  if (!Array.isArray(rawTalents)) return [];
  return rawTalents
    .filter((talent) => talent && talent.detected)
    .map((talent) => ({
      position: Number(talent.position) || null,
      name: typeof talent.name === 'string' ? talent.name : '',
      simulationKind: talent.simulationKind || 'non-combat-or-unsupported',
      runtimeKey: resolveRuntimeKey(talent.runtimeKey, talent.position),
      grantedCardBaseIds: Array.isArray(talent.grantedCardBaseIds)
        ? talent.grantedCardBaseIds.map(Number).filter(Number.isFinite)
        : []
    }))
    .filter((talent) => talent.name);
}

function buildEmptyTalentIntegration() {
  return {
    appliedRuntimeTalents: [],
    representedByCards: [],
    unsupportedDirectTalents: [],
    ignoredNonCombatTalents: [],
    partial: false
  };
}

function finalizeTalentIntegration(integration) {
  return {
    ...integration,
    partial: integration.unsupportedDirectTalents.length > 0
  };
}

const SOLITARY_VOID_BASE_PREFIX = '21501';
const SOLITARY_VOID_LEFT_PREFIX = '21601';
const SOLITARY_VOID_RIGHT_PREFIX = '21701';

function applySolitaryVoidTransform(playerCards, normalizedSlots) {
  const indexOfAnchor = playerCards.findIndex((id) => String(id || '').startsWith(SOLITARY_VOID_BASE_PREFIX));
  if (indexOfAnchor < 0) {
    return { applied: false };
  }

  const anchorId = String(playerCards[indexOfAnchor]);
  const anchorLevel = Number.parseInt(anchorId.slice(-1), 10) || 1;
  const anchorMaxLevel = getMaxLevelForPrefix(SOLITARY_VOID_BASE_PREFIX) || anchorLevel;

  const isSlotEmpty = (index) => {
    if (index < 0 || index >= playerCards.length) return false;
    return !normalizedSlots[index];
  };
  const isSideAvailable = (index) => {
    if (index < 0 || index >= playerCards.length) return false;
    return isSlotEmpty(index);
  };

  let pendingLevel = anchorLevel;

  const leftIndex = indexOfAnchor - 1;
  if (isSideAvailable(leftIndex)) {
    const leftId = findSwogiIdForPrefixLevel(SOLITARY_VOID_LEFT_PREFIX, 1);
    if (leftId) {
      playerCards[leftIndex] = leftId;
    } else {
      pendingLevel = Math.min(anchorMaxLevel, pendingLevel + 1);
    }
  } else {
    pendingLevel = Math.min(anchorMaxLevel, pendingLevel + 1);
  }

  const rightIndex = indexOfAnchor + 1;
  if (isSideAvailable(rightIndex)) {
    const rightId = findSwogiIdForPrefixLevel(SOLITARY_VOID_RIGHT_PREFIX, 1);
    if (rightId) {
      playerCards[rightIndex] = rightId;
    } else {
      pendingLevel = Math.min(anchorMaxLevel, pendingLevel + 1);
    }
  } else {
    pendingLevel = Math.min(anchorMaxLevel, pendingLevel + 1);
  }

  if (pendingLevel !== anchorLevel) {
    const upgradedId = findSwogiIdForPrefixLevel(SOLITARY_VOID_BASE_PREFIX, pendingLevel);
    if (upgradedId) {
      playerCards[indexOfAnchor] = upgradedId;
    }
  }

  return { applied: true };
}

function prepareTalentIntegration(normalized, probePlayer, playerCards, normalizedSlots) {
  const integration = buildEmptyTalentIntegration();
  const runtimeWrites = [];
  const suppressedRuntimeKeys = new Set();
  const suppressedNames = new Set();

  const hasAttainQi = normalized.some((talent) => talent.name === 'Attain Qi');
  if (hasAttainQi) {
    const mortalBody = normalized.find((talent) => talent.name === 'Mortal Body');
    if (mortalBody) {
      suppressedNames.add('Mortal Body');
      if (mortalBody.runtimeKey) suppressedRuntimeKeys.add(mortalBody.runtimeKey);
    }
  }

  for (const talent of normalized) {
    if (suppressedNames.has(talent.name)) continue;

    if (talent.simulationKind === 'non-combat-or-unsupported') {
      integration.ignoredNonCombatTalents.push(talent.name);
      continue;
    }

    if (talent.simulationKind === 'card-grant') {
      integration.representedByCards.push(talent.name);
      continue;
    }

    if (talent.simulationKind === 'runtime-stack') {
      const key = talent.runtimeKey;
      if (key && !suppressedRuntimeKeys.has(key) && Object.prototype.hasOwnProperty.call(probePlayer, key)) {
        runtimeWrites.push({ key, value: 1 });
        integration.appliedRuntimeTalents.push(talent.name);
      } else {
        integration.unsupportedDirectTalents.push(talent.name);
      }
      continue;
    }

    if (talent.simulationKind === 'transform') {
      if (talent.name === 'Attain Qi') {
        const surgeKey = 'surge_of_qi_stacks';
        if (Object.prototype.hasOwnProperty.call(probePlayer, surgeKey)) {
          runtimeWrites.push({ key: surgeKey, value: 1 });
          integration.appliedRuntimeTalents.push(talent.name);
        } else {
          integration.unsupportedDirectTalents.push(talent.name);
        }
        continue;
      }

      if (talent.name === 'Solitary Void Golden Scroll') {
        const result = applySolitaryVoidTransform(playerCards, normalizedSlots);
        if (result.applied) {
          integration.appliedRuntimeTalents.push(talent.name);
        } else {
          integration.unsupportedDirectTalents.push(talent.name);
        }
        continue;
      }

      integration.unsupportedDirectTalents.push(talent.name);
      continue;
    }

    integration.unsupportedDirectTalents.push(talent.name);
  }

  return { integration: finalizeTalentIntegration(integration), runtimeWrites };
}

function isDreamSlot(slot) {
  if (!slot) return false;
  if (slot.isDream) return true;
  return normalizeDetectedName(slot.name).startsWith('梦');
}

async function loadYisimRuntime() {
  if (yisimRuntimePromise) return yisimRuntimePromise;

  yisimRuntimePromise = (async () => {
    const gamestateUrl = pathToFileURL(path.join(YISIM_DIR, 'gamestate_full_nolog.js')).href;
    const fuzzyUrl = pathToFileURL(path.join(YISIM_DIR, 'card_name_to_id_fuzzy.js')).href;

    const gamestateModule = await import(gamestateUrl);
    const fuzzyModule = await import(fuzzyUrl);

    await Promise.all([
      gamestateModule.ready,
      fuzzyModule.ready
    ]);

    return {
      GameState: gamestateModule.GameState,
      guess_character: gamestateModule.guess_character,
      card_name_to_id_fuzzy: fuzzyModule.card_name_to_id_fuzzy
    };
  })();

  return yisimRuntimePromise;
}

function formatDetectedCard(slot) {
  if (!slot) return '普通攻击';
  const normalizedName = normalizeDetectedName(slot.name);
  const phaseLevel = Number.parseInt(slot?.phase, 10);
  const fallbackLevel = Number.parseInt(slot?.level, 10);
  const level = isDreamSlot(slot)
    ? (Number.isFinite(phaseLevel) && phaseLevel > 0 ? phaseLevel : 1)
    : (Number.isFinite(fallbackLevel) && fallbackLevel > 0 ? fallbackLevel : 1);
  return `${normalizedName} (level ${level})`;
}

function resolveDetectedCardId(slot, card_name_to_id_fuzzy) {
  const formatted = formatDetectedCard(slot);
  const exactDetectedCardIds = loadExactDetectedCardIds();
  if (exactDetectedCardIds[formatted]) {
    return exactDetectedCardIds[formatted];
  }
  try {
    if (isDreamSlot(slot)) {
      throw new Error(`yi-sim does not support detected dream card "${formatted}"`);
    }
    return card_name_to_id_fuzzy(formatted);
  } catch (error) {
    if (!slot) {
      throw error;
    }
    if (isDreamSlot(slot)) {
      throw new Error(`yi-sim does not support detected dream card "${formatted}"`);
    }
    throw new Error(`yi-sim could not map detected card "${formatted}"`);
  }
}

function normalizeRollMode(rollMode) {
  if (rollMode === 'high' || rollMode === 'low' || rollMode === 'average') {
    return rollMode;
  }
  return DEFAULT_ROLL_MODE;
}

function normalizeDeckSlots(deckSlots) {
  const parsed = Number.parseInt(deckSlots, 10);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(0, Math.min(8, parsed));
}

function normalizePlayerState(playerState = {}) {
  const source = playerState && typeof playerState === 'object' ? playerState : {};
  const normalized = {
    hp: Number(source.hp),
    maxHp: Number(source.maxHp),
    physique: Number(source.physique),
    maxPhysique: Number(source.maxPhysique),
    cultivation: Number(source.cultivation),
    character: source.character || null
  };

  return {
    hp: Number.isFinite(normalized.hp) ? normalized.hp : 110,
    maxHp: Number.isFinite(normalized.maxHp) ? normalized.maxHp : null,
    physique: Number.isFinite(normalized.physique) ? normalized.physique : 0,
    maxPhysique: Number.isFinite(normalized.maxPhysique) ? normalized.maxPhysique : 0,
    cultivation: Number.isFinite(normalized.cultivation) ? normalized.cultivation : 100,
    character: normalized.character
  };
}

function buildEmptyResult(error = null) {
  return {
    first8Turns: null,
    perTurnDamage: [],
    cumulativeDamage: [],
    turnsSimulated: 0,
    playerCharacter: null,
    talentIntegration: buildEmptyTalentIntegration(),
    error
  };
}

function buildPlayers(normalizedSlots, card_name_to_id_fuzzy, guess_character, options = {}) {
  const playerState = normalizePlayerState(options.playerState);
  const playerCards = normalizedSlots.map((slot) => resolveDetectedCardId(slot, card_name_to_id_fuzzy));
  const opponentCards = Array(Math.max(1, normalizedSlots.length)).fill(resolveDetectedCardId(null, card_name_to_id_fuzzy));

  const player = {
    hp: playerState.hp,
    physique: playerState.physique,
    max_physique: playerState.maxPhysique,
    cultivation: playerState.cultivation,
    cards: playerCards
  };
  player.max_hp = Number.isFinite(playerState.maxHp) ? Math.max(playerState.maxHp, player.hp) : (player.hp + player.physique);
  player.character = guess_character(player);

  const opponent = {
    hp: 9999,
    physique: 0,
    max_physique: 0,
    cultivation: 0,
    cards: opponentCards
  };
  opponent.max_hp = opponent.hp + opponent.physique;
  opponent.character = guess_character(opponent);

  return { player, opponent };
}

function padSimulationSeries(perTurnDamage) {
  const paddedPerTurnDamage = perTurnDamage.slice(0, 8);
  while (paddedPerTurnDamage.length < 8) {
    paddedPerTurnDamage.push(0);
  }

  const cumulativeDamage = [];
  let runningTotal = 0;
  paddedPerTurnDamage.forEach((damage) => {
    runningTotal += damage;
    cumulativeDamage.push(runningTotal);
  });

  return {
    perTurnDamage: paddedPerTurnDamage,
    cumulativeDamage,
    first8Turns: cumulativeDamage[cumulativeDamage.length - 1] ?? 0,
    turnsSimulated: 8
  };
}

function applyRollModeOverrides(game, rollMode) {
  if (rollMode !== 'high' && rollMode !== 'low') {
    return;
  }

  game.rand_range = function randRangeWithPolicy(lo_inclusive, hi_inclusive) {
    if (this.trigger_hexagram(0)) {
      return hi_inclusive;
    }
    this.used_randomness = true;
    return rollMode === 'high' ? hi_inclusive : lo_inclusive;
  };

  game.if_c_pct = function ifCPctWithPolicy(c) {
    if (this.trigger_hexagram(0)) {
      return true;
    }
    this.used_randomness = true;
    return rollMode === 'high';
  };
}

function runSingleSimulation(GameState, player, opponent, rollMode, runtimeWrites = []) {
  const game = new GameState();
  Object.assign(game.players[0], {
    ...player,
    cards: [...player.cards]
  });
  Object.assign(game.players[1], {
    ...opponent,
    cards: [...opponent.cards]
  });
  for (const write of runtimeWrites) {
    if (write && write.key) {
      game.players[0][write.key] = write.value;
    }
  }
  applyRollModeOverrides(game, rollMode);
  game.start_of_game_setup();

  const perTurnDamage = [];
  for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
    const before = game.players[1].hp ?? 0;
    game.sim_turn();
    const after = game.players[1].hp ?? before;
    perTurnDamage.push(Math.max(0, before - after));
    if (game.game_over) {
      break;
    }
  }

  return padSimulationSeries(perTurnDamage);
}

function averageSimulationResults(results) {
  const perTurnDamage = [];
  const cumulativeDamage = [];

  for (let turnIndex = 0; turnIndex < 8; turnIndex += 1) {
    const averagePerTurn = results.reduce((sum, result) => sum + (result.perTurnDamage[turnIndex] || 0), 0) / results.length;
    const averageCumulative = results.reduce((sum, result) => sum + (result.cumulativeDamage[turnIndex] || 0), 0) / results.length;
    perTurnDamage.push(Math.round(averagePerTurn));
    cumulativeDamage.push(Math.round(averageCumulative));
  }

  return {
    perTurnDamage,
    cumulativeDamage,
    first8Turns: cumulativeDamage[cumulativeDamage.length - 1] ?? 0,
    turnsSimulated: 8
  };
}

async function simulateFirstEightTurns(slots, options = {}) {
  const rollMode = normalizeRollMode(options.rollMode);
  const deckSlots = normalizeDeckSlots(options.deckSlots);
  const playerState = normalizePlayerState(options.playerState);
  const normalizedSlots = (slots || []).slice(0, deckSlots);
  while (normalizedSlots.length < deckSlots) normalizedSlots.push(null);

  const normalizedTalents = normalizeTalents(options.talents);

  const cacheKey = JSON.stringify({
    deckSlots,
    rollMode,
    playerState: {
      hp: playerState.hp,
      maxHp: playerState.maxHp,
      physique: playerState.physique,
      maxPhysique: playerState.maxPhysique,
      cultivation: playerState.cultivation,
      character: playerState.character
    },
    slots: normalizedSlots.map((slot) => slot ? {
      name: slot.name,
      level: slot.level,
      phase: slot.phase ?? null,
      isDream: !!slot.isDream
    } : null),
    talents: normalizedTalents.map((talent) => ({
      position: talent.position,
      name: talent.name,
      simulationKind: talent.simulationKind,
      runtimeKey: talent.runtimeKey,
      grantedCardBaseIds: talent.grantedCardBaseIds
    }))
  });
  if (cacheKey === lastSimulationKey && lastSimulationResult) {
    return lastSimulationResult;
  }

  try {
    const { GameState, guess_character, card_name_to_id_fuzzy } = await loadYisimRuntime();

    if (deckSlots <= 0) {
      const emptyResult = buildEmptyResult();
      lastSimulationKey = cacheKey;
      lastSimulationResult = emptyResult;
      return emptyResult;
    }

    const { player, opponent } = buildPlayers(normalizedSlots, card_name_to_id_fuzzy, guess_character, {
      playerState
    });

    const probeGame = new GameState();
    const probePlayer = probeGame.players[0];
    const { integration: talentIntegration, runtimeWrites } = prepareTalentIntegration(
      normalizedTalents,
      probePlayer,
      player.cards,
      normalizedSlots
    );

    const simulationSummary = rollMode === 'average'
      ? averageSimulationResults(
          Array.from({ length: AVERAGE_SIM_RUNS }, () => runSingleSimulation(GameState, player, opponent, DEFAULT_ROLL_MODE, runtimeWrites))
        )
      : runSingleSimulation(GameState, player, opponent, rollMode, runtimeWrites);

    const result = {
      ...simulationSummary,
      playerCharacter: playerState.character || player.character,
      talentIntegration,
      error: null
    };
    lastSimulationKey = cacheKey;
    lastSimulationResult = result;
    return result;
  } catch (error) {
    // Log which slot(s) the simulator couldn't map. This is the symptom the
    // user sees as a green damage badge with "--": detection succeeded but
    // the swogi-id lookup or roll bailed. Harvest these messages to patch
    // missing entries in the swogi data / fuzzy-name table.
    console.warn('[damage] simulation failed:', {
      slots: normalizedSlots.map((s) => s ? {
        name: s.name, level: s.level, isDream: s.isDream, isPersonal: s.isPersonal,
      } : null),
      error: error.message,
    });
    const failedResult = buildEmptyResult(error.message);
    lastSimulationKey = cacheKey;
    lastSimulationResult = failedResult;
    return failedResult;
  }
}

module.exports = {
  loadCardNameTranslations,
  simulateFirstEightTurns
};
