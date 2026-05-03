const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
// ── Card detection backend — swap these two lines to toggle methods ───────────
// Full-image MSE/NCC detector (original):
// const { detectSlots, NUM_SLOTS, setCalibration: setSlotCalibration, getActiveGeometry: getActiveSlotGeometry } = require('./slot_detector');
// Name-strip NCC detector (active):
const { detectSlotsNameStrip: detectSlots, setCalibration: setSlotCalibration, NUM_SLOTS } = require('./name_strip_detector');
const { getActiveGeometry: getActiveSlotGeometry, setCalibration: setSlotDetectorCalibration } = require('./slot_detector');
const { loadCardNameTranslations: loadYisimCardNameTranslations, simulateFirstEightTurns } = require('./yisim_adapter');
const { loadCardLibrary } = require('./card_metadata');
const { detectTalents, buildFallbackTalentResults, setCalibration: setTalentCalibration } = require('./talent_detector');
const { performCalibration } = require('./calibrator');
const { loadCalibration, saveCalibration } = require('./calibration_store');
const {
  getAssetPath,
  getCodePath,
  getLegacyRepoPath,
  getWritablePath
} = require('./runtime_paths');
const { getNativeImagePixelSize, getNativeImageOpaqueBounds } = require('./native_image_pixels');
const { computeLayoutTransform } = require('./rect_scale');

const BOARD_CAPTURE_INTERVAL_MS = 500;
const GAME_SOURCE_PATTERNS = ['弈仙牌', 'yixianpai', 'yi xian pai', 'yi xian: cultivation card game'];
const SIDE_MARGIN = 20;
const BOARD_TOP_MARGIN = 8;
const CONTROLS_TOP_MARGIN = 2;
const CONTROLS_LIST_GAP = 20;
const CARD_LIST_WINDOW_WIDTH = 260;
const BOARD_WINDOW_WIDTH = 280;
const CONTROLS_WINDOW_WIDTH = 198;
const CONTROLS_WINDOW_HEIGHT = 34;
// Tall enough for the full settings panel: 6 labels (Damage / Cards /
// Card list / Debug / Calibration / App) + 10 buttons + calibration progress
// bar + status line. ~469 px of content; 490 leaves a small headroom so any
// text-wrap from translations doesn't clip the bottom (Quit button).
const CONTROLS_WINDOW_EXPANDED_HEIGHT = 490;

let cardListWindow = null;
let boardWindow = null;
let controlsWindow = null;
let damageWindow = null;
let deleteMode = false;
let debugMode = false;
let controlsExpanded = false;
const watchedPaths = new Map();
let converterInterval = null;
let boardCaptureInterval = null;
let latestBoardPayload = null;
let latestBoardPayloadJson = null;
let boardCaptureInFlight = false;
let boardCapturePending = false;
let lastSimulationSignature = null;
let lastSimulationPreview = null;
let isQuitting = false;

function getStartupLogPath() {
  try {
    const userDataDir = app.getPath('userData');
    fs.mkdirSync(userDataDir, { recursive: true });
    return path.join(userDataDir, 'startup.log');
  } catch (_error) {
    return path.join(__dirname, 'startup.log');
  }
}

function formatStartupLogDetails(details) {
  if (!details) return '';
  if (details instanceof Error) {
    return details.stack || details.message || String(details);
  }
  if (typeof details === 'string') {
    return details;
  }
  try {
    return JSON.stringify(details);
  } catch (_error) {
    return String(details);
  }
}

function appendStartupLog(message, details) {
  const detailText = formatStartupLogDetails(details);
  const line = `[${new Date().toISOString()}] ${message}${detailText ? `\n${detailText}` : ''}\n`;
  process.stderr.write(line);
  try {
    fs.appendFileSync(getStartupLogPath(), line, 'utf8');
  } catch (_error) {}
}

process.on('uncaughtException', (error) => {
  appendStartupLog('uncaughtException', error);
});

process.on('unhandledRejection', (reason) => {
  appendStartupLog('unhandledRejection', reason);
});

if (!app || typeof app.whenReady !== 'function') {
  appendStartupLog(
    'Electron main process started without a valid app object',
    process.env.ELECTRON_RUN_AS_NODE
      ? 'ELECTRON_RUN_AS_NODE is set. Start the app with that variable unset.'
      : 'This file must be started by the Electron runtime.'
  );
  process.exit(1);
}

function getSettingsPath() {
  return getWritablePath('overlay_settings.json');
}

function getConvertedHandPath() {
  return getWritablePath('ConvertedHandCard.json');
}

function getConvertedOperationPath() {
  return getWritablePath('ConvertedCardOperationLog.json');
}

function getImagesDir() {
  return getAssetPath('images');
}

function normalizeSettings(rawSettings = {}) {
  return {
    hiddenCards: rawSettings.hiddenCards || {},
    gamePath: rawSettings.gamePath || null,
    showCardList: rawSettings.showCardList !== false,
    showBoardPanel: rawSettings.showBoardPanel !== false,
    showDamageOverlay: rawSettings.showDamageOverlay !== false,
    cardLanguage: rawSettings.cardLanguage === 'en' ? 'en' : 'zh',
    damageRollMode: ['average', 'high', 'low'].includes(rawSettings.damageRollMode)
      ? rawSettings.damageRollMode
      : 'average',
    // Card-list filter:
    //   'all'       — every sect card the hand log says is currently held
    //   'low-stock' — only cards whose remaining-in-deck count is < 2
    cardListMode: ['all', 'low-stock'].includes(rawSettings.cardListMode)
      ? rawSettings.cardListMode
      : 'all'
  };
}

function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8')));
    }

    const legacySettingsPath = getLegacyRepoPath('overlay_settings.json');
    if (fs.existsSync(legacySettingsPath)) {
      const migratedSettings = normalizeSettings(JSON.parse(fs.readFileSync(legacySettingsPath, 'utf8')));
      saveSettings(migratedSettings);
      return migratedSettings;
    }
  } catch (e) {}
  return normalizeSettings();
}

function saveSettings(s) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(normalizeSettings(s), null, 2));
  } catch (e) {
    console.error('Failed to save settings', e);
  }
}

function getWindowBounds() {
  const primary = screen.getPrimaryDisplay();
  const controlsY = primary.bounds.y + CONTROLS_TOP_MARGIN;
  const cardListX = primary.bounds.x + primary.bounds.width - CARD_LIST_WINDOW_WIDTH - SIDE_MARGIN;
  const cardListY = controlsY + CONTROLS_WINDOW_HEIGHT + CONTROLS_LIST_GAP;
  const boardHeight = primary.bounds.height - (BOARD_TOP_MARGIN * 2);

  return {
    board: {
      x: primary.bounds.x + SIDE_MARGIN,
      y: primary.bounds.y + BOARD_TOP_MARGIN,
      width: BOARD_WINDOW_WIDTH,
      height: boardHeight
    },
    cardList: {
      x: cardListX,
      y: cardListY,
      width: CARD_LIST_WINDOW_WIDTH,
      height: Math.max(1, primary.bounds.height - (cardListY - primary.bounds.y))
    },
    controls: {
      x: primary.bounds.x + primary.bounds.width - CONTROLS_WINDOW_WIDTH - SIDE_MARGIN,
      y: controlsY,
      width: CONTROLS_WINDOW_WIDTH,
      height: controlsExpanded ? CONTROLS_WINDOW_EXPANDED_HEIGHT : CONTROLS_WINDOW_HEIGHT
    },
    damage: {
      x: primary.bounds.x,
      y: primary.bounds.y,
      width: primary.size.width,
      height: primary.size.height
    }
  };
}

