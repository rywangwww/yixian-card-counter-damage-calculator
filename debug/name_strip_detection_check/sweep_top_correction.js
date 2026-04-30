#!/usr/bin/env node
'use strict';

// Sweeps CALIBRATION_TOP_CORRECTION from 0.0 to 0.10 against check1.png
// and reports per-slot NCC of the expected card vs its templates.
// Output: table of correction → per-slot best NCC + average.

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { computeLayoutTransform } = require(path.join(ROOT, 'rect_scale'));

const SS_PATH  = path.join(__dirname, 'check1.png');
const CAL_PATH = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const IMAGES_DIR = path.join(ROOT, 'images');

const STRIP_RECT = {
  sect:     { x: 0.0988, y: 0, width: 0.1412, height: 0.6 },
  dream:    { x: 0.0608, y: 0, width: 0.1392, height: 0.6 },
  personal: { x: 0.109,  y: 0, width: 0.1398, height: 0.6 },
};
const STRIP_CANONICAL_H = 192;
const Y_SEARCH_RANGE = 4;
const X_SEARCH_RANGE = 2;

const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

const SLOTS = [
  { slot: 0, name: '梦•混元碎击', cls: 'dream'    },
  { slot: 1, name: '木灵•桃花印', cls: 'personal', char: 'HuaQinrui' },
  { slot: 2, name: '木灵•芽',     cls: 'sect'     },
  { slot: 3, name: '金灵•针',     cls: 'sect'     },
];

function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}
function bilinear(src,sw,sh,x,y){
  const x0=clamp(Math.floor(x),0,sw-1),y0=clamp(Math.floor(y),0,sh-1);
  const x1=Math.min(x0+1,sw-1),y1=Math.min(y0+1,sh-1);
  const wx=x-x0,wy=y-y0;
  return (1-wx)*(1-wy)*src[y0*sw+x0]+wx*(1-wy)*src[y0*sw+x1]+(1-wx)*wy*src[y1*sw+x0]+wx*wy*src[y1*sw+x1];
}
function resizeGray(src,sw,sh,dw,dh){
  const o=new Float32Array(dw*dh);
  for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)o[y*dw+x]=bilinear(src,sw,sh,(x+0.5)*sw/dw-0.5,(y+0.5)*sh/dh-0.5);
  return o;
}
function rgbaToGray(rgba,w,h){
  const g=new Float32Array(w*h);
  for(let i=0;i<w*h;i++)g[i]=0.299*rgba[i*4]+0.587*rgba[i*4+1]+0.114*rgba[i*4+2];
  return g;
}
function zncc(a,b,n){
  let sa=0,sb=0;for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}
  const ma=sa/n,mb=sb/n;
  let num=0,da=0,db=0;
  for(let i=0;i<n;i++){const a2=a[i]-ma,b2=b[i]-mb;num+=a2*b2;da+=a2*a2;db+=b2*b2;}
  const d=Math.sqrt(da*db);return d<1?0:num/d;
}

function extractTmplCanon(imgPath, rect) {
  const { data:rgba, width, height } = decodePng(imgPath);
  const gray = rgbaToGray(rgba, width, height);
  const cx = clamp(Math.round(rect.x*width),  0, width-1);
  const cy = clamp(Math.round(rect.y*height), 0, height-1);
  const cw = Math.max(1, Math.min(width-cx,  Math.round(rect.width*width)));
  const ch = Math.max(1, Math.min(height-cy, Math.round(rect.height*height)));
  const crop = new Float32Array(cw*ch);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)crop[y*cw+x]=gray[(cy+y)*width+(cx+x)];
  const canonH = STRIP_CANONICAL_H;
  const canonW = Math.max(24, Math.round((cw/ch)*canonH));
  return { gray:resizeGray(crop,cw,ch,canonW,canonH), w:canonW, h:canonH };
}

function extractScreenStripCrop(srcGray, srcW, srcH, slotRect, rect, topCorrection) {
  const correctedH = topCorrection > 0 ? slotRect.height / (1 - topCorrection) : slotRect.height;
  const correctedY = topCorrection > 0 ? (slotRect.y - topCorrection * correctedH) : slotRect.y;
  const sx = Math.round(slotRect.x + rect.x*slotRect.width);
  const sy = Math.round(correctedY + rect.y*correctedH);
  const sw = Math.max(1, Math.round(rect.width*slotRect.width));
  const sh = Math.max(1, Math.round(rect.height*correctedH));
  const x0 = Math.max(0,sx),         y0 = Math.max(0,sy);
  const x1 = Math.min(srcW,sx+sw),   y1 = Math.min(srcH,sy+sh);
  const aw = x1-x0, ah = y1-y0;
  if (aw<=0||ah<=0) return null;
  const crop = new Float32Array(aw*ah);
  for(let y=0;y<ah;y++)for(let x=0;x<aw;x++)crop[y*aw+x]=srcGray[(y0+y)*srcW+(x0+x)];
  return { gray:crop, w:aw, h:ah };
}

function getScaledSlotRect(slotIndex, ssSize, geom) {
  const t = computeLayoutTransform({width:geom.baseScreenWidth, height:geom.baseScreenHeight}, ssSize);
  return {
    x: Math.round(geom.slotXPositions[slotIndex]*t.scaleX),
    y: Math.round(geom.slotY*t.scaleY),
    width:  Math.max(1, Math.round(geom.slotWidth*t.sizeScaleX)),
    height: Math.max(1, Math.round(geom.slotHeight*t.sizeScaleY)),
  };
}

