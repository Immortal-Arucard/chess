import assert from 'node:assert/strict';
import { sanitizeProfileImage } from './profile-image.mjs';

const jpeg = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda00080001000100003f00fbffd9',
  'hex'
);
const exif = Buffer.concat([
  jpeg.subarray(0, 2),
  Buffer.from([0xff, 0xe1, 0x00, 0x12]),
  Buffer.from('Exif\0SECRET-EXIF', 'ascii'),
  jpeg.subarray(2)
]);
const clean = sanitizeProfileImage(exif, 'image/jpeg');
assert.equal(clean.type, 'image/jpeg');
assert.equal(clean.bytes.includes(Buffer.from('SECRET-EXIF')), false);
assert.equal(clean.bytes[0], 0xff);
assert.equal(clean.bytes[1], 0xd8);
assert.equal(clean.bytes[clean.bytes.length - 2], 0xff);
assert.equal(clean.bytes[clean.bytes.length - 1], 0xd9);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const textData = Buffer.from('Comment\0SECRET-PNG');
const textLength = Buffer.alloc(4);
textLength.writeUInt32BE(textData.length);
const textChunk = Buffer.concat([textLength, Buffer.from('tEXt'), textData, Buffer.alloc(4)]);
const pngWithText = Buffer.concat([png.subarray(0, png.length - 12), textChunk, png.subarray(png.length - 12)]);
const cleanPng = sanitizeProfileImage(pngWithText, 'image/png');
assert.equal(cleanPng.bytes.includes(Buffer.from('SECRET-PNG')), false);
assert.equal(cleanPng.bytes.includes(Buffer.from('IDAT')), true);

assert.throws(() => sanitizeProfileImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'), /JPEG, PNG, or WebP/);
assert.throws(() => sanitizeProfileImage(png, 'image/jpeg'), /JPEG, PNG, or WebP/);
assert.throws(() => sanitizeProfileImage(Buffer.alloc(0), 'image/png'), /JPEG, PNG, or WebP/);

const progressive = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb004300140e0f120f0d14121012171514181e32211e1c1c1e3d2c2e243249404c4b47404645505a736250556d5645466488656d777b8182814e608d978c7d96737e817cffdb0043011517171e1a1e3b21213b7c5346537c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7cffc20011080002000203012200021101031101ffc4001500010100000000000000000000000000000004ffc4001501010100000000000000000000000000000405ffda000c03010002100310000001901ec7ffc40014100100000000000000000000000000000000ffda00080101000105027fffc40014110100000000000000000000000000000000ffda0008010301013f017fffc40014110100000000000000000000000000000000ffda0008010201013f017fffc40014100100000000000000000000000000000000ffda0008010100063f027fffc40014100100000000000000000000000000000000ffda0008010100013f217fffda000c03010002000300000010f3ffc40014110100000000000000000000000000000000ffda0008010301013f107fffc40014110100000000000000000000000000000000ffda0008010201013f107fffc40014100100000000000000000000000000000000ffda0008010100013f107fffd9', 'hex');

function spliceAfterFirstScan(source, extra) {
  let i = 2;
  let scans = 0;
  while (i < source.length) {
    if (source[i] !== 0xff) throw new Error('broken jpeg');
    while (source[i] === 0xff) i += 1;
    const marker = source[i];
    i += 1;
    if (marker === 0xd9) break;
    const length = source.readUInt16BE(i);
    if (marker !== 0xda) {
      i += length;
      continue;
    }
    scans += 1;
    i += length;
    while (i < source.length) {
      if (source[i] !== 0xff) {
        i += 1;
        continue;
      }
      let markerAt = i;
      while (source[markerAt] === 0xff) markerAt += 1;
      const next = source[markerAt];
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        i = markerAt + 1;
        continue;
      }
      if (scans === 1) return Buffer.concat([source.subarray(0, i), extra, source.subarray(i)]);
      break;
    }
  }
  throw new Error('no scan');
}

