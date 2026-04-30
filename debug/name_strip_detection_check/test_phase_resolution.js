'use strict';

// Run inside Electron: load check1.png as a nativeImage, set calibration,
// call detectSlotsNameStrip with the known hand, and print resolved phases.
//
// Run from project root:
//   npx --no-install electron debug/name_strip_detection_check/test_phase_resolution.js

const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { detectSlotsNameStrip, setCalibration } = require(path.join(ROOT, 'name_strip_detector'));

const SS_PATH    = path.join(__dirname, 'check1.png');
const CAL_PATH   = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

// Known cards in slots 0-3 of check1.png; slots 4-7 are locked.
const HAND = [
  '梦•混元碎击',
  '木灵•桃花印',
  '木灵•芽',
  '金灵•针',
];

app.whenReady().then(() => {
  try {
    const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
    setCalibration(cal);

    const img = nativeImage.createFromPath(SS_PATH);
    const res = detectSlotsNameStrip(img, HAND, IMAGES_DIR);

    console.log('Resolved slots:');
    for (let i = 0; i < res.slotResults.length; i++) {
      const r = res.slotResults[i];
      const c = r.card;
      const wt = r.winningTemplate;
      if (!c) {
        console.log(`  slot ${i}: empty (accepted=${r.accepted}, score=${r.bestScore})`);
        continue;
      }
      console.log(
        `  slot ${i}: ${c.name}` +
        (c.phase != null ? ` phase=${c.phase}` : '') +
        ` level=${c.level} score=${r.bestScore} margin=${r.margin}` +
        (wt?.phaseScore != null ? ` phaseScore=${wt.phaseScore.toFixed(3)} phaseMargin=${wt.phaseMargin?.toFixed?.(3)}` : '') +
        ` template=${c.templateFile}`
      );
      if (r.dreamPhaseCandidates) {
        console.log('    dream phase candidates:');
        for (const pc of r.dreamPhaseCandidates) {
          console.log(`      phase ${pc.phase}: combinedRank=${pc.combinedRank} chromaticRank=${pc.chromaticRank} maskRank=${pc.maskRank} chromaticScore=${pc.chromaticScore} (${pc.templateFile})`);
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('FAILED:', err);
    process.exit(1);
  }
});