function createOverlayWindow(bounds, htmlFile, focusable) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    acceptFirstMouse: true,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
      focusable,
      webPreferences: {
      preload: getCodePath('preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Note: we deliberately do NOT call setContentProtection(true) here.
  // setContentProtection sets WDA_EXCLUDEFROMCAPTURE on Windows, which would
  // exclude the overlay from ALL screen captures — including the user's
  // own screen recording software (OBS, Game Bar, etc.). The user wants the
  // overlay visible in recordings, so we instead hide overlays only for the
  // brief moment of our own desktopCapturer call (see captureWithOverlaysHidden).
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    appendStartupLog(`did-fail-load for ${htmlFile}`, {
      errorCode,
      errorDescription,
      validatedURL
    });
  });
  win.loadFile(getCodePath(htmlFile));
  return win;
}

function showWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (typeof win.showInactive === 'function') {
    win.showInactive();
    return;
  }
  win.show();
}

function setWindowClickThrough(win, clickThrough) {
  if (!win || win.isDestroyed()) return;
  try {
    if (clickThrough) {
      win.setIgnoreMouseEvents(true);
    } else {
      win.setIgnoreMouseEvents(false);
    }
  } catch (error) {
    console.error('Failed to update click-through state', error);
  }
}

function moveWindowToTop(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.moveTop();
  } catch (error) {
    console.error('Failed to move window to top', error);
  }
}

function ensureControlsOnTop() {
  moveWindowToTop(controlsWindow);
}

function updateControlsWindowBounds() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  controlsWindow.setBounds(getWindowBounds().controls);
  ensureControlsOnTop();
}

function getFallbackSlotRectsForSize(size) {
  const geo = getActiveSlotGeometry();
  if (!geo) return [];
  const targetSize = {
    width: Number(size?.width) || Number(geo.baseScreenWidth) || 1,
    height: Number(size?.height) || Number(geo.baseScreenHeight) || 1
  };
  const transform = computeLayoutTransform(
    {
      width: Number(geo.baseScreenWidth) || targetSize.width,
      height: Number(geo.baseScreenHeight) || targetSize.height
    },
    targetSize
  );
  return geo.slotXPositions.map((x) => ({
    x: Math.round(x * transform.scaleX),
    y: Math.round(geo.slotY * transform.scaleY),
    width: Math.max(1, Math.round(geo.slotWidth * transform.sizeScaleX)),
    height: Math.max(1, Math.round(geo.slotHeight * transform.sizeScaleY))
  }));
}

function getCaptureOverlayMetrics(screenshotSize = null) {
  const primary = screen.getPrimaryDisplay();
  const displayScaleFactor = primary.scaleFactor || 1;
  const fallbackScreenshotSize = {
    width: Math.round(primary.size.width * displayScaleFactor),
    height: Math.round(primary.size.height * displayScaleFactor)
  };
  const effectiveScreenshotSize = screenshotSize
    ? { width: Number(screenshotSize.width) || fallbackScreenshotSize.width, height: Number(screenshotSize.height) || fallbackScreenshotSize.height }
    : fallbackScreenshotSize;

  // DPI-derived overlay size: assume the BrowserWindow's CSS content area
  // equals screenshotSize / displayScaleFactor. Correct on most machines.
  const dpiOverlaySize = {
    width:  Math.max(1, Math.round(effectiveScreenshotSize.width  / displayScaleFactor)),
    height: Math.max(1, Math.round(effectiveScreenshotSize.height / displayScaleFactor))
  };

  // Authoritative source: the actual damage window's CSS content size.
  // Prefer this when both axes agree (or are uniformly off — e.g. macOS
  // scaled-retina where primary.size × scaleFactor ≠ screenshot pixels).
  // Fall back to dpiOverlaySize when only one axis disagrees: that's the
  // Windows chrome-trim case (e.g. 1.25 DPI 1920×1080 with taskbar →
  // content 1536×816 vs DPI 1536×864), where using the asymmetric content
  // size for projection drops every Y by ~12 px (debug boxes drew above
  // the cards). Keeping a symmetric scale = 1/displayScaleFactor is what
  // protects against that.
  let contentOverlaySize = null;
  if (damageWindow && !damageWindow.isDestroyed?.()) {
    try {
      const [cw, ch] = damageWindow.getContentSize();
      if (cw > 0 && ch > 0) contentOverlaySize = { width: cw, height: ch };
    } catch (_e) { /* window not ready yet — fall back to DPI */ }
  }

  let overlaySize = dpiOverlaySize;
  let overlayBasis = 'dpi';
  if (contentOverlaySize) {
    // Validate dpiOverlaySize against the display's reported CSS size.
    // The "screenshot ÷ scaleFactor" formula is only meaningful when the
    // capture comes back at native physical resolution. When Electron's
    // capturer returns a downscaled thumbnail (e.g. 1920×1080 capture on
    // a 2560×1440 1.5× display, where screenshot ÷ 1.5 = 1280×720 ≠
    // primary.size 1707×960), the formula is invalid and the chrome-trim
    // branch below misclassifies the mismatch. In that case the actual
    // damage-window content size IS the projection target.
    const primarySize = primary.size || { width: 1, height: 1 };
    const dpiMatchesDisplay =
      Math.abs(dpiOverlaySize.width  - primarySize.width)  / Math.max(1, primarySize.width)  < 0.02 &&
      Math.abs(dpiOverlaySize.height - primarySize.height) / Math.max(1, primarySize.height) < 0.02;

    if (!dpiMatchesDisplay) {
      overlaySize = contentOverlaySize;
      overlayBasis = 'content-thumbnail-mismatch';
    } else {
      const dx = Math.abs(contentOverlaySize.width  - dpiOverlaySize.width)  / dpiOverlaySize.width;
      const dy = Math.abs(contentOverlaySize.height - dpiOverlaySize.height) / dpiOverlaySize.height;
      const TOL = 0.01;          // 1% — within rounding noise
      const UNIFORM_TOL = 0.01;  // |dx − dy| under this means a multiplicative scale, not chrome-trim
      const CHROME_TRIM = 0.02;  // single-axis divergence above this is taskbar/title-bar trim
      if (dx < TOL && dy < TOL) {
        overlaySize = contentOverlaySize;
        overlayBasis = 'content-equal';
      } else if (Math.abs(dx - dy) < UNIFORM_TOL) {
        // Both axes uniformly off → content size is right, dpi-derived is wrong.
        overlaySize = contentOverlaySize;
        overlayBasis = 'content-uniform';
      } else if (Math.max(dx, dy) > CHROME_TRIM) {
        overlaySize = dpiOverlaySize;
        overlayBasis = 'dpi-chrome-trim';
      } else {
        overlaySize = dpiOverlaySize;
        overlayBasis = 'dpi';
      }
    }
  }

  return {
    screenshotSize: effectiveScreenshotSize,
    overlaySize,
    displayScaleFactor,
    overlayBasis,
    dpiOverlaySize,
    contentOverlaySize
  };
}

