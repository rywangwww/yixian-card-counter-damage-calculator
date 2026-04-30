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

const STRIP_RECT_SECT = { x: 0.0988, y: 0, width: 0.1412, height: 0.6 };
const STRIP_CANONICAL_H = 192;
const CALIBRATION_TOP_CORRECTION = 0.079;

function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}
function bl(src,sw,sh,x,y){const x0=clamp(Math.floor(x),0,sw-1),y0=clamp(Math.floor(y),0,sh-1),x1=Math.min(x0+1,sw-1),y1=Math.min(y0+1,sh-1),wx=x-x0,wy=y-y0;return (1-wx)*(1-wy)*src[y0*sw+x0]+wx*(1-wy)*src[y0*sw+x1]+(1-wx)*wy*src[y1*sw+x0]+wx*wy*src[y1*sw+x1];}
function resize(src,sw,sh,dw,dh){const o=new Float32Array(dw*dh);for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)o[y*dw+x]=bl(src,sw,sh,(x+0.5)*sw/dw-0.5,(y+0.5)*sh/dh-0.5);return o;}
function toGray(rgba,w,h){const g=new Float32Array(w*h);for(let i=0;i<w*h;i++)g[i]=0.299*rgba[i*4]+0.587*rgba[i*4+1]+0.114*rgba[i*4+2];return g;}
function zncc(a,b,n){let sa=0,sb=0;for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}const ma=sa/n,mb=sb/n;let num=0,da=0,db=0;for(let i=0;i<n;i++){const a2=a[i]-ma,b2=b[i]-mb;num+=a2*b2;da+=a2*a2;db+=b2*b2;}const d=Math.sqrt(da*db);return d<1?0:num/d;}

function walkDir(dir){let o=[];for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())o=o.concat(walkDir(f));else if(e.isFile()&&e.name.toLowerCase().endsWith('.png')&&/\d\.png$/.test(e.name))o.push(f);}return o;}

const cal = JSON.parse(fs.readFileSync(CALIBRATION_PATH,'utf8'));
const ss = decodePng(SS_PATH);
const ssG = toGray(ss.data, ss.width, ss.height);
const ssW=ss.width, ssH=ss.height;
const n = cal.slots;
const scaleX = ssW/n.baseScreenWidth;

const allCards = walkDir(path.join(ROOT,'images','sect'))
  .concat(walkDir(path.join(ROOT,'images','side-jobs')));

function findTmpl(keyword) {
  return allCards.find(f => path.basename(f).includes(keyword));
}

const TESTS = [
  { slotIdx: 1, card: '云剑•飞刺3', tmplPath: findTmpl('飞刺3') },
  { slotIdx: 3, card: '云剑•汇灵2', tmplPath: findTmpl('汇灵2') },
];

for(const t of TESTS){
  if (!t.tmplPath) { console.log('no template for '+t.card); continue; }
  const slotRect = {
    x: Math.round(n.slotXPositions[t.slotIdx]*scaleX),
    y: Math.round(n.slotY),
    width:  Math.max(1, Math.round(n.slotWidth*scaleX)),
    height: Math.max(1, Math.round(n.slotHeight)),
  };
  const tmpl = decodePng(t.tmplPath);
  const tG = toGray(tmpl.data, tmpl.width, tmpl.height);
  const rect=STRIP_RECT_SECT;
  const cx=clamp(Math.round(rect.x*tmpl.width),0,tmpl.width-1);
  const cw=Math.max(1,Math.min(tmpl.width-cx,Math.round(rect.width*tmpl.width)));
  const ch=Math.max(1,Math.min(tmpl.height,Math.round(rect.height*tmpl.height)));
  const cH=STRIP_CANONICAL_H, cW=Math.max(24,Math.round((cw/ch)*cH));
  const tCrop=new Float32Array(cw*ch);
  for(let y=0;y<ch;y++)for(let x=0;x<cw;x++)tCrop[y*cw+x]=tG[y*tmpl.width+(cx+x)];
  const tCan=resize(tCrop,cw,ch,cW,cH);

  const corrH=slotRect.height/(1-CALIBRATION_TOP_CORRECTION);
  const corrY=slotRect.y-CALIBRATION_TOP_CORRECTION*corrH;
  const sw=Math.max(1,Math.round(rect.width*slotRect.width));
  const sh=Math.max(1,Math.round(rect.height*corrH));
  const baseX=Math.round(slotRect.x+rect.x*slotRect.width);

  console.log('\n=== Slot '+(t.slotIdx+1)+' ('+t.card+') ===');
  console.log('  slotRect: x='+slotRect.x+' y='+slotRect.y+' w='+slotRect.width+' h='+slotRect.height);
  console.log('  tmpl: '+path.relative(ROOT,t.tmplPath)+' ('+tmpl.width+'x'+tmpl.height+')');
  console.log('  strip baseX='+baseX+' corrY='+Math.round(corrY)+' sw='+sw+' sh='+sh+' canonW='+cW);
  console.log('');
  process.stdout.write('       ');
  for(let dx=-5;dx<=5;dx++) process.stdout.write(('dx='+dx).padStart(7));
  console.log();
  for(let dy=-4;dy<=6;dy++){
    const sy=Math.round(corrY)+dy;
    process.stdout.write(('dy='+dy).padStart(7));
    for(let dx=-5;dx<=5;dx++){
      const sx=baseX+dx;
      if(sx<0||sx+sw>ssW||sy<0||sy+sh>ssH){process.stdout.write('   ----');continue;}
      const crop=new Float32Array(sw*sh);
      for(let y=0;y<sh;y++)for(let x=0;x<sw;x++)crop[y*sw+x]=ssG[(sy+y)*ssW+(sx+x)];
      const sR=resize(crop,sw,sh,cW,cH);
      process.stdout.write(zncc(sR,tCan,cW*cH).toFixed(3).padStart(7));
    }
    console.log();
  }
}
