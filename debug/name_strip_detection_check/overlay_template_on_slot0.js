#!/usr/bin/env node
'use strict';

// Find the (dx, dy) that gives the best NCC for slot 0 dream against
// 梦•混元碎击2.png (the winning template), then build three PNGs:
//   - slot0_dream_overlay_side_by_side.png — screen strip + template strip side-by-side
//   - slot0_dream_overlay_blend.png         — template strip blended at 50% over slot0_dream_card.png
//   - slot0_dream_overlay_outline.png       — slot0_dream_card.png with red rect at strip position

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const { decodePng } = require(path.join(ROOT, 'calibrator'));
const { computeLayoutTransform } = require(path.join(ROOT, 'rect_scale'));

const STRIP_RECT_DREAM = { x: 0.0608, y: 0, width: 0.1392, height: 0.6 };
const STRIP_CANONICAL_H = 192;
const Y_SEARCH_RANGE = 4;
const X_SEARCH_RANGE = 2;
const DEFAULT_DREAM_RATIO    = { width: 0.925, height: 0.977 };
const DEFAULT_DREAM_X_OFFSET = 8;

const SS_PATH       = path.join(__dirname, 'check1.png');
const CAL_PATH      = path.join(process.env.HOME, 'Library', 'Application Support', 'yixian-overlay', 'calibration.json');
const TEMPLATE_PATH = path.join(ROOT, 'images', 'seasonal', 'five-element', '梦•混元碎击2.png');
const OUT_DIR       = path.join(__dirname, 'crops');

function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v));}
function bilinear(s,sw,sh,x,y){const x0=clamp(Math.floor(x),0,sw-1),y0=clamp(Math.floor(y),0,sh-1),x1=Math.min(x0+1,sw-1),y1=Math.min(y0+1,sh-1),wx=x-x0,wy=y-y0;return (1-wx)*(1-wy)*s[y0*sw+x0]+wx*(1-wy)*s[y0*sw+x1]+(1-wx)*wy*s[y1*sw+x0]+wx*wy*s[y1*sw+x1];}
function rsz(s,sw,sh,dw,dh){const o=new Float32Array(dw*dh);for(let y=0;y<dh;y++)for(let x=0;x<dw;x++)o[y*dw+x]=bilinear(s,sw,sh,(x+0.5)*sw/dw-0.5,(y+0.5)*sh/dh-0.5);return o;}
function rgbaToGray(rgba,w,h){const g=new Float32Array(w*h);for(let i=0;i<w*h;i++)g[i]=0.299*rgba[i*4]+0.587*rgba[i*4+1]+0.114*rgba[i*4+2];return g;}
function zncc(a,b,n){let sa=0,sb=0;for(let i=0;i<n;i++){sa+=a[i];sb+=b[i];}const ma=sa/n,mb=sb/n;let num=0,da=0,db=0;for(let i=0;i<n;i++){const a2=a[i]-ma,b2=b[i]-mb;num+=a2*b2;da+=a2*a2;db+=b2*b2;}const d=Math.sqrt(da*db);return d<1?0:num/d;}

function getSR(idx,size,geom){const t=computeLayoutTransform({width:geom.baseScreenWidth,height:geom.baseScreenHeight},size);return {x:Math.round(geom.slotXPositions[idx]*t.scaleX),y:Math.round(geom.slotY*t.scaleY),width:Math.max(1,Math.round(geom.slotWidth*t.sizeScaleX)),height:Math.max(1,Math.round(geom.slotHeight*t.sizeScaleY))};}
function dGeom(a){const r=(a.dreamSlotRatio&&(a.dreamSlotRatio.width!==1||a.dreamSlotRatio.height!==1))?a.dreamSlotRatio:DEFAULT_DREAM_RATIO;const xO=typeof a.dreamXOffset==='number'?a.dreamXOffset:DEFAULT_DREAM_X_OFFSET;return {...a,slotXPositions:a.slotXPositions.map(x=>x+xO),slotWidth:Math.max(1,Math.round(a.slotWidth*r.width)),slotHeight:Math.max(1,Math.round(a.slotHeight*r.height))};}

