// Recognise a picture by its first bytes, not by the name it arrives with: a note only accepts
// PNG, JPEG, GIF and WebP (never SVG, which can carry script).
const starts = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);

export function rasterExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (starts(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (starts(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (starts(buf, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (starts(buf, [0x52, 0x49, 0x46, 0x46]) && starts(buf, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

export const isRasterImage = (buf) => rasterExt(buf) !== null;
