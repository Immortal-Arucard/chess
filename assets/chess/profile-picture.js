const MAX_BYTES = 512 * 1024;
const MAX_EDGE = 1600;

export function sniffImage(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (view.length >= 3 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff) return 'image/jpeg';
  if (view.length >= 8 && view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4e && view[3] === 0x47) return 'image/png';
  if (view.length >= 12 && view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 && view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) return 'image/webp';
  return '';
}

function blobOf(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('This photo could not be read. Choose a JPEG, PNG, or WebP.'));
      else resolve(blob);
    }, 'image/jpeg', quality);
  });
}

export async function prepareProfileImage(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const sniffed = sniffImage(raw);
  if (!sniffed) throw new Error('This photo could not be read. Choose a JPEG, PNG, or WebP.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([raw], { type: sniffed }), { imageOrientation: 'from-image' });
  } catch (err) {
    throw new Error('This photo could not be read. Choose a JPEG, PNG, or WebP.');
  }
  const oversized = bitmap.width > MAX_EDGE || bitmap.height > MAX_EDGE || raw.byteLength > MAX_BYTES;
  if (!oversized && sniffed !== 'image/jpeg') {
    if (bitmap.close) bitmap.close();
    return { bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), type: sniffed };
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