function dreamGeometry(active) {
  const ratio = (active.dreamSlotRatio && (active.dreamSlotRatio.width!==1||active.dreamSlotRatio.height!==1))
    ? active.dreamSlotRatio : DEFAULT_DREAM_RATIO;
  const xOff = typeof active.dreamXOffset==='number' ? active.dreamXOffset : DEFAULT_DREAM_X_OFFSET;
  return {
    ...active,
    slotXPositions: active.slotXPositions.map((x)=>x+xOff),
    slotWidth:  Math.max(1, Math.round(active.slotWidth*ratio.width)),
    slotHeight: Math.max(1, Math.round(active.slotHeight*ratio.height)),
  };
}

function walkDir(dir) {
  let out=[];
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const f=path.join(dir,e.name);
    if(e.isDirectory()) out=out.concat(walkDir(f));
    else if(e.isFile()&&e.name.toLowerCase().endsWith('.png')) out.push(f);
  }
  return out;
}
function normName(s){return (s||'').replace(/[·•]/g,'•').trim();}
function findTemplates(name, cls, charName) {
  const norm = normName(name);
  const base = norm.replace(/\d+$/,'');
  let dirs;
  if (cls==='dream') dirs=['seasonal'];
  else if (cls==='personal') dirs=['personal'];
  else dirs=['sect','side-jobs'];
  const all = dirs.map(d=>path.join(IMAGES_DIR,d)).filter(fs.existsSync).flatMap(walkDir);
  return all.filter((f)=>{
    const fn = path.basename(f,'.png');
    const m  = fn.match(/^(.*?)(\d+)$/u);
    if(!m) return false;
    const bn = normName(m[1]);
    if (bn!==norm && bn!==base) return false;
    if (cls==='personal' && charName) return f.includes(path.sep+'personal'+path.sep+charName+path.sep);
    return true;
  });
}

function bestNccForSlot(slotInfo, ssGray, ssW, ssH, ssSize, calActive, topCorrection, tmplCanons) {
  const stripRect = STRIP_RECT[slotInfo.cls];
  const geom = slotInfo.cls==='dream' ? dreamGeometry(calActive) : calActive;
  const slotRect = getScaledSlotRect(slotInfo.slot, ssSize, geom);

  let bestOverall = -Infinity;
  for (const canon of tmplCanons) {
    let bestNcc = -Infinity;
    for (let dy=-Y_SEARCH_RANGE; dy<=Y_SEARCH_RANGE; dy++){
      for (let dx=-X_SEARCH_RANGE; dx<=X_SEARCH_RANGE; dx++){
        const sR = { ...slotRect, x:slotRect.x+dx, y:slotRect.y+dy };
        const crop = extractScreenStripCrop(ssGray, ssW, ssH, sR, stripRect, topCorrection);
        if (!crop) continue;
        const screenR = resizeGray(crop.gray, crop.w, crop.h, canon.w, canon.h);
        const score = zncc(screenR, canon.gray, canon.w*canon.h);
        if (score > bestNcc) bestNcc = score;
      }
    }
    if (bestNcc > bestOverall) bestOverall = bestNcc;
  }
  return bestOverall;
}

function main() {
  const cal = JSON.parse(fs.readFileSync(CAL_PATH,'utf8'));
  const ss  = decodePng(SS_PATH);
  const ssGray = rgbaToGray(ss.data, ss.width, ss.height);
  const ssSize = { width: ss.width, height: ss.height };

  // Pre-load template canons per slot (independent of correction)
  const slotTemplates = SLOTS.map((s)=>{
    const files = findTemplates(s.name, s.cls, s.char);
    const rect  = STRIP_RECT[s.cls];
    return files.map((f)=>extractTmplCanon(f, rect));
  });

  const corrections = [];
  for (let c=0; c<=0.10001; c+=0.005) corrections.push(+c.toFixed(3));

  console.log(`Sweep CALIBRATION_TOP_CORRECTION on check1.png (2880x1794)`);
  console.log(`Slots: ${SLOTS.map(s=>`${s.slot}:${s.name}`).join('  ')}\n`);

  // Header
  process.stdout.write('correction'.padStart(11));
  for (const s of SLOTS) process.stdout.write(`  slot${s.slot}`.padStart(8));
  process.stdout.write('   avg'.padStart(8));
  console.log();

  let bestAvg = -Infinity, bestC = null;
  const allRows = [];
  for (const c of corrections) {
    const scores = SLOTS.map((s, i)=>bestNccForSlot(s, ssGray, ss.width, ss.height, ssSize, cal.slots, c, slotTemplates[i]));
    const avg = scores.reduce((a,b)=>a+b,0)/scores.length;
    allRows.push({ c, scores, avg });
    if (avg > bestAvg) { bestAvg = avg; bestC = c; }
    process.stdout.write(c.toFixed(3).padStart(11));
    for (const s of scores) process.stdout.write(s.toFixed(3).padStart(8));
    process.stdout.write(avg.toFixed(3).padStart(8));
    console.log();
  }
  console.log(`\nBest: correction=${bestC}  avg NCC=${bestAvg.toFixed(4)}`);
  const best = allRows.find(r=>r.c===bestC);
  best.scores.forEach((s,i)=>console.log(`  slot ${SLOTS[i].slot} (${SLOTS[i].name}): ${s.toFixed(4)}`));
}

main();