function projectCaptureRectToOverlayRect(rect, captureMetrics, _contentRect = null) {
  if (!rect) return null;

  // The thumbnail and the damage overlay both cover the entire primary
  // display now (findGameWindowSource always uses screen-source on Windows),
  // so the only difference between screenshot space and overlay space is the
  // display scale factor. Pure proportional scaling — no contentRect trim,
  // no game-window-position offset.
  const overlaySize = captureMetrics?.overlaySize || { width: 1, height: 1 };
  const screenshotSize = captureMetrics?.screenshotSize || { width: 1, height: 1 };
  const sourceSize = {
    width:  Number(screenshotSize.width)  || 1,
    height: Number(screenshotSize.height) || 1
  };

  const transform = computeLayoutTransform(sourceSize, overlaySize);

  return {
    x: Math.round(Number(rect.x) * transform.scaleX),
    y: Math.round(Number(rect.y) * transform.scaleY),
    width:  Math.max(1, Math.round(Number(rect.width)  * transform.sizeScaleX)),
    height: Math.max(1, Math.round(Number(rect.height) * transform.sizeScaleY))
  };
}

// Diagnostic snapshot for y-offset debugging. Writes one JSON to userData on
// each capture (overwrites the previous). Includes the screenshot/overlay
// dimensions, contentRect from getNativeImageOpaqueBounds, the primary display
// scale factor, the unprojected rects from the detector, and the projected
// rects that end up on the overlay. Send this file from each machine and
// compare to pinpoint which value is drifting.
let alignmentDiagWriteFailed = false;
function writeAlignmentDiagnostic(snapshot) {
  if (alignmentDiagWriteFailed) return;
  try {
    const primary = screen.getPrimaryDisplay();
    let damageWindowContentSize = null;
    let damageWindowBounds = null;
    if (damageWindow && !damageWindow.isDestroyed?.()) {
      try {
        const [cw, ch] = damageWindow.getContentSize();
        damageWindowContentSize = { width: cw, height: ch };
        damageWindowBounds = damageWindow.getBounds();
      } catch (_e) { /* window not ready */ }
    }
    const payload = {
      writtenAt: new Date().toISOString(),
      primaryDisplay: {
        scaleFactor:    primary.scaleFactor,
        bounds:         primary.bounds,
        size:           primary.size,
        workArea:       primary.workArea,
        rotation:       primary.rotation
      },
      damageWindowContentSize,
      damageWindowBounds,
      ...snapshot
    };
    const filePath = getWritablePath('overlay_alignment.json');
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  } catch (error) {
    alignmentDiagWriteFailed = true;
    console.error('Failed to write overlay_alignment.json', error);
  }
}

function projectSlotResultsToOverlaySpace(slotResults, captureMetrics, contentRect = null) {
  return (slotResults || []).map((slotResult) => {
    const cr = slotResult?.candidateRects;
    return {
      ...slotResult,
      captureRect: slotResult?.rect || null,
      rect: projectCaptureRectToOverlayRect(slotResult?.rect, captureMetrics, contentRect),
      candidateRects: cr ? {
        normal:   projectCaptureRectToOverlayRect(cr.normal,   captureMetrics, contentRect),
        dream:    projectCaptureRectToOverlayRect(cr.dream,    captureMetrics, contentRect),
        personal: projectCaptureRectToOverlayRect(cr.personal, captureMetrics, contentRect)
      } : null
    };
  });
}

function projectFallbackSlotRectsToOverlaySpace(fallbackSlotRects, captureMetrics, contentRect = null) {
  return (fallbackSlotRects || []).map((rect) => projectCaptureRectToOverlayRect(rect, captureMetrics, contentRect));
}

function projectTalentsToOverlaySpace(talents, captureMetrics, contentRect = null) {
  return (talents || []).map((talent) => ({
    ...talent,
    captureRect: talent?.rect || null,
    rect: projectCaptureRectToOverlayRect(talent?.rect, captureMetrics, contentRect)
  }));
}

let calibrationData = null;

function applyCalibration(data) {
  calibrationData = data || null;
  setSlotCalibration(calibrationData);
  setSlotDetectorCalibration(calibrationData); // keeps getActiveSlotGeometry working when swapping back to slot_detector
  setTalentCalibration(calibrationData);
}

function getUiState() {
  const settings = loadSettings();
  return {
    deleteMode,
    debugMode,
    showCardList: settings.showCardList,
    showBoardPanel: settings.showBoardPanel,
    showDamageOverlay: settings.showDamageOverlay,
    cardLanguage: settings.cardLanguage,
    damageRollMode: settings.damageRollMode,
    cardListMode: settings.cardListMode,
    calibrated: !!calibrationData,
    calibratedAt: calibrationData?.calibratedAt || null
  };
}

function broadcastUiState() {
  const payload = getUiState();
  [cardListWindow, boardWindow, controlsWindow, damageWindow].forEach((win) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('ui-state-updated', payload);
  });
}

function updateCardListWindowMouseMode() {
  setWindowClickThrough(cardListWindow, !deleteMode);
}

function applyPanelVisibilityFromSettings() {
  const settings = loadSettings();
  if (cardListWindow && !cardListWindow.isDestroyed()) {
    if (settings.showCardList) {
      showWindow(cardListWindow);
    } else {
      cardListWindow.hide();
    }
  }
  if (boardWindow && !boardWindow.isDestroyed()) {
    if (settings.showBoardPanel) {
      showWindow(boardWindow);
    } else {
      boardWindow.hide();
    }
  }
  if (damageWindow && !damageWindow.isDestroyed()) {
    if (settings.showDamageOverlay) {
      showWindow(damageWindow);
    } else {
      damageWindow.hide();
    }
  }
  updateCardListWindowMouseMode();
  ensureControlsOnTop();
}

