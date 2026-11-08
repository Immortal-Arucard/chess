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
console.log('profile image tests passed');
