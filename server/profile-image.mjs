export const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_EDGE = 4096;

export function sanitizeProfileImage(input, declaredType) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (bytes.length < 16 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  }
  const sniffed = sniff(bytes);
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (!sniffed || sniffed !== declared) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  if (sniffed === 'image/jpeg') return { type: sniffed, bytes: stripJpeg(bytes) };
  if (sniffed === 'image/png') return { type: sniffed, bytes: stripPng(bytes) };
  return { type: sniffed, bytes: stripWebp(bytes) };
}

function sniff(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

function stripJpeg(bytes) {
  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let sawScan = false;
  let width = 0;
  let height = 0;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    while (i < bytes.length && bytes[i] === 0xff) i += 1;
    if (i >= bytes.length) break;
    const marker = bytes[i];
    i += 1;
    if (marker === 0xd9) {
      out.push(Buffer.from([0xff, 0xd9]));
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 1 >= bytes.length) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    const start = i - 2;
    if (marker === 0xda) {
      sawScan = true;
      let j = i + length;
      while (j + 1 < bytes.length) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
          out.push(bytes.subarray(start, j));
          out.push(Buffer.from([0xff, 0xd9]));
          i = bytes.length;
          break;
        }
        j += 1;
      }
      if (i !== bytes.length) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
      break;
    }
    const keep = !((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe);
    if (keep) out.push(bytes.subarray(start, i + length));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && length >= 7) {
      height = bytes.readUInt16BE(i + 3);
      width = bytes.readUInt16BE(i + 5);
    }
    i += length;
  }
  if (!sawScan || width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) {
    throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  }
  const clean = Buffer.concat(out);
  if (clean.length > MAX_IMAGE_BYTES) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  return clean;
}

function stripPng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS']);
  const parts = [signature];
  let i = 8;
  let sawHeader = false;
  let sawData = false;
  let sawEnd = false;
  while (i + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.toString('ascii', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || i + 12 + length > bytes.length) {
      throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    }
    if (type === 'IHDR') {
      if (length < 8) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
      const width = bytes.readUInt32BE(i + 8);
      const height = bytes.readUInt32BE(i + 12);
      if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) {
        throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
      }
      sawHeader = true;
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') sawEnd = true;
    if (keep.has(type)) parts.push(bytes.subarray(i, i + 12 + length));
    i += 12 + length;
    if (type === 'IEND') break;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  return Buffer.concat(parts);
}

function stripWebp(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  }
  const kept = [];
  let i = 12;
  let width = 0;
  let height = 0;
  while (i + 8 <= bytes.length) {
    const fourcc = bytes.toString('ascii', i, i + 4);
    const size = bytes.readUInt32LE(i + 4);
    const end = i + 8 + size;
    if (end > bytes.length) throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
    if (fourcc === 'VP8X' && size >= 10) {
      const data = Buffer.from(bytes.subarray(i + 8, end));
      data[0] &= ~(0x01 | 0x04 | 0x08);
      width = 1 + data[4] + (data[5] << 8) + (data[6] << 16);
      height = 1 + data[7] + (data[8] << 8) + (data[9] << 16);
      kept.push({ fourcc, data });
    } else if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ALPH') {
      const data = bytes.subarray(i + 8, end);
      if (fourcc === 'VP8 ' && data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      }
      if (fourcc === 'VP8L' && data.length >= 5) {
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >> 14) & 0x3fff) + 1;
      }
      kept.push({ fourcc, data });
    }
    i = end + (size % 2);
  }
  if (!kept.some((chunk) => chunk.fourcc === 'VP8 ' || chunk.fourcc === 'VP8L')) {
    throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  }
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE) {
    throw new Error('Use a JPEG, PNG, or WebP image up to 512 KB.');
  }
  const body = [Buffer.from('WEBP')];
  for (const chunk of kept) {
    const header = Buffer.alloc(8);
    header.write(chunk.fourcc, 0, 'ascii');
    header.writeUInt32LE(chunk.data.length, 4);
    body.push(header, chunk.data);
    if (chunk.data.length % 2) body.push(Buffer.from([0]));
  }
  const payload = Buffer.concat(body);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}