function createCardListWindow() {
  if (cardListWindow && !cardListWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  cardListWindow = createOverlayWindow(bounds.cardList, 'renderer.html', false);
  updateCardListWindowMouseMode();
  cardListWindow.webContents.on('did-finish-load', () => {
    broadcastUiState();
  });
  cardListWindow.once('ready-to-show', () => {
    applyPanelVisibilityFromSettings();
  });
  cardListWindow.on('closed', () => { cardListWindow = null; });
}

function createBoardWindow() {
  if (boardWindow && !boardWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  boardWindow = createOverlayWindow(bounds.board, 'board.html', false);
  setWindowClickThrough(boardWindow, true);
  boardWindow.webContents.on('did-finish-load', () => {
    if (latestBoardPayload) {
      boardWindow.webContents.send('board-detection-updated', latestBoardPayload);
    }
    broadcastUiState();
  });
  boardWindow.once('ready-to-show', () => {
    applyPanelVisibilityFromSettings();
  });
  boardWindow.on('closed', () => { boardWindow = null; });
}

function createDamageWindow() {
  if (damageWindow && !damageWindow.isDestroyed()) return;
  const bounds = getWindowBounds();
  damageWindow = createOverlayWindow(bounds.damage, 'damage.html', false);
  setWindowClickThrough(damageWindow, true);
  damageWindow.webContents.on('did-finish-load', () => {
    if (latestBoardPayload) {
      damageWindow.webContents.send('board-detection-updated', latestBoardPayload);
    }
  });
  damageWindow.once('ready-to-show', () => {
    showWindow(damageWindow);
    ensureControlsOnTop();
  });
  damageWindow.on('closed', () => { damageWindow = null; });
}

function createControlsWindow() {
  if (controlsWindow && !controlsWindow.isDestroyed()) return;
  controlsExpanded = false;
  const bounds = getWindowBounds();
  controlsWindow = createOverlayWindow(bounds.controls, 'controls.html', false);
  setWindowClickThrough(controlsWindow, false);
  controlsWindow.webContents.on('did-finish-load', () => {
    broadcastUiState();
  });
  controlsWindow.once('ready-to-show', () => {
    showWindow(controlsWindow);
    ensureControlsOnTop();
  });
  controlsWindow.on('closed', () => {
    controlsExpanded = false;
    controlsWindow = null;
  });
}

function createOverlayWindows() {
  createCardListWindow();
  createBoardWindow();
  createDamageWindow();
  createControlsWindow();
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function looksLikeGameDataDir(dirPath) {
  if (!dirPath) return false;
  const requiredSignals = [
    path.join(dirPath, 'BattleLog.json'),
    path.join(dirPath, 'CardOperationLog.json')
  ];
  return requiredSignals.some(fileExists);
}

function findFirstExistingPath(candidates, fallback) {
  for (const candidate of candidates) {
    if (looksLikeGameDataDir(candidate)) return candidate;
  }
  return fallback;
}

function findMacGamePath() {
  const home = process.env.HOME || '';
  const fallback = path.join(home, 'Library', 'Application Support', 'com.darksun.yixianpai');
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'com.darksun.yixianpai'),
    path.join(home, 'Library', 'Containers', 'com.darksun.yixianpai', 'Data', 'Library', 'Application Support', 'com.darksun.yixianpai'),
    path.join(home, 'Library', 'Containers', 'com.darksun.yixianpai')
  ];

  return findFirstExistingPath(candidates, fallback);
}

function findWindowsGamePath() {
  const userProfile = process.env.USERPROFILE || '';
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const fallback = path.join(userProfile, 'AppData', 'LocalLow', 'DarkSunStudio', 'YiXianPai');
  const candidates = [
    path.join(userProfile, 'AppData', 'LocalLow', 'DarkSunStudio', 'YiXianPai'),
    path.join(localAppData, 'Low', 'DarkSunStudio', 'YiXianPai'),
    path.join(localAppData, 'DarkSunStudio', 'YiXianPai'),
    path.join(appData, 'DarkSunStudio', 'YiXianPai')
  ];

  return findFirstExistingPath(candidates, fallback);
}

function getGamePathAuto() {
  if (process.platform === 'darwin') {
    return findMacGamePath();
  }
  if (process.platform === 'win32') {
    return findWindowsGamePath();
  }
  return null;
}

function getResolvedGamePath(settings) {
  if (settings && settings.gamePath && looksLikeGameDataDir(settings.gamePath)) {
    return settings.gamePath;
  }
  const auto = getGamePathAuto();
  if (auto && looksLikeGameDataDir(auto)) {
    return auto;
  }
  return null;
}

function resolveGameFile(filename, settings) {
  const localDerivedPaths = {
    'ConvertedHandCard.json': getConvertedHandPath(),
    'ConvertedCardOperationLog.json': getConvertedOperationPath()
  };
  if (localDerivedPaths[filename] && fileExists(localDerivedPaths[filename])) {
    return localDerivedPaths[filename];
  }

  if (path.isAbsolute(filename) && fileExists(filename)) return filename;

  const gamePath = getResolvedGamePath(settings);
  if (gamePath) {
    const candidate = path.join(gamePath, path.basename(filename));
    if (fileExists(candidate)) return candidate;
  }

  return null;
}

function parseOperationLog(logContent) {
  const lines = (logContent || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLines = lines.slice(1);
  if (jsonLines.length === 0) return null;
  return jsonLines.map((line) => JSON.parse(line));
}

function parseBattleLog(logContent) {
  const lines = (logContent || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const jsonLines = lines.slice(1);
  if (jsonLines.length === 0) return null;
  return jsonLines.map((line) => JSON.parse(line));
}

function getOpenSlotsForRound(currentRound) {
  const safeRound = Math.max(1, Number(currentRound) || 1);
  return Math.min(NUM_SLOTS, safeRound + 2);
}

function loadBattleState(settings) {
  const fallbackOpenSlots = getOpenSlotsForRound(1);
  const battleLogPath = resolveGameFile('BattleLog.json', settings);
  if (!battleLogPath || !fileExists(battleLogPath)) {
    return {
      status: 'missing-battle-log',
      lastLoggedRound: null,
      currentRound: 1,
      openSlots: fallbackOpenSlots,
      player: null,
      simulationPlayer: null
    };
  }

  try {
    const rounds = parseBattleLog(fs.readFileSync(battleLogPath, 'utf8'));
    if (!rounds || rounds.length === 0) {
      return {
        status: 'waiting-battle-log',
        lastLoggedRound: 0,
        currentRound: 1,
        openSlots: fallbackOpenSlots,
        player: null,
        simulationPlayer: null
      };
    }

    const latestRound = rounds.reduce((latest, round) => {
      if (!latest) return round;
      return (round?.round ?? -Infinity) > (latest?.round ?? -Infinity) ? round : latest;
    }, null);

    const selectedPlayer = latestRound?.players?.[0] || null;
    const currentRound = Math.max(1, (latestRound?.round ?? 0) + 1);
    const openSlots = getOpenSlotsForRound(currentRound);

    return {
      status: 'ok',
      lastLoggedRound: latestRound?.round ?? 0,
      currentRound,
      openSlots,
      player: selectedPlayer ? {
        username: selectedPlayer.username || null,
        character: selectedPlayer.character || null,
        level: selectedPlayer.level ?? null,
        life: selectedPlayer.life ?? null,
        exp: selectedPlayer.exp ?? 0,
        tiPo: selectedPlayer.tiPo ?? 0,
        maxTiPo: selectedPlayer.maxTiPo ?? 0,
        maxHp: selectedPlayer.maxHp ?? null
      } : null,
      simulationPlayer: selectedPlayer ? {
        hp: selectedPlayer.maxHp ?? 110,
        maxHp: selectedPlayer.maxHp ?? 110,
        physique: selectedPlayer.tiPo ?? 0,
        maxPhysique: selectedPlayer.maxTiPo ?? 0,
        cultivation: selectedPlayer.exp ?? 0,
        character: selectedPlayer.character || null
      } : null
    };
  } catch (error) {
    return {
      status: 'battle-log-error',
      message: error.message,
      lastLoggedRound: null,
      currentRound: 1,
      openSlots: fallbackOpenSlots,
      player: null,
      simulationPlayer: null
    };
  }
}

function buildFallbackSlotResults(fallbackSlotRects, openSlots, reason = 'fallback') {
  return fallbackSlotRects.map((rect, slotIndex) => ({
    slotIndex,
    rect,
    metric: null,
    accepted: false,
    bestScore: null,
    margin: null,
    bestCandidate: null,
    secondCandidate: null,
    state: slotIndex < openSlots ? 'undetected' : 'closed',
    reason,
    card: null
  }));
}

function applyOpenSlotStateToResults(slotResults, fallbackSlotRects, openSlots) {
  return fallbackSlotRects.map((rect, slotIndex) => {
    const existing = slotResults?.[slotIndex];
    const state = slotIndex < openSlots
      ? (existing?.card ? 'detected' : 'undetected')
      : 'closed';
    return {
      slotIndex,
      rect: existing?.rect || rect,
      metric: existing?.metric ?? null,
      accepted: !!existing?.accepted,
      bestScore: existing?.bestScore ?? null,
      margin: existing?.margin ?? null,
      bestCandidate: existing?.bestCandidate ?? null,
      secondCandidate: existing?.secondCandidate ?? null,
      card: state === 'detected' ? existing.card : null,
      state
    };
  });
}

function getDeckRemovalCount(card) {
  const rarity = card?.rarity ?? 0;
  if (rarity === 3) return 4;
  if (rarity === 2) return 2;
  return 1;
}

function getHandRemovalCount(card) {
  const rarity = card?.rarity ?? 0;
  if (rarity === 4) return 4;
  if (rarity === 1) return 2;
  return 1;
}

function calculateDeckCards(operations) {
  const cardCounts = {};

  operations.forEach((op) => {
    if (op.operation === 0 && Array.isArray(op.cards)) {
      op.cards.forEach((card) => {
        if (!card?.name) return;
        if (!cardCounts[card.name]) {
          cardCounts[card.name] = { count: 0 };
        }
        cardCounts[card.name].count += getDeckRemovalCount(card);
      });
    }

    if (op.operation === 1 && op.dstCard?.name && !String(op.dstCard.name).startsWith('梦')) {
      if (op.srcCard?.name) {
        if (!cardCounts[op.srcCard.name]) {
          cardCounts[op.srcCard.name] = { count: 0 };
        }
        cardCounts[op.srcCard.name].count += 2 * getDeckRemovalCount(op.srcCard);
      }

      if (!cardCounts[op.dstCard.name]) {
        cardCounts[op.dstCard.name] = { count: 0 };
      }
      cardCounts[op.dstCard.name].count += getDeckRemovalCount(op.dstCard);
    }
  });

  return cardCounts;
}

function calculateHandCards(operations) {
  const handCards = {};

  operations.forEach((op) => {
    if (op.operation === 0 && Array.isArray(op.cards)) {
      op.cards.forEach((card) => {
        if (!card?.name) return;
        handCards[card.name] = (handCards[card.name] || 0) + 1;
      });
    }

    if (op.operation === 1) {
      if (op.srcCard?.name) {
        handCards[op.srcCard.name] = (handCards[op.srcCard.name] || 0) - getHandRemovalCount(op.srcCard);
      }
      if (op.dstCard?.name) {
        handCards[op.dstCard.name] = (handCards[op.dstCard.name] || 0) + 1;
      }
    }

    if (op.operation === 2) {
      if (op.srcCard?.name) {
        handCards[op.srcCard.name] = (handCards[op.srcCard.name] || 0) - getHandRemovalCount(op.srcCard);
      }
    }
  });

  return Object.fromEntries(
    Object.entries(handCards)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => [name, { count }])
  );
}

function writeDerivedData(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function loadCardNameTranslations() {
  return loadYisimCardNameTranslations();
}

function emitConvertedDataUpdated() {
  if (cardListWindow && !cardListWindow.isDestroyed()) {
    cardListWindow.webContents.send('card-operation-log-updated');
  }
}

function emitBoardDetectionUpdated(payload) {
  latestBoardPayload = payload;
  const comparablePayload = { ...payload };
  delete comparablePayload.updatedAt;
  const nextPayloadJson = JSON.stringify(comparablePayload);
  if (nextPayloadJson === latestBoardPayloadJson) return;
  latestBoardPayloadJson = nextPayloadJson;
  if (boardWindow && !boardWindow.isDestroyed()) {
    boardWindow.webContents.send('board-detection-updated', payload);
  }
  if (damageWindow && !damageWindow.isDestroyed()) {
    damageWindow.webContents.send('board-detection-updated', payload);
  }
}

function processOperationLog() {
  try {
    const settings = loadSettings();
    const operationLogPath = resolveGameFile('CardOperationLog.json', settings);
    if (!operationLogPath || !fileExists(operationLogPath)) return;

    const logContent = fs.readFileSync(operationLogPath, 'utf8');
    const operations = parseOperationLog(logContent);

    if (operations === null) {
      const waitingData = { cards: {}, status: 'waiting' };
      writeDerivedData(getConvertedOperationPath(), waitingData);
      writeDerivedData(getConvertedHandPath(), waitingData);
      emitConvertedDataUpdated();
      return;
    }

    const deckCards = calculateDeckCards(operations);
    const handCards = calculateHandCards(operations);
    writeDerivedData(getConvertedOperationPath(), { cards: deckCards });
    writeDerivedData(getConvertedHandPath(), { cards: handCards });
    emitConvertedDataUpdated();
  } catch (error) {
    console.error('Error in processOperationLog:', error);
  }
}

function startConverters() {
  processOperationLog();
  if (converterInterval) clearInterval(converterInterval);
  converterInterval = setInterval(processOperationLog, 1000);
}

function loadConvertedHandCards() {
  try {
    const convertedHandPath = getConvertedHandPath();
    if (!fileExists(convertedHandPath)) return {};
    return JSON.parse(fs.readFileSync(convertedHandPath, 'utf8') || '{"cards":{}}').cards || {};
  } catch (error) {
    return {};
  }
}

function getCurrentHandCandidates() {
  return Object.keys(loadConvertedHandCards()).filter((name) => !!name);
}

const MAX_CAPTURE_WIDTH  = 1920;
const MAX_CAPTURE_HEIGHT = 1080;

// Hide every overlay window we own (board / damage / cardList / controls)
// from screen capture for the duration of `captureFn`, then restore.
//
// We toggle setContentProtection(true) around the capture rather than
// flipping CSS opacity. Why:
//   - Permanent setContentProtection(true) would also exclude the overlay
//     from the user's own screen recorder — breaking their recording.
//   - CSS opacity:0 + rAF actually stops painting the window for ~33 ms,
//     which the user sees as a flicker every capture cycle.
//   - Toggling setContentProtection only affects OS capture surfaces. The
//     window keeps painting normally the entire time, so the user sees
//     zero flicker. The user's recorder loses the overlay for the same
//     ~50–100 ms the capture is running (so a brief gap shows up in
//     recordings, ~2–3 dropped overlay frames per second), which is the
//     unavoidable cost of running a screen-source capture in-app.
async function captureWithOverlaysHidden(captureFn) {
  const windows = [boardWindow, damageWindow, cardListWindow, controlsWindow]
    .filter((w) => w && !w.isDestroyed() && w.isVisible());
  for (const w of windows) {
    try { w.setContentProtection(true); } catch (e) {}
  }
  try {
    return await captureFn();
  } finally {
    for (const w of windows) {
      try { w.setContentProtection(false); } catch (e) {}
    }
  }
}

async function findGameWindowSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const scale = primaryDisplay.scaleFactor || 1;
  // Cap at MAX_CAPTURE dimensions: templates are captured at 1920×1080 scale,
  // and working at larger sizes only inflates float-array allocation and
  // comparison cost with no accuracy benefit.
  const thumbnailSize = {
    width:  Math.min(Math.round(primaryDisplay.size.width  * scale), MAX_CAPTURE_WIDTH),
    height: Math.min(Math.round(primaryDisplay.size.height * scale), MAX_CAPTURE_HEIGHT)
  };

  if (process.platform === 'win32') {
    // Fast path — fullscreen game with window-source capture.
    //
    // When the game window is the same size as the screen (fullscreen or
    // borderless windowed), a window-source thumbnail covers the same region
    // as our overlay. Our overlay is a separate top-level window, so it's
    // NOT included in the thumbnail — no overlay-hiding needed. Zero flicker
    // for both the user's eyes and any screen recording.
    //
    // When the game is in a smaller window, the window-source thumbnail's
    // coordinates don't match our screen-covering overlay (we'd draw boxes
    // at the wrong screen position). Fall back to screen-source with the
    // setContentProtection toggle in that case — eyes still see no flicker
    // (we toggle WDA_EXCLUDEFROMCAPTURE around the capture instead of CSS
    // opacity), recording loses the overlay for ~50–100 ms per capture.
    const expectedFullscreen = {
      width:  Math.round(primaryDisplay.size.width  * scale),
      height: Math.round(primaryDisplay.size.height * scale)
    };
    const FULLSCREEN_TOLERANCE_PX = 8; // tolerate a few px of DWM border
    try {
      const windowSources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize,
        fetchWindowIcons: false
      });
      const windowSource = windowSources.find((source) => {
        const sourceName = (source.name || '').toLowerCase();
        return GAME_SOURCE_PATTERNS.some((pattern) => sourceName.includes(pattern.toLowerCase()));
      });
      if (windowSource && !windowSource.thumbnail.isEmpty()) {
        const thumbSize = getNativeImagePixelSize(windowSource.thumbnail);
        const isFullscreenSized =
          Math.abs(thumbSize.width  - expectedFullscreen.width)  <= FULLSCREEN_TOLERANCE_PX &&
          Math.abs(thumbSize.height - expectedFullscreen.height) <= FULLSCREEN_TOLERANCE_PX;
        if (isFullscreenSized) {
          return windowSource;
        }
      }
    } catch (e) {
      // fall through to screen-source
    }

    // Slow path — windowed game (or no detectable game window). Capture the
    // screen with overlays excluded from capture only for the brief moment
    // we're calling desktopCapturer.
    return await captureWithOverlaysHidden(async () => {
      const screenSources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize,
        fetchWindowIcons: false
      });
      return screenSources.find((source) =>
        source.display_id === String(primaryDisplay.id)
      ) || screenSources[0] || null;
    });
  }

  // Non-Windows fallback (Linux/macOS) — keep window-source for now; we don't
  // have a reproducer there, and desktopCapturer semantics differ enough that
  // changing this without testing is risky.
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize,
    fetchWindowIcons: false
  });
  return sources.find((source) => {
    const sourceName = (source.name || '').toLowerCase();
    return GAME_SOURCE_PATTERNS.some((pattern) => sourceName.includes(pattern.toLowerCase()));
  }) || null;
}

