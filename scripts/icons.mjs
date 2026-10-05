// Renders the Android launcher icons and splash from public/icon.svg.
// Run with `node scripts/icons.mjs` after changing the icon; the PNGs are committed.
import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'android/app/src/main/res');
const full = readFileSync(join(root, 'public/icon.svg'), 'utf8');

// The artwork without its tile, for the adaptive icon's foreground layer:
// drawn into the middle 60% of a 108dp canvas (the launcher crops to ~66dp).
const art = full.replace(/<rect width="512" height="512"[^>]*\/>/, '');
const foreground = art.replace(
  /<svg([^>]*)viewBox="0 0 512 512">/,
  '<svg$1viewBox="6 -2 500 500">',
);
const round = full.replace('rx="112"', 'rx="256"');

const sizes = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(sizes)) {
  const dir = join(res, `mipmap-${d}`);
  mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(full)).resize(Math.round(48 * k)).png().toFile(join(dir, 'ic_launcher.png'));
  await sharp(Buffer.from(round)).resize(Math.round(48 * k)).png().toFile(join(dir, 'ic_launcher_round.png'));
  await sharp(Buffer.from(foreground)).resize(Math.round(108 * k)).png().toFile(join(dir, 'ic_launcher_foreground.png'));
}
// The splash icon (Android 12+ shows it on the paper-coloured splash).
mkdirSync(join(res, 'drawable'), { recursive: true });
await sharp(Buffer.from(foreground)).resize(432).png().toFile(join(res, 'drawable', 'splash_icon.png'));
console.log('icons written');
