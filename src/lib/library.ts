import { db, type BookRecord, type Format } from './db';
import { detectFormat, openBook, PasswordError, type FBook } from './formats';

/**
 * Adding a book: work out its format, read the title, author and cover,
 * pick a spine colour from the cover, and store record + file. Duplicates
 * (same bytes) are recognised and simply resurfaced.
 */

export type ImportResult = { book?: BookRecord; error?: string; name: string; duplicate?: boolean };

async function fingerprint(file: Blob) {
  const head = await file.slice(0, 1 << 20).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - (1 << 16))).arrayBuffer();
  const data = new Uint8Array(head.byteLength + tail.byteLength + 8);
  data.set(new Uint8Array(head), 0);
  data.set(new Uint8Array(tail), head.byteLength);
  new DataView(data.buffer).setFloat64(head.byteLength + tail.byteLength, file.size);
  try {
    const hash = await crypto.subtle.digest('SHA-1', data);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  } catch {
    // No SubtleCrypto (insecure context): a quick FNV-1a will do.
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 7) h = Math.imul(h ^ data[i]!, 16777619);
    return `f${(h >>> 0).toString(16)}${file.size.toString(16)}`;
  }
}

const str = (v: unknown): string => {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('name' in o) return str(o.name);
    const first = Object.values(o)[0];
    return str(first);
  }
  return String(v);
};

type Described = Omit<BookRecord, 'id' | 'size' | 'addedAt'>;

/** Format, title, author, cover and spine colour of a file. */
async function describe(file: File): Promise<Described | null> {
  const name = file.name;
  const format = await detectFormat(file, name);
  if (!format) return null;
  let fbook: FBook | null = null;
  try {
    fbook = await openBook(file, format);
  } catch (e) {
    // A locked PDF still goes on the shelf; the password is asked on opening.
    if (!(e instanceof PasswordError)) throw e;
  }
  const meta = fbook?.metadata ?? {};
  const fallbackTitle = name.replace(/\.(fb2\.zip|[^.]+)$/i, '').replace(/[_]+/g, ' ').trim();
  const title = str(meta.title).trim() || fallbackTitle;
  const author = str(meta.author ?? meta.creator).trim();

  let cover: Blob | undefined;
  let color = colorFromText(title + author);
  try {
    const raw: Blob | null = await fbook?.getCover?.();
    if (raw && raw.size) {
      const thumb = await thumbnail(raw);
      if (thumb) {
        cover = thumb.blob;
        color = thumb.color;
      }
    }
  } catch {
    /* a book without a readable cover gets a painted one */
  }
  fbook?.destroy?.();
  return { title, author, format, cover, color };
}

export async function importFile(file: File): Promise<ImportResult> {
  const name = file.name;
  try {
    const id = await fingerprint(file);
    const existing = await db.book(id);
    if (existing) return { name, book: existing, duplicate: true };
    const d = await describe(file);
    if (!d) return { name, error: 'Not a book format Glossa can read' };
    const book: BookRecord = { id, size: file.size, addedAt: Date.now(), ...d };
    await db.putFile(id, file);
    await db.putBook(book);
    return { name, book };
  } catch (e) {
    console.error(e);
    return { name, error: 'This file could not be opened' };
  }
}

