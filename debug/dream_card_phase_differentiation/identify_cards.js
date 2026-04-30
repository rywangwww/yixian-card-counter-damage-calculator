'use strict';

// Runs the production detector against the two fengxu screenshots using the
// calibration the user pasted into ./calibration.json. Since we don't know
// the exact hand, we feed every unique base-name in images/ as the candidate
// hand list — the detector filters by name-strip NCC and the highest-scoring
// template wins per slot. Output: card name, level, phase, scores per slot.
//
// Run from project root:
//   ELECTRON_RUN_AS_NODE= node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     debug/dream_card_phase_differentiation/identify_cards.js

const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { detectSlotsNameStrip, setCalibration } = require(path.join(ROOT, 'name_strip_detector'));
const { buildTemplateIndex } = require(path.join(ROOT, 'slot_detector'));

const CAL_PATH   = path.join(__dirname, 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');
const SHOTS = [
  path.join(__dirname, 'fengxuround6.png'),
  path.join(__dirname, 'fengxuround7.png'),
  path.join(__dirname, 'fengxuround15.png'),
];

app.whenReady().then(() => {
  try {
    setCalibration(JSON.parse(fs.readFileSync(CAL_PATH, 'utf8')));

    // Build the full candidate-hand list: every distinct baseName in images/
    // (excluding non-game directories like avatars/sigils). This makes the
    // detector consider every template as a candidate.
    const idx = buildTemplateIndex(IMAGES_DIR);
    const allHand = [...new Set(
      [...idx.values()].flat()
        .filter((t) => !t.filePath.includes(`${path.sep}avatars${path.sep}`)
                    && !t.filePath.includes(`${path.sep}sigils${path.sep}`))
        .map((t) => t.baseName)
    )];
    console.log(`Candidate hand (every baseName in images/): ${allHand.length} entries`);

    for (const ssPath of SHOTS) {
      console.log(`\n=== ${path.basename(ssPath)} ===`);
      const img = nativeImage.createFromPath(ssPath);
      const res = detectSlotsNameStrip(img, allHand, IMAGES_DIR);
      for (let i = 0; i < res.slotResults.length; i++) {
        const r = res.slotResults[i];
        const c = r.card;
        if (!c) {
          console.log(`  slot ${i}: empty (accepted=${r.accepted}, bestScore=${r.bestScore?.toFixed?.(3)}, margin=${r.margin?.toFixed?.(3)})`);
          continue;
        }
        const phaseStr = c.phase != null ? ` phase=${c.phase}` : '';
        console.log(
          `  slot ${i}: ${c.name} level=${c.level}${phaseStr} score=${r.bestScore} margin=${r.margin} template=${c.templateFile}`
        );
        if (r.dreamPhaseCandidates) {
          for (const pc of r.dreamPhaseCandidates) {
            console.log(`      phase ${pc.phase}: combinedRank=${pc.combinedRank} chromaticRank=${pc.chromaticRank} maskRank=${pc.maskRank} chromaticScore=${pc.chromaticScore} (${pc.templateFile})`);
          }
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
});