async function performBoardCapture() {
  const settings = loadSettings();
  const battleState = loadBattleState(settings);
  const realOpenSlots = battleState.openSlots || NUM_SLOTS;
  const boardOpenSlots = realOpenSlots;
  const emptyDamagePreview = (error = null) => ({
    first8Turns: null,
    perTurnDamage: [],
    cumulativeDamage: [],
    turnsSimulated: 0,
    playerCharacter: null,
    error
  });

  const handCandidates = getCurrentHandCandidates();

  try {
    const source = await findGameWindowSource();
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      const captureMetrics = getCaptureOverlayMetrics();
      const missingFallbackSlotRects = getFallbackSlotRectsForSize(captureMetrics.screenshotSize);
      const missingTalentCapture = buildFallbackTalentResults(captureMetrics.screenshotSize, 'missing-source');
      const projectedFallbackSlotRects = projectFallbackSlotRectsToOverlaySpace(missingFallbackSlotRects, captureMetrics);
      const projectedMissingSlotResults = projectSlotResultsToOverlaySpace(
        buildFallbackSlotResults(missingFallbackSlotRects, boardOpenSlots, 'missing-source'),
        captureMetrics
      );
      const projectedMissingTalents = projectTalentsToOverlaySpace(missingTalentCapture.talents, captureMetrics);
      emitBoardDetectionUpdated({
        slots: Array(8).fill(null),
        damagePreview: emptyDamagePreview('Game window not found'),
        updatedAt: Date.now(),
        capture: {
          status: 'missing-source',
          coordinateSpace: 'overlay',
          screenshotSize: captureMetrics.screenshotSize,
          overlaySize: captureMetrics.overlaySize,
          captureContentRect: {
            x: 0,
            y: 0,
            width: captureMetrics.screenshotSize.width,
            height: captureMetrics.screenshotSize.height
          },
          displayScaleFactor: captureMetrics.displayScaleFactor,
          fallbackSlotRects: projectedFallbackSlotRects,
          slotResults: projectedMissingSlotResults,
          talents: projectedMissingTalents,
          talentDetection: {
            ...missingTalentCapture.debug,
            status: 'missing-source'
          },
          battle: battleState,
          currentRound: battleState.currentRound,
          openSlots: realOpenSlots,
          boardOpenSlots,
          realOpenSlots,
          debugMode
        }
      });
      return;
    }

    const talentCapture = detectTalents(source.thumbnail);

    // For any detected talent, add its Chinese name to hand candidates.
    // Personal card templates (e.g. images/personal/FengXu/阴符玉简1.png) share their
    // name with the talent that grants them, so this lookup finds them automatically.
    const talentCardNames = talentCapture.talents
      .filter((t) => t.detected && t.nameCn)
      .map((t) => t.nameCn);
    const allHandCandidates = talentCardNames.length > 0
      ? [...new Set([...handCandidates, ...talentCardNames])]
      : handCandidates;

    const detection = allHandCandidates.length > 0
      ? detectSlots(source.thumbnail, allHandCandidates, getImagesDir())
      : {
          slots: Array(NUM_SLOTS).fill(null),
          slotResults: [],
          debug: { reason: 'no-hand-candidates' }
        };
    const screenshotSize = getNativeImagePixelSize(source.thumbnail);
    const contentRect = getNativeImageOpaqueBounds(source.thumbnail);
    // Keep the damage/debug overlay window at full-display logical size.
    // The captured thumbnail is often downscaled (for example by the
    // MAX_CAPTURE_* cap), so resizing the overlay window to thumbnail size
    // collapses all mapped rects into the top-left of the screen after the
    // first capture.
    const captureMetrics = getCaptureOverlayMetrics(screenshotSize);
    const scaledFallbackSlotRects = getFallbackSlotRectsForSize(captureMetrics.screenshotSize);
    const slotResults = applyOpenSlotStateToResults(detection.slotResults, scaledFallbackSlotRects, boardOpenSlots);
    const projectedFallbackSlotRects = projectFallbackSlotRectsToOverlaySpace(scaledFallbackSlotRects, captureMetrics, contentRect);
    const projectedSlotResults = projectSlotResultsToOverlaySpace(slotResults, captureMetrics, contentRect);
    const projectedTalents = projectTalentsToOverlaySpace(talentCapture.talents, captureMetrics, contentRect);
    const slots = slotResults.map((result) => result.card);
    const activeSlots = slots.slice(0, realOpenSlots);
    const simulationSignature = JSON.stringify({
      slots: activeSlots.map((c) => c ? { name: c.name, level: c.level, phase: c.phase ?? null, isDream: !!c.isDream } : null),
      deckSlots: realOpenSlots,
      rollMode: settings.damageRollMode,
      playerState: battleState.simulationPlayer,
      talents: talentCapture.talents.map((t) => ({ position: t.position, name: t.name, detected: t.detected }))
    });
    let damagePreview;
    if (simulationSignature === lastSimulationSignature && lastSimulationPreview) {
      damagePreview = lastSimulationPreview;
    } else {
      damagePreview = await simulateFirstEightTurns(activeSlots, {
        deckSlots: realOpenSlots,
        playerState: battleState.simulationPlayer,
        rollMode: settings.damageRollMode,
        talents: talentCapture.talents
      });
      lastSimulationSignature = simulationSignature;
      lastSimulationPreview = damagePreview;
    }

    emitBoardDetectionUpdated({
      slots,
      damagePreview,
      updatedAt: Date.now(),
      capture: {
        status: 'ok',
        coordinateSpace: 'overlay',
        screenshotSize: captureMetrics.screenshotSize,
        overlaySize: captureMetrics.overlaySize,
        captureContentRect: contentRect,
        displayScaleFactor: captureMetrics.displayScaleFactor,
        sourceName: source.name,
        detector: detection.debug,
        slotResults: projectedSlotResults,
        fallbackSlotRects: projectedFallbackSlotRects,
        talents: projectedTalents,
        talentDetection: talentCapture.debug,
        battle: battleState,
        currentRound: battleState.currentRound,
        openSlots: realOpenSlots,
        boardOpenSlots,
        realOpenSlots,
        debugMode
      }
    });

    // Diagnostic snapshot for the y-offset investigation. Write the latest
    // capture geometry to userData so the user can send the file from each
    // machine to compare. Non-fatal.
    writeAlignmentDiagnostic({
      sourceName: source.name,
      screenshotSize: captureMetrics.screenshotSize,
      contentRect,
      overlaySize: captureMetrics.overlaySize,
      displayScaleFactor: captureMetrics.displayScaleFactor,
      overlayBasis: captureMetrics.overlayBasis,
      dpiOverlaySize: captureMetrics.dpiOverlaySize,
      contentOverlaySize: captureMetrics.contentOverlaySize,
      detectorRects: slotResults.map((r) => r?.rect || null),
      projectedRects: projectedSlotResults.map((r) => r?.rect || null)
    });
  } catch (error) {
    const errorCaptureMetrics = getCaptureOverlayMetrics();
    const errorFallbackSlotRects = getFallbackSlotRectsForSize(errorCaptureMetrics.screenshotSize);
    const errorTalentCapture = buildFallbackTalentResults(errorCaptureMetrics.screenshotSize, 'error');
    const projectedErrorFallbackRects = projectFallbackSlotRectsToOverlaySpace(errorFallbackSlotRects, errorCaptureMetrics);
    const projectedErrorSlotResults = projectSlotResultsToOverlaySpace(
      buildFallbackSlotResults(errorFallbackSlotRects, boardOpenSlots, 'error'),
      errorCaptureMetrics
    );
    const projectedErrorTalents = projectTalentsToOverlaySpace(errorTalentCapture.talents, errorCaptureMetrics);
    emitBoardDetectionUpdated({
      slots: Array(8).fill(null),
      damagePreview: emptyDamagePreview(error.message),
      updatedAt: Date.now(),
      capture: {
        status: 'error',
        coordinateSpace: 'overlay',
        screenshotSize: errorCaptureMetrics.screenshotSize,
        overlaySize: errorCaptureMetrics.overlaySize,
        captureContentRect: {
          x: 0,
          y: 0,
            width: errorCaptureMetrics.screenshotSize.width,
            height: errorCaptureMetrics.screenshotSize.height
          },
        displayScaleFactor: errorCaptureMetrics.displayScaleFactor,
        message: error.message,
        fallbackSlotRects: projectedErrorFallbackRects,
        slotResults: projectedErrorSlotResults,
        talents: projectedErrorTalents,
        talentDetection: {
          ...errorTalentCapture.debug,
          status: 'error'
        },
        battle: battleState,
        currentRound: battleState.currentRound,
        openSlots: realOpenSlots,
        boardOpenSlots,
        realOpenSlots,
        debugMode
      }
    });
  }
}

