import assert from 'node:assert/strict';
import { HEADER_SCAN_CAP, SOURCE_BYTE_CAP, inspectProfileImage, jpegDimensions, pngDimensions, webpDimensions } from './profile-picture.js';

function trackedFile(bytes, size = bytes.length) {
  const calls = { slice: 0, full: 0 };
  return {
    calls,
    size,
    slice(start, end) {
      calls.slice += 1;
      const view = bytes.subarray(start, end == null ? bytes.length : Math.min(end, bytes.length));
      return { arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) };
    },
    arrayBuffer() {
      calls.full += 1;
      return Promise.reject(new Error('full read'));
    }
  };
}

function png(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function jpeg(width, height) {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 11, 8], 0);
  bytes[7] = height >> 8;
  bytes[8] = height & 255;
  bytes[9] = width >> 8;
  bytes[10] = width & 255;
  bytes[11] = 1;
  return bytes;
}

function webp(width, height) {
  const data = new Uint8Array(10);
  const view = new DataView(data.buffer);
  view.setUint8(4, (width - 1) & 255);
  view.setUint8(5, ((width - 1) >> 8) & 255);
  view.setUint8(6, ((width - 1) >> 16) & 255);
  view.setUint8(7, (height - 1) & 255);
  view.setUint8(8, ((height - 1) >> 8) & 255);
  view.setUint8(9, ((height - 1) >> 16) & 255);
  const chunk = new Uint8Array(18);
  chunk.set([86, 80, 56, 88], 0);
  new DataView(chunk.buffer).setUint32(4, 10, true);
  chunk.set(data, 8);
  const payload = new Uint8Array(4 + chunk.length);
  payload.set([87, 69, 66, 80]);
  payload.set(chunk, 4);
  const out = new Uint8Array(8 + payload.length);
  out.set([82, 73, 70, 70]);
  new DataView(out.buffer).setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}

const phone = await inspectProfileImage(trackedFile(jpeg(4032, 3024)));
assert.deepEqual(phone, { type: 'image/jpeg', width: 4032, height: 3024 });
const dense = await inspectProfileImage(trackedFile(jpeg(8064, 6048)));
assert.equal(dense.width * dense.height < 50000000, true);
const edge = await inspectProfileImage(trackedFile(jpeg(9000, 10)));
assert.equal(edge.width, 9000);
const pixels = await inspectProfileImage(trackedFile(png(8000, 6250)));
assert.equal(pixels.width * pixels.height, 50000000);
const atCap = trackedFile(jpeg(4032, 3024), SOURCE_BYTE_CAP);
assert.equal((await inspectProfileImage(atCap)).width, 4032);
assert.equal(atCap.calls.full, 0);
assert.equal(atCap.calls.slice, 1);
await assert.rejects(() => inspectProfileImage(trackedFile(png(8000, 6251))), /too large to open/);

const tooManyBytes = trackedFile(new Uint8Array(16), SOURCE_BYTE_CAP + 1);
await assert.rejects(() => inspectProfileImage(tooManyBytes), /under 40 MB/);
assert.equal(tooManyBytes.calls.slice, 0);
assert.equal(tooManyBytes.calls.full, 0);

const bomb = trackedFile(png(65535, 65535));
await assert.rejects(() => inspectProfileImage(bomb), /too large to open/);
assert.equal(bomb.calls.full, 0);
assert.equal(bomb.calls.slice, 1);

const wide = trackedFile(jpeg(9001, 10));
await assert.rejects(() => inspectProfileImage(wide), /too large to open/);
assert.equal(wide.calls.full, 0);

const canvasBomb = trackedFile(webp(20000, 20));
await assert.rejects(() => inspectProfileImage(canvasBomb), /too large to open/);
assert.equal(canvasBomb.calls.full, 0);

const truncatedFrame = webp(4032, 3024);
const claimed = new Uint8Array(truncatedFrame.length);
claimed.set(truncatedFrame);
new DataView(claimed.buffer).setUint32(truncatedFrame.length - 14, 5000000, true);
const phoneHeader = trackedFile(claimed, 8 * 1024 * 1024);
const opened = await inspectProfileImage(phoneHeader);
assert.deepEqual(opened, { type: 'image/webp', width: 4032, height: 3024 });
assert.equal(phoneHeader.calls.full, 0);

await assert.rejects(() => inspectProfileImage(trackedFile(new Uint8Array([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))), /could not be read/);
await assert.rejects(() => inspectProfileImage(trackedFile(new Uint8Array(32).fill(1))), /could not be read/);
await assert.rejects(() => inspectProfileImage(trackedFile(png(0, 12).fill(0, 0, 8))), /could not be read/);
assert.equal(pngDimensions(png(1, 1)).width, 1);
assert.equal(jpegDimensions(new Uint8Array([0xff, 0xd8])).incomplete || jpegDimensions(new Uint8Array([0xff, 0xd8])).error, true);
assert.equal(webpDimensions(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])).incomplete, true);
assert.ok(HEADER_SCAN_CAP < SOURCE_BYTE_CAP);
console.log('profile picture guard tests passed');