/** The library id of a file found on the device: stable for its path. */
export function pathId(path: string) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `p${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}

const EXT_FORMAT: Record<string, Format> = {
  epub: 'epub', pdf: 'pdf', mobi: 'mobi', prc: 'mobi', azw: 'azw3', azw3: 'azw3', kf8: 'azw3', fb2: 'fb2', fbz: 'fb2', cbz: 'cbz', docx: 'docx',
};

/**
 * Adds a book found by a device scan; it stays where it is. `file` is null
 * for very large files, which are listed by name rather than read whole.
 */
export async function importPath(f: { path: string; name: string; size: number; modified: number }, file: File | null): Promise<ImportResult> {
  try {
    const ext = f.name.split('.').pop()!.toLowerCase();
    const title = f.name.replace(/\.(fb2\.zip|[^.]+)$/i, '').replace(/[_]+/g, ' ').trim();
    const d = file
      ? await describe(file)
      : EXT_FORMAT[ext]
        ? { title, author: '', format: EXT_FORMAT[ext]!, color: colorFromText(title) }
        : null;
    if (!d) return { name: f.name, error: 'Not a book format Glossa can read' };
    const book: BookRecord = { id: pathId(f.path), size: f.size, addedAt: f.modified || Date.now(), path: f.path, ...d };
    await db.putBook(book);
    return { name: f.name, book };
  } catch (e) {
    console.warn('scan import failed', f.path, e);
    return { name: f.name, error: 'This file could not be opened' };
  }
}

/** A 360px JPEG of the cover, and the colour its spine should be. */
async function thumbnail(blob: Blob): Promise<{ blob: Blob; color: string } | null> {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return null;
  const w = Math.min(360, bmp.width);
  const h = Math.round((bmp.height / bmp.width) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const color = dominant(ctx, w, h);
  const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.82));
  return out ? { blob: out, color } : null;
}

/**
 * The cover's most characteristic colour: a hue histogram weighted towards
 * saturated, mid-light pixels, so a cover's accent beats its white margin.
 */
function dominant(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const { data } = ctx.getImageData(0, 0, w, h);
  const bins = new Array(36).fill(0).map(() => ({ wgt: 0, r: 0, g: 0, b: 0 }));
  let gray = { wgt: 0, l: 0 };
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 510;
    const s = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
    if (s < 0.18 || l < 0.08 || l > 0.94) {
      gray.wgt++;
      gray.l += l;
      continue;
    }
    let hue = 0;
    if (max === r) hue = ((g - b) / (max - min)) % 6;
    else if (max === g) hue = (b - r) / (max - min) + 2;
    else hue = (r - g) / (max - min) + 4;
    hue = (hue * 60 + 360) % 360;
    const wgt = s * (1 - Math.abs(l - 0.5) * 1.4);
    const bin = bins[Math.floor(hue / 10)]!;
    bin.wgt += wgt;
    bin.r += r * wgt;
    bin.g += g * wgt;
    bin.b += b * wgt;
  }
  const best = bins.reduce((a, b) => (b.wgt > a.wgt ? b : a));
  const samples = data.length / 16;
  if (best.wgt < samples * 0.02) {
    // A monochrome cover: a deep ink, a little warm.
    const l = gray.wgt ? gray.l / gray.wgt : 0.3;
    return l > 0.6 ? '#4a4e5a' : '#2f3340';
  }
  const hex = (v: number) => Math.round(v / best.wgt).toString(16).padStart(2, '0');
  return deepen(`#${hex(best.r)}${hex(best.g)}${hex(best.b)}`);
}

/** Keep spine colours rich enough to carry white type. */
function deepen(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > 150) {
    const k = 150 / lum;
    r *= k;
    g *= k;
    b *= k;
  }
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

const PALETTE = ['#3d5a80', '#7a3e48', '#2f6f62', '#8a5a2b', '#5b4b8a', '#2e5e8c', '#7c4f6e', '#4f6b3a', '#9b4a32', '#36536b'];

export function colorFromText(s: string) {
  let h = 0;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761);
  return PALETTE[(h >>> 0) % PALETTE.length]!;
}

/** The welcome book, so a first launch has something on the shelf. */
export async function seedSample() {
  if (await db.get('seeded')) return;
  await db.set('seeded', true);
  try {
    const res = await fetch(new URL('samples/alice.epub', document.baseURI));
    if (!res.ok) return;
    const blob = await res.blob();
    await importFile(new File([blob], 'alice.epub', { type: 'application/epub+zip' }));
  } catch {
    /* offline first run without the sample is fine */
  }
}

export type { Format };