async function captureBoardState() {
  if (isQuitting) return;
  if (boardCaptureInFlight) {
    boardCapturePending = true;
    return;
  }

  boardCaptureInFlight = true;
  try {
    await performBoardCapture();
  } finally {
    boardCaptureInFlight = false;
    if (boardCapturePending && !isQuitting) {
      boardCapturePending = false;
      setImmediate(() => {
        captureBoardState().catch((error) => {
          console.error('Error in queued board capture:', error);
        });
      });
    }
  }
}

function startBoardCapture() {
  captureBoardState();
  if (boardCaptureInterval) clearInterval(boardCaptureInterval);
  boardCaptureInterval = setInterval(() => {
    captureBoardState();
  }, BOARD_CAPTURE_INTERVAL_MS);
}

app.whenReady().then(() => {
  try {
    appendStartupLog('app.whenReady');

    // Load saved calibration and apply to detectors before first capture
    const savedCalibration = loadCalibration();
    if (savedCalibration) {
      applyCalibration(savedCalibration);
    }

    createOverlayWindows();

    app.on('activate', () => {
      createOverlayWindows();
      applyPanelVisibilityFromSettings();
      broadcastUiState();
    });
    // load settings and start watching game converted files if possible
    const s = loadSettings();
    const resolvedGamePath = getResolvedGamePath(s);
    if (resolvedGamePath && s.gamePath !== resolvedGamePath) {
      s.gamePath = resolvedGamePath;
      saveSettings(s);
    }
    if (resolvedGamePath) {
      watchPath(path.join(resolvedGamePath, 'BattleLog.json'));
      watchPath(path.join(resolvedGamePath, 'CardOperationLog.json'));
    }
    startConverters();
    startBoardCapture();
    applyPanelVisibilityFromSettings();
    broadcastUiState();
    registerGlobalShortcuts();

    autoUpdater.on('checking-for-update', () => appendStartupLog('autoUpdater: checking'));
    autoUpdater.on('update-available', (info) => appendStartupLog('autoUpdater: update-available', info));
    autoUpdater.on('update-not-available', () => appendStartupLog('autoUpdater: up to date'));
    autoUpdater.on('download-progress', (p) => appendStartupLog(`autoUpdater: download ${Math.round(p.percent)}%`));
    autoUpdater.on('update-downloaded', (info) => appendStartupLog('autoUpdater: downloaded', info));
    autoUpdater.on('error', (err) => appendStartupLog('autoUpdater: error', err));

    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[autoUpdater] check failed:', err?.message || err);
    });

    appendStartupLog('startup complete');
  } catch (error) {
    appendStartupLog('startup failed', error);
    throw error;
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (converterInterval) { clearInterval(converterInterval); converterInterval = null; }
  if (boardCaptureInterval) { clearInterval(boardCaptureInterval); boardCaptureInterval = null; }
});