// ── PNG encoder (RGBA, no filters) ──
function encodePNG(rgba, width, height) {
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const tab = encodePNG._t || (encodePNG._t = (() => { const t = new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}return t;})());
    let crc = 0xffffffff; const buf = Buffer.concat([typeBuf, data]);
    for (let i=0;i<buf.length;i++) crc = tab[(crc^buf[i])&0xff] ^ (crc>>>8);
    const c = Buffer.alloc(4); c.writeUInt32BE((crc^0xffffffff)>>>0, 0);
    return Buffer.concat([len, typeBuf, data, c]);
  }
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8]=8; ihdr[9]=6;
  const stride = width*4;
  const filtered = Buffer.alloc(height*(stride+1));
  for (let y=0;y<height;y++){filtered[y*(stride+1)]=0;Buffer.from(rgba).copy(filtered, y*(stride+1)+1, y*stride, y*stride+stride);}
  const idat = zlib.deflateSync(filtered);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function cropRGBA(src, srcW, x, y, w, h) {
  const out = Buffer.alloc(w*h*4);
  for (let yy=0; yy<h; yy++) {
    const start = ((y+yy)*srcW + x) * 4;
    out.set(src.subarray(start, start + w*4), yy*w*4);
  }
  return out;
}

function resizeRGBA(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw*dh*4);
  for (let dy=0; dy<dh; dy++) {
    for (let dx=0; dx<dw; dx++) {
      const fx = (dx + 0.5) * sw / dw - 0.5;
      const fy = (dy + 0.5) * sh / dh - 0.5;
      const x0 = clamp(Math.floor(fx), 0, sw-1), y0 = clamp(Math.floor(fy), 0, sh-1);
      const x1 = Math.min(x0+1, sw-1), y1 = Math.min(y0+1, sh-1);
      const wx = fx-x0, wy = fy-y0;
      for (let c=0; c<4; c++) {
        const v = (1-wx)*(1-wy)*src[(y0*sw+x0)*4+c] + wx*(1-wy)*src[(y0*sw+x1)*4+c]
                + (1-wx)*wy*src[(y1*sw+x0)*4+c]    + wx*wy*src[(y1*sw+x1)*4+c];
        out[(dy*dw+dx)*4+c] = Math.round(v);
      }
    }
  }
  return out;
}

