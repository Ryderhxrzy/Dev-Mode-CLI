#!/usr/bin/env node
/**
 * Zero-dependency PNG to ASCII Art generator for Dev Mode CLI.
 * Decodes PNG IHDR and IDAT chunks with Node.js built-in zlib.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idatParts = [];

  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const chunkType = buffer.toString('ascii', pos + 4, pos + 8);
    pos += 8;
    const chunkData = buffer.subarray(pos, pos + len);
    pos += len + 4; // skip CRC

    if (chunkType === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
    } else if (chunkType === 'IDAT') {
      idatParts.push(chunkData);
    }
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const recon = Buffer.alloc(height * stride);

  let rawIdx = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawIdx++];
    const scanline = raw.subarray(rawIdx, rawIdx + stride);
    rawIdx += stride;

    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;

    if (filter === 0) {
      scanline.copy(recon, rowStart);
    } else if (filter === 1) {
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? recon[rowStart + x - 4] : 0;
        recon[rowStart + x] = (scanline[x] + left) & 0xff;
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x++) {
        const up = y > 0 ? recon[prevRowStart + x] : 0;
        recon[rowStart + x] = (scanline[x] + up) & 0xff;
      }
    } else if (filter === 3) {
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? recon[rowStart + x - 4] : 0;
        const up = y > 0 ? recon[prevRowStart + x] : 0;
        recon[rowStart + x] = (scanline[x] + Math.floor((left + up) / 2)) & 0xff;
      }
    } else if (filter === 4) {
      for (let x = 0; x < stride; x++) {
        const left = x >= 4 ? recon[rowStart + x - 4] : 0;
        const up = y > 0 ? recon[prevRowStart + x] : 0;
        const upLeft = (y > 0 && x >= 4) ? recon[prevRowStart + x - 4] : 0;
        recon[rowStart + x] = (scanline[x] + paethPredictor(left, up, upLeft)) & 0xff;
      }
    }
  }

  return { width, height, stride, recon };
}

function imageToAscii(pngData, options = {}) {
  const { width, height, stride, recon } = pngData;
  const outW = options.width || 56;
  const aspect = options.aspect || 2.05;
  const palette = options.palette || ' .:-*#%@';
  const outH = Math.floor((height / width) * outW / aspect * 2);

  function getPixel(x, y) {
    const idx = (y * stride) + (x * 4);
    const r = recon[idx];
    const g = recon[idx + 1];
    const b = recon[idx + 2];
    const a = recon[idx + 3];
    if (a < 50) return 0;
    return Math.floor((r + g + b) / 3);
  }

  const lines = [];
  for (let cy = 0; cy < outH; cy++) {
    let line = '';
    const yStart = Math.floor(cy * height / outH);
    const yEnd = Math.floor((cy + 1) * height / outH);

    for (let cx = 0; cx < outW; cx++) {
      const xStart = Math.floor(cx * width / outW);
      const xEnd = Math.floor((cx + 1) * width / outW);

      let tot = 0;
      let count = 0;
      const stepY = Math.max(1, Math.floor((yEnd - yStart) / 4));
      const stepX = Math.max(1, Math.floor((xEnd - xStart) / 4));

      for (let y = yStart; y < yEnd; y += stepY) {
        for (let x = xStart; x < xEnd; x += stepX) {
          tot += getPixel(x, y);
          count++;
        }
      }

      const avg = tot / Math.max(1, count);
      const chIdx = Math.floor(avg / 256 * palette.length);
      line += palette[Math.min(palette.length - 1, chIdx)];
    }
    lines.push(line.replace(/\s+$/, ''));
  }

  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();

  return lines;
}

// CLI runner
if (require.main === module) {
  const defaultImagePath = path.resolve(__dirname, '../../developer-option-toggle/assets/images/notification_icon.png');
  const targetImage = process.argv[2] || defaultImagePath;

  if (!fs.existsSync(targetImage)) {
    console.error(`Image not found: ${targetImage}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(targetImage);
  const decoded = decodePng(buf);
  const lines = imageToAscii(decoded, { width: 56, aspect: 2.05, palette: ' .:-*#%@' });

  console.log('const DEV_MODE_ICON_ASCII = [');
  for (const line of lines) {
    console.log(`  ${JSON.stringify(line)},`);
  }
  console.log('];\n');
}

module.exports = { decodePng, imageToAscii };