app.on('will-quit', () => {
  isQuitting = true;
  if (converterInterval) clearInterval(converterInterval);
  if (boardCaptureInterval) clearInterval(boardCaptureInterval);
  watchedPaths.forEach((watcher) => {
    try { watcher.close(); } catch (e) {}
  });
  watchedPaths.clear();
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

// Global shortcuts:
//   CmdOrCtrl+Shift+D — toggle the damage-per-turn overlay on/off
//   CmdOrCtrl+Shift+R — force a fresh board detection (re-capture and re-score)
function registerGlobalShortcuts() {
  const bindings = [
    {
      accelerator: 'CommandOrControl+Shift+D',
      handler: () => {
        const settings = loadSettings();
        settings.showDamageOverlay = !settings.showDamageOverlay;
        saveSettings(settings);
        applyPanelVisibilityFromSettings();
        broadcastUiState();
      }
    },
    {
      accelerator: 'CommandOrControl+Shift+R',
      handler: () => {
        captureBoardState().catch((error) => {
          console.error('Failed to force board capture', error);
        });
      }
    }
  ];
  for (const { accelerator, handler } of bindings) {
    try {
      const ok = globalShortcut.register(accelerator, handler);
      if (!ok) console.error(`Failed to register shortcut ${accelerator}`);
    } catch (error) {
      console.error(`Error registering shortcut ${accelerator}`, error);
    }
  }
}

ipcMain.handle('read-settings', () => {
  return loadSettings();
});

ipcMain.handle('read-card-library', () => {
  return loadCardLibrary();
});

ipcMain.handle('read-card-name-translations', () => {
  return loadCardNameTranslations();
});

ipcMain.handle('write-settings', (_, settings) => {
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return true;
});

ipcMain.handle('get-ui-state', () => {
  return getUiState();
});

ipcMain.handle('set-delete-mode', (_, enable) => {
  deleteMode = !!enable;
  updateCardListWindowMouseMode();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('toggle-card-list-visibility', () => {
  const settings = loadSettings();
  settings.showCardList = !settings.showCardList;
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('toggle-board-visibility', () => {
  const settings = loadSettings();
  settings.showBoardPanel = !settings.showBoardPanel;
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('quit-app', () => {
  app.quit();
  return { ok: true };
});

ipcMain.handle('set-card-list-mode', (_, nextMode) => {
  const settings = loadSettings();
  settings.cardListMode = ['all', 'low-stock'].includes(nextMode) ? nextMode : 'all';
  saveSettings(settings);
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('toggle-damage-overlay-visibility', () => {
  const settings = loadSettings();
  settings.showDamageOverlay = !settings.showDamageOverlay;
  saveSettings(settings);
  applyPanelVisibilityFromSettings();
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('force-board-capture', () => {
  captureBoardState().catch((error) => {
    console.error('Failed to force board capture', error);
  });
  return { ok: true };
});

ipcMain.handle('set-card-language', (_, nextLanguage) => {
  const settings = loadSettings();
  settings.cardLanguage = nextLanguage === 'en' ? 'en' : 'zh';
  saveSettings(settings);
  broadcastUiState();
  return getUiState();
});

ipcMain.handle('set-damage-roll-mode', (_, nextMode) => {
  const settings = loadSettings();
  settings.damageRollMode = nextMode;
  saveSettings(settings);
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after roll mode change', error);
  });
  return getUiState();
});

ipcMain.handle('set-debug-mode', (_, enabled) => {
  debugMode = !!enabled;
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after debug mode change', error);
  });
  return getUiState();
});

ipcMain.handle('set-controls-expanded', (_, expanded) => {
  controlsExpanded = !!expanded;
  updateControlsWindowBounds();
  return true;
});

ipcMain.handle('perform-calibration', async () => {
  const source = await findGameWindowSource();
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
    throw new Error('Game window not found. Open the game before calibrating.');
  }
  const onProgress = (step, total, message) => {
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.webContents.send('calibration-progress', { step, total, message });
    }
  };
  const result = await performCalibration(source.thumbnail, onProgress);
  saveCalibration(result);
  applyCalibration(result);
  broadcastUiState();
  captureBoardState().catch((error) => {
    console.error('Failed to refresh board capture after calibration', error);
  });
  return { success: true, calibratedAt: result.calibratedAt };
});

function watchPath(p) {
  if (!p || watchedPaths.has(p)) return;
  try {
    const dir = path.dirname(p);
    const base = path.basename(p);
    const watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 25
      }
    });

    const notifyChange = (changedPath) => {
      if (path.basename(changedPath || '') !== base) return;
      if (base === 'CardOperationLog.json') {
        processOperationLog();
      }
      if (cardListWindow && !cardListWindow.isDestroyed()) {
        cardListWindow.webContents.send('file-changed', p);
      }
    };

    watcher.on('add', notifyChange);
    watcher.on('change', notifyChange);
    watcher.on('unlink', notifyChange);
    watcher.on('error', (error) => {
      console.warn('watchPath fail', p, error);
    });

    watchedPaths.set(p, watcher);
  } catch (e) {
    console.warn('watchPath fail', e);
  }
}

ipcMain.handle('set-game-path', (_, gamePath) => {
  const s = loadSettings();
  s.gamePath = gamePath;
  saveSettings(s);
  watchPath(path.join(gamePath, 'BattleLog.json'));
  watchPath(path.join(gamePath, 'CardOperationLog.json'));
  processOperationLog();
  return true;
});

ipcMain.handle('read-derived-file', (_, fileName) => {
  const allowedFiles = {
    'ConvertedHandCard.json': getConvertedHandPath(),
    'ConvertedCardOperationLog.json': getConvertedOperationPath()
  };

  try {
    const safeName = path.basename(fileName || '');
    const resolvedPath = allowedFiles[safeName];
    if (resolvedPath && fileExists(resolvedPath)) {
      return fs.readFileSync(resolvedPath, 'utf8');
    }
  } catch (error) {}
  return '';
});