function main() {
  const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
  const ss  = decodePng(SS_PATH);
  const ssGray = rgbaToGray(ss.data, ss.width, ss.height);
  const ssSize = { width: ss.width, height: ss.height };
  const ssRGBA = ss.data;

  // Slot rect (dream geometry)
  const sr = getSR(0, ssSize, dGeom(cal.slots));
  console.log(`slot rect: ${JSON.stringify(sr)}`);

  // Template + canonical strip
  const tmpl = decodePng(TEMPLATE_PATH);
  const tmplGray = rgbaToGray(tmpl.data, tmpl.width, tmpl.height);
  const rect = STRIP_RECT_DREAM;
  const tcx = clamp(Math.round(rect.x*tmpl.width),  0, tmpl.width-1);
  const tcy = clamp(Math.round(rect.y*tmpl.height), 0, tmpl.height-1);
  const tcw = Math.max(1, Math.min(tmpl.width-tcx,  Math.round(rect.width*tmpl.width)));
  const tch = Math.max(1, Math.min(tmpl.height-tcy, Math.round(rect.height*tmpl.height)));
  console.log(`template strip in template: x=${tcx} y=${tcy} ${tcw}x${tch}`);

  const tmplCrop = new Float32Array(tcw*tch);
  for (let y=0;y<tch;y++) for (let x=0;x<tcw;x++) tmplCrop[y*tcw+x] = tmplGray[(tcy+y)*tmpl.width+(tcx+x)];
  const canonH = STRIP_CANONICAL_H;
  const canonW = Math.max(24, Math.round((tcw/tch)*canonH));
  const canon = rsz(tmplCrop, tcw, tch, canonW, canonH);

  // Sweep dx/dy to find best NCC (post-fix: no top correction)
  let best = -Infinity, bDx = 0, bDy = 0, bSx = 0, bSy = 0, bSw = 0, bSh = 0;
  for (let dy=-Y_SEARCH_RANGE; dy<=Y_SEARCH_RANGE; dy++) {
    for (let dx=-X_SEARCH_RANGE; dx<=X_SEARCH_RANGE; dx++) {
      const sx = Math.round(sr.x + dx + rect.x*sr.width);
      const sy = Math.round(sr.y + dy + rect.y*sr.height);
      const sw = Math.max(1, Math.round(rect.width*sr.width));
      const sh = Math.max(1, Math.round(rect.height*sr.height));
      const x0 = Math.max(0,sx),         y0 = Math.max(0,sy);
      const x1 = Math.min(ss.width,sx+sw), y1 = Math.min(ss.height,sy+sh);
      const aw = x1-x0, ah = y1-y0;
      if (aw<=0||ah<=0) continue;
      const c = new Float32Array(aw*ah);
      for (let y=0;y<ah;y++) for (let x=0;x<aw;x++) c[y*aw+x] = ssGray[(y0+y)*ss.width + (x0+x)];
      const r = rsz(c, aw, ah, canonW, canonH);
      const v = zncc(r, canon, canonW*canonH);
      if (v > best) { best = v; bDx = dx; bDy = dy; bSx = x0; bSy = y0; bSw = aw; bSh = ah; }
    }
  }
  console.log(`best NCC=${best.toFixed(4)} at dx=${bDx} dy=${bDy}`);
  console.log(`best screen strip rect: x=${bSx} y=${bSy} ${bSw}x${bSh}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Side by side: screen strip | template strip resized to same size
  const screenStrip = cropRGBA(ssRGBA, ss.width, bSx, bSy, bSw, bSh);
  const tmplStripRGBA = cropRGBA(tmpl.data, tmpl.width, tcx, tcy, tcw, tch);
  const tmplStripResized = resizeRGBA(tmplStripRGBA, tcw, tch, bSw, bSh);
  const sbsW = bSw * 2 + 4, sbsH = bSh;
  const sbs = Buffer.alloc(sbsW * sbsH * 4);
  for (let y=0;y<sbsH;y++) {
    screenStrip.copy(sbs, y*sbsW*4, y*bSw*4, (y+1)*bSw*4);
    // 4-px white gap
    for (let x=bSw; x<bSw+4; x++) {
      const off = (y*sbsW + x)*4;
      sbs[off] = 255; sbs[off+1] = 255; sbs[off+2] = 255; sbs[off+3] = 255;
    }
    tmplStripResized.copy(sbs, (y*sbsW + bSw + 4)*4, y*bSw*4, (y+1)*bSw*4);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'slot0_dream_overlay_side_by_side.png'), encodePNG(sbs, sbsW, sbsH));

  // 2. Blend: take the slot card crop, alpha-blend the template strip at 50% at the strip's position relative to the card
  const cardX = sr.x, cardY = sr.y, cardW = sr.width, cardH = sr.height;
  const slotCardRGBA = cropRGBA(ssRGBA, ss.width, cardX, cardY, cardW, cardH);
  // Resized template strip lives at (bSx - cardX, bSy - cardY) with (bSw, bSh)
  const offX = bSx - cardX, offY = bSy - cardY;
  const blend = Buffer.from(slotCardRGBA);
  for (let y=0;y<bSh;y++) {
    for (let x=0;x<bSw;x++) {
      const dstX = offX + x, dstY = offY + y;
      if (dstX < 0 || dstX >= cardW || dstY < 0 || dstY >= cardH) continue;
      const dOff = (dstY*cardW + dstX)*4;
      const sOff = (y*bSw + x)*4;
      // Tint template red, blend 50%
      const tr = Math.min(255, tmplStripResized[sOff] + 80);
      const tg = Math.max(0,   tmplStripResized[sOff+1] - 20);
      const tb = Math.max(0,   tmplStripResized[sOff+2] - 20);
      blend[dOff]   = Math.round(0.5*blend[dOff]   + 0.5*tr);
      blend[dOff+1] = Math.round(0.5*blend[dOff+1] + 0.5*tg);
      blend[dOff+2] = Math.round(0.5*blend[dOff+2] + 0.5*tb);
      blend[dOff+3] = 255;
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'slot0_dream_overlay_blend.png'), encodePNG(blend, cardW, cardH));

  // 3. Outline: slot card with red 2-px rect at the strip position
  const outline = Buffer.from(slotCardRGBA);
  function drawHLine(buf, w, x, y, len, r, g, b) {
    for (let i=0;i<len;i++) { const off = (y*w + (x+i))*4; buf[off]=r; buf[off+1]=g; buf[off+2]=b; buf[off+3]=255; }
  }
  function drawVLine(buf, w, x, y, len, r, g, b) {
    for (let i=0;i<len;i++) { const off = ((y+i)*w + x)*4; buf[off]=r; buf[off+1]=g; buf[off+2]=b; buf[off+3]=255; }
  }
  for (let t=0;t<2;t++) {
    drawHLine(outline, cardW, offX,        offY+t,     bSw, 255, 0, 0);
    drawHLine(outline, cardW, offX,        offY+bSh-1-t, bSw, 255, 0, 0);
    drawVLine(outline, cardW, offX+t,      offY,       bSh, 255, 0, 0);
    drawVLine(outline, cardW, offX+bSw-1-t, offY,       bSh, 255, 0, 0);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'slot0_dream_overlay_outline.png'), encodePNG(outline, cardW, cardH));

  console.log(`Wrote three overlay images to ${OUT_DIR}/`);
}

main();
