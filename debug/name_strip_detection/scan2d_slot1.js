#!/usr/bin/env node
'use strict';
// DEPRECATED — hardcodes CALIBRATION_TOP_CORRECTION=0.079 which was removed
// from name_strip_detector.js. Output no longer reflects live detector behavior.
const path = require('path');
const fs   = require('fs');
const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));

const CALIBRATION_PATH = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const SS_PATH = path.join(__dirname, '..', 'calibration', 'calibration_capture.png');
const IMAGES_DIR = path.join(ROOT, 'images');

const STRIP_RECT_SECT = { x: 0.0988, y: 0, width: 0.1412, height: 0.6 };
const STRIP_CANONICAL_H = 192;
const CALIBRATION_TOP_CORRECTION = 0.079;

function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}
function bilinearSample(src,sw,sh,x,y){
  const x0=clamp(Math.floor(x),0,sw-1),y0=clamp(Math.floor(y),0,sh-1);
  const x1=Math.min(x0+1,sw-1),y1=Math.min(y0+1,sh-1);
  const wx=x-x0,wy=y-y0;
  return (1-wx)*(1-wy)*src[y0*sw+x0]+wx*(1-wy)*src[y0*sw+x1]+(1-wx)*wy*src[y1*sw+x0]+wx*wy*src[y1*sw+x1];
}
function resizeGray(src,sw,sh,dw,dh){
  const out=new Float32Array(dw*dh);
  for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)out[y*dw+x]=bilinearSample(src,sw,sh,(x+0.5)*sw/dw-0.5,(y+0.5)*sh/dh-0.5);
  return out;
}
function rgbaToGray(rgba,w,h){
  const g=new Float32Array(w*h);
  for(let i=0;i<w*h;i++)g[i]=0.299*rgba[i*4]+0.587*rgba[i*4+1]+0.114*rgba[i*4+2];
  return g;
}
function zncc(a,b,n){
  let sA=0,sB=0;
  for(let i=0;i<n;i++){sA+=a[i];sB+=b[i];}
  const mA=sA/n,mB=sB/n;
  let num=0,dA=0,dB=0;
  for(let i=0;i<n;i++){const da=a[i]-mA,db=b[i]-mB;num+=da*db;dA+=da*da;dB+=db*db;}
  const d=Math.sqrt(dA*dB);return d<1?0:num/d;
}

const cal = JSON.parse(fs.readFileSync(CALIBRATION_PATH,'utf8'));
const ss = decodePng(SS_PATH);
const ssGray = rgbaToGray(ss.data, ss.width, ss.height);
const ssW = ss.width, ssH = ss.height;

const n = cal.slots;
const scaleX = ssW / n.baseScreenWidth;
const slotRect = {
  x: Math.round(n.slotXPositions[0]*scaleX),
  y: Math.round(n.slotY),
  width:  Math.max(1, Math.round(n.slotWidth*scaleX)),
  height: Math.max(1, Math.round(n.slotHeight)),
};
console.log('Slot 1 rect:', slotRect);

// Try both template filenames
// Use actual game card template (must end with digit, not sigil artwork)
function walkDir(dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkDir(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith('.png') && /\d\.png$/.test(e.name) && e.name.includes('闪风')) out.push(full);
  }
  return out;
}
const found = walkDir(path.join(IMAGES_DIR, 'sect'));
console.log('Found 闪风 card files:', found.map(f => path.relative(ROOT, f)));
let tmplFile = found[0];
if (!tmplFile) { console.log('no template found'); process.exit(1); }
console.log('Template:', path.relative(ROOT, tmplFile));

const tmpl = decodePng(tmplFile);
const tmplGray = rgbaToGray(tmpl.data, tmpl.width, tmpl.height);
const rect = STRIP_RECT_SECT;
const cx=clamp(Math.round(rect.x*tmpl.width),0,tmpl.width-1),cy=0;
const cw=Math.max(1,Math.min(tmpl.width-cx,Math.round(rect.width*tmpl.width)));
const ch=Math.max(1,Math.min(tmpl.height,Math.round(rect.height*tmpl.height)));
const canonH=STRIP_CANONICAL_H;
const canonW=Math.max(24,Math.round((cw/ch)*canonH));
console.log(`Template ${tmpl.width}x${tmpl.height}, strip ${cw}x${ch} -> canon ${canonW}x${canonH}`);
const tmplCrop=new Float32Array(cw*ch);
for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)tmplCrop[y*cw+x]=tmplGray[y*tmpl.width+(cx+x)];
const tmplCanon=resizeGray(tmplCrop,cw,ch,canonW,canonH);

const corrH = slotRect.height/(1-CALIBRATION_TOP_CORRECTION);
const corrY = slotRect.y - CALIBRATION_TOP_CORRECTION*corrH;
const sw=Math.max(1,Math.round(rect.width*slotRect.width));
const sh=Math.max(1,Math.round(rect.height*corrH));
console.log(`Corrected strip base: x=${Math.round(slotRect.x+rect.x*slotRect.width)} y=${Math.round(corrY)} sw=${sw} sh=${sh}`);

console.log('\n2D NCC scan (rows=dy, cols=dx):');
process.stdout.write('    dx: ');
for(let dx=-4;dx<=4;dx++) process.stdout.write(dx.toString().padStart(5));
console.log();
for(let dy=-4;dy<=6;dy++){
  const sy=Math.round(corrY)+dy;
  process.stdout.write(`dy=${dy<0?'':' '}${dy}: `);
  for(let dx=-4;dx<=4;dx++){
    const baseX=Math.round(slotRect.x+rect.x*slotRect.width);
    const sx=baseX+dx;
    if(sx<0||sx+sw>ssW||sy<0||sy+sh>ssH){process.stdout.write(' ----');continue;}
    const crop=new Float32Array(sw*sh);
    for(let y=0;y<sh;y++)for(let x=0;x<sw;x++)crop[y*sw+x]=ssGray[(sy+y)*ssW+(sx+x)];
    const screenR=resizeGray(crop,sw,sh,canonW,canonH);
    const score=zncc(screenR,tmplCanon,canonW*canonH);
    process.stdout.write(score.toFixed(2).padStart(5));
  }
  console.log();
}
