export const SOURCE_BYTE_CAP = 40 * 1024 * 1024;
export const HEADER_SCAN_CAP = 2 * 1024 * 1024;
export const MAX_SOURCE_EDGE = 9000;
export const MAX_SOURCE_PIXELS = 50000000;
const MAX_BYTES = 512 * 1024;
const MAX_EDGE = 1600;

const UNREADABLE = 'This photo could not be read. Choose a JPEG, PNG, or WebP.';
const TOO_LARGE = 'That photo is too large to open.';
const TOO_MANY_BYTES = 'That photo is too large to open. Choose one under 40 MB.';

export function sniffImage(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return 'image/jpeg';
  if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) return 'image/png';
  if (view.length >= 12 && view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) return 'image/webp';
  return '';
}

function u16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u32(bytes, offset) {
  return ((bytes[offset] * 16777216) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}

function u32le(bytes, offset) {
  return (bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + (bytes[offset + 3] * 16777216)) >>> 0;
}

export function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { error: true };
  let i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) return { error: true };
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) return { incomplete: true };
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9 || marker === 0xda) return { error: true };
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= bytes.length) return { incomplete: true };
    const length = u16(bytes, i);
    if (length < 2) return { error: true };
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 6 >= bytes.length) return { incomplete: true };
      const height = u16(bytes, i + 3);
      const width = u16(bytes, i + 5);
      if (width < 1 || height < 1) return { error: true };
      return { width, height };
    }
    if (i + length > bytes.length) return { incomplete: true };
    i += length;
  }
  return { incomplete: true };
}

export function pngDimensions(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8) return { incomplete: true };
  for (let index = 0; index < 8; index += 1) if (bytes[index] !== signature[index]) return { error: true };
  if (bytes.length < 24) return { incomplete: true };
  if (String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== 'IHDR') return { error: true };
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  if (width < 1 || height < 1) return { error: true };
  return { width, height };
}

export function webpDimensions(bytes) {
  if (bytes.length < 12) return { incomplete: true };
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return { error: true };
  let i = 12;
  let canvas = null;
  let bitstream = null;
  while (i + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
    const size = u32le(bytes, i + 4);
    if (size > 0x7fffffff) return { error: true };
    const available = Math.min(size, bytes.length - (i + 8));
    if (fourcc === 'VP8X' && available >= 10) {
      canvas = {
        width: 1 + bytes[i + 12] + (bytes[i + 13] << 8) + (bytes[i + 14] << 16),
        height: 1 + bytes[i + 15] + (bytes[i + 16] << 8) + (bytes[i + 17] << 16)
      };
    } else if (fourcc === 'VP8 ' && available >= 10 && bytes[i + 11] === 0x9d && bytes[i + 12] === 0x01 && bytes[i + 13] === 0x2a) {
      bitstream = {
        width: bytes[i + 14] | ((bytes[i + 15] & 0x3f) << 8),
        height: bytes[i + 16] | ((bytes[i + 17] & 0x3f) << 8)
      };
    } else if (fourcc === 'VP8L' && available >= 5 && bytes[i + 8] === 0x2f) {
      const bits = u32le(bytes, i + 9);
      bitstream = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    const end = i + 8 + size + (size % 2);
    if (end > bytes.length) break;
    i = end;
  }
  if (canvas && bitstream) {
    return {
      width: Math.max(canvas.width, bitstream.width),
      height: Math.max(canvas.height, bitstream.height)
    };
  }
  return canvas || bitstream || { incomplete: true };
}

function dimensionsFor(type, bytes) {
  if (type === 'image/jpeg') return jpegDimensions(bytes);
  if (type === 'image/png') return pngDimensions(bytes);
  return webpDimensions(bytes);
}

export async function inspectProfileImage(file) {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) || file.size < 16) {
    throw new Error(UNREADABLE);
  }
  if (file.size > SOURCE_BYTE_CAP) throw new Error(TOO_MANY_BYTES);
  const length = Math.min(file.size, HEADER_SCAN_CAP);
  const prefix = new Uint8Array(await file.slice(0, length).arrayBuffer());
  const type = sniffImage(prefix);
  if (!type) throw new Error(UNREADABLE);
  const dims = dimensionsFor(type, prefix);
  if (!dims || dims.error || dims.incomplete || dims.width < 1 || dims.height < 1) throw new Error(UNREADABLE);
  if (dims.width > MAX_SOURCE_EDGE || dims.height > MAX_SOURCE_EDGE || dims.width * dims.height > MAX_SOURCE_PIXELS) {
    throw new Error(TOO_LARGE);
  }
  return { type, width: dims.width, height: dims.height };
}

function blobOf(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error(UNREADABLE));
      else resolve(blob);
    }, 'image/jpeg', quality);
  });
}

export async function prepareProfileImage(file) {
  const inspected = await inspectProfileImage(file);
  const raw = new Uint8Array(await file.arrayBuffer());
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([raw], { type: inspected.type }), { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error(UNREADABLE);
  }
  const oversized = bitmap.width > MAX_EDGE || bitmap.height > MAX_EDGE || raw.byteLength > MAX_BYTES;
  if (!oversized && inspected.type !== 'image/jpeg') {
    if (bitmap.close) bitmap.close();
    return { bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), type: inspected.type };
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();
  let quality = 0.86;
  let encoded = await blobOf(canvas, quality);
  while (encoded.size > MAX_BYTES && quality > 0.45) {
    quality -= 0.1;
    encoded = await blobOf(canvas, quality);
  }
  if (encoded.size > MAX_BYTES) throw new Error('That image is still too large to save.');
  return { bytes: await encoded.arrayBuffer(), type: 'image/jpeg' };
}