function markerSegment(marker, text) {
  const payload = Buffer.from(text, 'ascii');
  const segment = Buffer.alloc(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = marker;
  segment.writeUInt16BE(2 + payload.length, 2);
  payload.copy(segment, 4);
  return segment;
}

const between = spliceAfterFirstScan(progressive, Buffer.concat([
  markerSegment(0xe1, 'Exif\0SECRET-BETWEEN'),
  markerSegment(0xfe, 'SECRET-COM')
]));
assert.equal(between.includes(Buffer.from('SECRET-BETWEEN')), true);
const stripped = sanitizeProfileImage(between, 'image/jpeg');
assert.equal(stripped.bytes.includes(Buffer.from('SECRET-BETWEEN')), false);
assert.equal(stripped.bytes.includes(Buffer.from('SECRET-COM')), false);
assert.equal(stripped.bytes.includes(Buffer.from([0xff, 0xe1])), false);
assert.equal(stripped.bytes.includes(Buffer.from([0xff, 0xfe])), false);
assert.equal(stripped.bytes.includes(Buffer.from([0xff, 0xc2])), true);
let scans = 0;
for (let index = 0; index < stripped.bytes.length - 1; index += 1) {
  if (stripped.bytes[index] === 0xff && stripped.bytes[index + 1] === 0xda) scans += 1;
}
assert.ok(scans > 1);

const simpleWebp = Buffer.from('524946463800000057454250565038202c0000009001009d012a0200020002003425a00274ba00039800fef9936fff901fff901fff901fff203fe2177b203000', 'hex');
const vp8 = simpleWebp.subarray(20, 64);
function chunk(fourcc, data) {
  const header = Buffer.alloc(8);
  header.write(fourcc, 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
function vp8x(flags, width, height) {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return data;
}
function webp(parts) {
  const payload = Buffer.concat([Buffer.from('WEBP'), ...parts]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload]);
}
const extended = webp([
  chunk('VP8X', vp8x(0x20 | 0x08 | 0x10, 2, 2)),
  chunk('ICCP', Buffer.from('SECRET-ICC')),
  chunk('EXIF', Buffer.from('SECRET-WEBP-EXIF')),
  chunk('VP8 ', vp8)
]);
const cleanWebp = sanitizeProfileImage(extended, 'image/webp');
assert.equal(cleanWebp.bytes.includes(Buffer.from('SECRET-ICC')), false);
assert.equal(cleanWebp.bytes.includes(Buffer.from('SECRET-WEBP-EXIF')), false);
assert.equal(cleanWebp.bytes.includes(Buffer.from('ICCP')), false);
assert.equal(cleanWebp.bytes[20] & 0x20, 0);
assert.equal(cleanWebp.bytes[20] & 0x08, 0);
assert.equal(cleanWebp.bytes[20] & 0x10, 0);
assert.equal(cleanWebp.bytes.includes(Buffer.from('VP8 ')), true);
const plain = sanitizeProfileImage(simpleWebp, 'image/webp');
assert.equal(plain.bytes.includes(Buffer.from('VP8 ')), true);
const hugeCanvas = webp([chunk('VP8X', vp8x(0, 5000, 2)), chunk('VP8 ', vp8)]);
assert.throws(() => sanitizeProfileImage(hugeCanvas, 'image/webp'), /JPEG, PNG, or WebP/);
const hugeFrame = Buffer.from(vp8);
hugeFrame.writeUInt16LE(5000, 6);
assert.throws(() => sanitizeProfileImage(webp([chunk('VP8X', vp8x(0, 2, 2)), chunk('VP8 ', hugeFrame)]), 'image/webp'), /JPEG, PNG, or WebP/);

const { createRequire } = await import('node:module');
const { fileURLToPath } = await import('node:url');
const puppeteer = createRequire(fileURLToPath(new URL('./node_modules/puppeteer-core/package.json', import.meta.url)))('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const decoded = await page.evaluate(async (url) => {
    const image = new Image();
    const loaded = await new Promise((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => resolve(false);
      image.src = url;
    });
    return { loaded, width: image.naturalWidth, height: image.naturalHeight };
  }, 'data:image/jpeg;base64,' + stripped.bytes.toString('base64'));
  assert.equal(decoded.loaded, true);
  assert.equal(decoded.width, 2);
  assert.equal(decoded.height, 2);
} finally {
  await browser.close();
}
console.log('profile image tests passed');
