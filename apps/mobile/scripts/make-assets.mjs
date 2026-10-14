// scripts/make-assets.mjs — rebuild mobile brand art from repo assets/brand.
// No deps (node:fs + node:zlib): copies 1024 icon, downscales 432 adaptive
// foreground, renders dark splash, copies header wordmarks, pins app.json.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const brand = path.resolve(mobile, '..', '..', 'assets', 'brand');
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  TABLE[n] = c >>> 0;
}
function crc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.from(type, 'ascii'), body = Buffer.concat([head, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4);
  out.writeUInt32BE(crc(body), 8 + data.length);
  return out;
}
export function decodePng(file) {
  const b = fs.readFileSync(file);
  if (!b.subarray(0, 8).equals(SIG)) throw new Error('not PNG: ' + file);
  let pos = 8, w = 0, h = 0, ct = 0, depth = 0, lace = 0;
  const parts = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos), type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ct = data[9]; lace = data[12];
    } else if (type === 'IDAT') parts.push(data);
    pos += 12 + len;
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!ch || depth !== 8 || lace !== 0) throw new Error('need 8-bit RGB(A): ' + file);
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = w * ch;
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++, p++) {
      const v = raw[p], a = x >= ch ? raw[p - ch] : 0;
      const bd = y > 0 ? raw[p - stride - 1] : 0;
      const cd = x >= ch && y > 0 ? raw[p - stride - 1 - ch] : 0;
      raw[p] = f === 0 ? v : f === 1 ? (v + a) & 255 : f === 2 ? (v + bd) & 255
        : f === 3 ? (v + ((a + bd) >> 1)) & 255 : (v + paeth(a, bd, cd)) & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < w; x++) {
      const s = row + x * ch, d = (y * w + x) * 4;
      rgba[d] = raw[s]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = ch === 4 ? raw[s + 3] : 255;
    }
  }
  return { w, h, data: rgba };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
}
export function encodePng(w, h, rgba) {
  const stride = w * 4, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIG, chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export function downscale(src, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4), sx = src.w / dw, sy = src.h / dh;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const x0 = x * sx, x1 = x0 + sx, y0 = y * sy, y1 = y0 + sy;
    let r = 0, g = 0, bl = 0, a = 0, tot = 0;
    for (let yy = Math.floor(y0); yy < y1; yy++) for (let xx = Math.floor(x0); xx < x1; xx++) {
      const wt = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * (Math.min(yy + 1, y1) - Math.max(yy, y0));
      const i = (yy * src.w + xx) * 4;
      r += src.data[i] * wt; g += src.data[i + 1] * wt;
      bl += src.data[i + 2] * wt; a += src.data[i + 3] * wt; tot += wt;
    }
    const o = (y * dw + x) * 4;
    out[o] = Math.round(r / tot); out[o + 1] = Math.round(g / tot);
    out[o + 2] = Math.round(bl / tot); out[o + 3] = Math.round(a / tot);
  }
  return { w: dw, h: dh, data: out };
}
function make() {
  const icon = decodePng(path.join(brand, 'crewbus-app-icon-1024-rounded.png'));
  console.log('brand icon: ' + icon.w + 'x' + icon.h);
  fs.copyFileSync(
    path.join(brand, 'crewbus-app-icon-1024-rounded.png'),
    path.join(mobile, 'assets', 'icon.png'));
  const fg = downscale(icon, 432, 432);
  fs.writeFileSync(path.join(mobile, 'assets', 'adaptive-foreground.png'), encodePng(432, 432, fg.data));
  console.log('adaptive-foreground: 432x432 (check.mjs pins this size — NOT 1024)');
  // splash.png is committed brand art with a TRANSPARENT background, so it
  // composites over whatever expo.splash.backgroundColor is set to below.
  // Keep the file as-is; regenerating it would only bake in an opaque matte.
  fs.accessSync(path.join(mobile, 'assets', 'splash.png'));
  fs.copyFileSync(path.join(brand, 'crewbus-logo-for-light.png'),
    path.join(mobile, 'assets', 'header-logo-light.png'));
  fs.copyFileSync(path.join(brand, 'crewbus-logo-for-dark.png'),
    path.join(mobile, 'assets', 'header-logo-dark.png'));
  console.log('header logos copied');
  const appPath = path.join(mobile, 'app.json');
  const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
  app.expo.userInterfaceStyle = 'automatic';
  app.expo.splash.backgroundColor = '#0f1419';
  app.expo.android.adaptiveIcon.backgroundColor = '#0f1419';
  fs.writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n');
  console.log('app.json pinned to automatic + #0f1419');
}
make();
