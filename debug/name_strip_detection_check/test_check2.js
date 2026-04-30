'use strict';

// Verify detection on check2.png. Hand:
//   slot 0: 土灵印         (sect)
//   slot 1: 梦•土灵绝壁    (dream)
//   slot 2: 梦•土灵断崖    (dream)
//   slots 3-7: locked
//
// Run from project root:
//   npx --no-install electron debug/name_strip_detection_check/test_check2.js

const { app, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { detectSlotsNameStrip, setCalibration } = require(path.join(ROOT, 'name_strip_detector'));

const SS_PATH    = path.join(__dirname, 'check2.png');
const CAL_PATH   = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

const HAND = [
  '土灵印',
  '梦•土灵绝壁',
  '梦•土灵断崖',
];

app.whenReady().then(() => {
  try {
    const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
    setCalibration(cal);

    const img = nativeImage.createFromPath(SS_PATH);
    const sz = img.getSize();
    console.log(`Screenshot: ${sz.width}x${sz.height}, calibration base: ${cal.slots.baseScreenWidth}x${cal.slots.baseScreenHeight}`);

    const res = detectSlotsNameStrip(img, HAND, IMAGES_DIR);
    console.log(`searchRange: x=${res.debug.searchRange?.x} y=${res.debug.searchRange?.y}  scale: x=${res.debug.captureScale?.x?.toFixed(3)} y=${res.debug.captureScale?.y?.toFixed(3)}`);
    console.log();

    console.log('Resolved slots:');
    for (let i = 0; i < res.slotResults.length; i++) {
      const r = res.slotResults[i];
      const c = r.card;
      const wt = r.winningTemplate;
      if (!c) {
        const bc = r.bestCandidate, sc = r.secondCandidate;
        console.log(`  slot ${i}: empty (accepted=${r.accepted}, score=${r.bestScore}, margin=${r.margin})`);
        if (bc) console.log(`    best: ${bc.name} ${bc.isDream ? '(dream)' : ''} ncc=${bc.primaryScore} (${bc.templateFile})`);
        if (sc) console.log(`    2nd:  ${sc.name} ${sc.isDream ? '(dream)' : ''} ncc=${sc.primaryScore} (${sc.templateFile})`);
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
