import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = process.cwd();
const extensionDir = path.join(root, 'extension');
const iconsDir = path.join(extensionDir, 'icons');
const distDir = path.join(root, 'dist');
const zipPath = path.join(distDir, 'hermes-relay-chrome.zip');
const outputSizes = [16, 32, 48, 128];
const MASTER_SIZE = 512;

fs.mkdirSync(iconsDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });

function roundedRectContains(x, y, left, top, width, height, radius) {
  const right = left + width;
  const bottom = top + height;

  if (x >= left + radius && x <= right - radius && y >= top && y <= bottom) return true;
  if (x >= left && x <= right && y >= top + radius && y <= bottom - radius) return true;

  const corners = [
    [left + radius, top + radius],
    [right - radius, top + radius],
    [left + radius, bottom - radius],
    [right - radius, bottom - radius],
  ];

  return corners.some(([cx, cy]) => ((x - cx) ** 2 + (y - cy) ** 2) <= radius ** 2);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby || 1;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / denom));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    rows[rowStart] = 0;
    pixels.copy(rows, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function renderMasterIcon() {
  const size = MASTER_SIZE;
  const pixels = Buffer.alloc(size * size * 4);
  const outer = { left: 40, top: 40, width: 432, height: 432, radius: 98 };
  const inner = { left: 56, top: 56, width: 400, height: 400, radius: 82 };
  const hexPoints = [
    [256, 96],
    [384, 192],
    [384, 320],
    [256, 416],
    [128, 320],
    [128, 192],
  ];
  const hexEdges = hexPoints.map((point, index) => [
    point,
    hexPoints[(index + 1) % hexPoints.length],
  ]);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;

      let r = 10;
      let g = 16;
      let b = 26;
      let a = 255;

      if (roundedRectContains(x, y, outer.left, outer.top, outer.width, outer.height, outer.radius)) {
        const gradient = (y - outer.top) / outer.height;
        r = Math.round(lerp(21, 13, gradient));
        g = Math.round(lerp(33, 19, gradient));
        b = Math.round(lerp(58, 32, gradient));
      }

      const borderBand = roundedRectContains(x, y, outer.left, outer.top, outer.width, outer.height, outer.radius)
        && !roundedRectContains(x, y, inner.left, inner.top, inner.width, inner.height, inner.radius);
      if (borderBand) {
        r = 45;
        g = 64;
        b = 93;
      }

      let glow = 0;
      for (const [[ax, ay], [bx, by]] of hexEdges) {
        const dist = distanceToSegment(x, y, ax, ay, bx, by);
        if (dist <= 9) {
          glow = Math.max(glow, 1 - dist / 9);
        }
      }
      if (glow > 0) {
        r = Math.round(lerp(r, 122, glow));
        g = Math.round(lerp(g, 215, glow));
        b = Math.round(lerp(b, 255, glow));
      }

      const vertical = Math.abs(x - 256) <= 14 && y >= 148 && y <= 364;
      if (vertical) {
        r = 234;
        g = 246;
        b = 255;
      }

      const topBar = Math.abs(y - 210) <= 14 && x >= 166 && x <= 346;
      const bottomBar = Math.abs(y - 292) <= 14 && x >= 186 && x <= 326;
      if (topBar || bottomBar) {
        r = 122;
        g = 215;
        b = 255;
      }

      const ring = Math.abs(Math.hypot(x - 256, y - 256) - 188) <= 2;
      if (ring) {
        r = Math.max(r, 82);
        g = Math.max(g, 181);
        b = Math.max(b, 255);
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = a;
    }
  }

  return { size, pixels };
}

function downsample(master, outputSize) {
  const ratio = master.size / outputSize;
  const output = Buffer.alloc(outputSize * outputSize * 4);

  for (let oy = 0; oy < outputSize; oy += 1) {
    for (let ox = 0; ox < outputSize; ox += 1) {
      const startX = Math.floor(ox * ratio);
      const endX = Math.floor((ox + 1) * ratio);
      const startY = Math.floor(oy * ratio);
      const endY = Math.floor((oy + 1) * ratio);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * master.size + x) * 4;
          r += master.pixels[offset];
          g += master.pixels[offset + 1];
          b += master.pixels[offset + 2];
          a += master.pixels[offset + 3];
          count += 1;
        }
      }

      const out = (oy * outputSize + ox) * 4;
      output[out] = Math.round(r / count);
      output[out + 1] = Math.round(g / count);
      output[out + 2] = Math.round(b / count);
      output[out + 3] = Math.round(a / count);
    }
  }

  return output;
}

const master = renderMasterIcon();
for (const size of outputSizes) {
  const png = encodePng(size, size, downsample(master, size));
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), png);
}

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath);
}

execFileSync('/usr/bin/zip', [
  '-r',
  zipPath,
  '.',
  '-x',
  '*.DS_Store',
  'icons/icon.svg',
], {
  cwd: extensionDir,
  stdio: 'inherit',
});

console.log(`Created ${zipPath}`);
