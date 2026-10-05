import type { Format } from './db';

/**
 * Opening any supported file as a foliate-js "book". foliate-js handles the
 * real ebook formats (EPUB, MOBI/AZW3, FB2, CBZ, PDF); plain text, Markdown
 * and HTML get a small adapter here so they read like any other book.
 *
 * foliate-js is served as-is from /foliate-js (it resolves its own vendor
 * files relative to itself), so it is imported at runtime, not bundled.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FBook = any;

const base = () => new URL('foliate-js/', document.baseURI).href;
let viewMod: Promise<{ makeBook: (f: File) => Promise<FBook> }> | null = null;
export const loadFoliate = () => (viewMod ??= import(/* @vite-ignore */ base() + 'view.js'));
const loadPDF = () => import(/* @vite-ignore */ base() + 'pdf.js') as Promise<{ makePDF: (f: File, o?: { password?: string }) => Promise<FBook> }>;

export const ACCEPT = [
  '.epub', '.pdf', '.mobi', '.azw', '.azw3', '.kf8', '.prc', '.fb2', '.fbz', '.fb2.zip',
  '.cbz', '.docx', '.txt', '.text', '.md', '.markdown', '.html', '.htm', '.xhtml',
].join(',');

export const FORMAT_LABEL: Record<Format, string> = {
  epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', azw3: 'AZW3', fb2: 'FB2', cbz: 'Comic', txt: 'Text', html: 'HTML', md: 'Markdown', docx: 'Word',
};

export class PasswordError extends Error {}

/** Works out the format from the bytes first and the name second. */
export async function detectFormat(file: Blob, name: string): Promise<Format | null> {
  const n = name.toLowerCase();
  const head = new Uint8Array(await file.slice(0, 68).arrayBuffer());
  const ascii = (a: number, b: number) => String.fromCharCode(...head.slice(a, b));
  if (ascii(0, 5) === '%PDF-') return 'pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    if (/\.cbz$/.test(n)) return 'cbz';
    if (/\.(fbz|fb2\.zip)$/.test(n)) return 'fb2';
    if (/\.epub$/.test(n)) return 'epub';
    if (/\.docx$/.test(n)) return 'docx';
    // An unnamed zip: an EPUB carries its mimetype first.
    const s = new TextDecoder().decode(await file.slice(0, 120).arrayBuffer());
    if (s.includes('application/epub+zip')) return 'epub';
    if (s.includes('[Content_Types].xml') || s.includes('word/')) return 'docx';
    return 'cbz';
  }
  if (ascii(60, 68) === 'BOOKMOBI' || ascii(60, 68) === 'TEXtREAd') return /\.(azw3|kf8|azw)$/.test(n) ? 'azw3' : 'mobi';
  if (/\.fb2$/.test(n)) return 'fb2';
  if (/\.(md|markdown)$/.test(n)) return 'md';
  if (/\.(html?|xhtml)$/.test(n)) return 'html';
  if (/\.(txt|text)$/.test(n)) return 'txt';
  const text = await decodeText(file.slice(0, 4096));
  if (/<FictionBook/i.test(text)) return 'fb2';
  if (/<html[\s>]/i.test(text)) return 'html';
  // Mostly printable? Then it's text.
  const bad = [...text].filter((c) => c < ' ' && c !== '\n' && c !== '\r' && c !== '\t').length;
  return bad < text.length * 0.02 ? 'txt' : null;
}

export async function openBook(blob: Blob, format: Format, password?: string): Promise<FBook> {
  const ext = format === 'azw3' ? 'azw3' : format;
  const file = blob instanceof File ? blob : new File([blob], `book.${ext}`, { type: blob.type });
  if (format === 'txt' || format === 'md' || format === 'html' || format === 'docx') return textBook(file, format);
  if (format === 'pdf') {
    const { makePDF } = await loadPDF();
    try {
      return await makePDF(file, { password });
    } catch (e) {
      if ((e as Error)?.name === 'PasswordException') throw new PasswordError(password ? 'wrong' : 'needed');
      throw e;
    }
  }
  const { makeBook } = await loadFoliate();
  return makeBook(file);
}

/* ------------------------------------------------------------------ text */

export async function decodeText(blob: Blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HEADING = /^(chapter|part|book|volume|section|prologue|epilogue|preface|introduction|act|canto|letter|stave)\b[^\n]{0,70}$|^[IVXLC]{1,7}\.?(\s+[^\n]{0,60})?$/i;

type Section = { title: string; html: string };

function txtSections(text: string): Section[] {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  // Hard-wrapped text (Gutenberg) joins its lines; poetry-like short lines keep breaks.
  const sections: Section[] = [];
  let cur: Section = { title: '', html: '' };
  let count = 0;
  for (const p of paras) {
    const oneLine = !p.includes('\n');
    if (oneLine && p.length < 80 && HEADING.test(p)) {
      if (cur.html) sections.push(cur);
      cur = { title: p, html: `<h2>${esc(p)}</h2>` };
      count = 0;
      continue;
    }
    const lines = p.split('\n');
    const avg = p.length / lines.length;
    const body = avg > 45 ? esc(lines.join(' ')) : lines.map(esc).join('<br>');
    cur.html += `<p>${body}</p>`;
    // Keep sections a sensible size even without chapter headings.
    if (++count > 120 && cur.html.length > 60000) {
      sections.push(cur);
      cur = { title: '', html: '' };
      count = 0;
    }
  }
  if (cur.html) sections.push(cur);
  return sections;
}

function inline(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a ?? b}</strong>`)
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1<em>$2</em>')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function mdSections(text: string): Section[] {
  const sections: Section[] = [];
  let cur: Section = { title: '', html: '' };
  // Fenced code is lifted out first so blank lines inside it survive.
  const fences: string[] = [];
  const src = text.replace(/\r\n?/g, '\n').replace(/^```[^\n]*\n([\s\S]*?)^```\s*$/gm, (_, code: string) => {
    fences.push(code);
    return `\u0000${fences.length - 1}\u0000`;
  });
  for (const block of src.split(/\n\s*\n+/)) {
    const fence = /^\u0000(\d+)\u0000$/.exec(block.trim());
    if (fence) {
      cur.html += `<pre><code>${esc(fences[Number(fence[1])]!.trimEnd())}</code></pre>`;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(block.trim());
    if (h && !block.trim().includes('\n')) {
      const level = h[1]!.length;
      if (level <= 2 && cur.html) {
        sections.push(cur);
        cur = { title: '', html: '' };
      }
      if (level <= 2 && !cur.title) cur.title = h[2]!;
      cur.html += `<h${level}>${inline(h[2]!)}</h${level}>`;
    } else if (/^\s*([-*+]|\d+\.)\s/.test(block)) {
      const ordered = /^\s*\d+\./.test(block);
      const items = block.split(/\n(?=\s*([-*+]|\d+\.)\s)/).filter((x) => x && !/^([-*+]|\d+\.)$/.test(x));
      const tag = ordered ? 'ol' : 'ul';
      cur.html += `<${tag}>${items.map((i) => `<li>${inline(i.replace(/^\s*([-*+]|\d+\.)\s+/, ''))}</li>`).join('')}</${tag}>`;
    } else if (block.startsWith('>')) {
      cur.html += `<blockquote><p>${inline(block.replace(/^>\s?/gm, ''))}</p></blockquote>`;
    } else if (/^(-{3,}|\*{3,})$/.test(block.trim())) {
      cur.html += '<hr>';
    } else {
      cur.html += `<p>${inline(block).replace(/\n/g, ' ')}</p>`;
    }
  }
  if (cur.html) sections.push(cur);
  return sections;
}

/** Word documents, through mammoth: real headings become chapters. */
async function docxHTML(file: File) {
  const mod = (await import('mammoth/mammoth.browser.min.js')) as unknown as { default?: Mammoth } & Mammoth;
  const mammoth = mod.default ?? mod;
  const { value } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
  return value;
}
type Mammoth = { convertToHtml: (i: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };

function htmlSections(html: string): Section[] {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const sections: Section[] = [];
  let cur: Section = { title: '', html: '' };
  for (const node of [...doc.body.childNodes]) {
    const el = node as Element;
    if (el.tagName === 'H1' || el.tagName === 'H2') {
      if (cur.html.replace(/<[^>]+>/g, '').trim()) sections.push(cur);
      cur = { title: el.textContent?.trim() ?? '', html: '' };
    }
    cur.html += el.outerHTML ?? esc(node.textContent ?? '');
  }
  if (cur.html) sections.push(cur);
  return sections;
}

async function textBook(file: File, format: 'txt' | 'md' | 'html' | 'docx'): Promise<FBook> {
  const text = format === 'docx' ? '' : await decodeText(file);
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  let title = name;
  let author = '';
  let sections: Section[];
  if (format === 'docx') {
    sections = htmlSections(await docxHTML(file));
    title = name;
  } else if (format === 'html') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    doc.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove());
    title = doc.title || name;
    author = doc.querySelector('meta[name="author"]')?.getAttribute('content') ?? '';
    sections = [{ title, html: doc.body?.innerHTML ?? '' }];
  } else if (format === 'md') {
    sections = mdSections(text);
    title = sections[0]?.title || name;
  } else {
    // Gutenberg-style headers name the book.
    title = /^Title:\s*(.+)$/m.exec(text)?.[1]?.trim() || name;
    author = /^Author:\s*(.+)$/m.exec(text)?.[1]?.trim() || '';
    sections = txtSections(text);
  }
  if (!sections.length) sections = [{ title, html: '<p></p>' }];

  const css = `body{font-family:Georgia,serif;line-height:1.5;margin:0 4%}h1,h2,h3{line-height:1.2;margin:1.6em 0 .8em}p{margin:0 0 .9em;text-align:justify}pre{white-space:pre-wrap}`;
  const page = (s: Section, i: number) =>
    `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(s.title || `Part ${i + 1}`)}</title><style>${css}</style></head><body>${s.html}</body></html>`;
  const urls = new Map<number, string>();

  return {
    metadata: { title, author, language: document.documentElement.lang || 'en' },
    dir: 'ltr',
    rendition: {},
    toc: sections.map((s, i) => ({ label: s.title || `Part ${i + 1}`, href: `#s${i}` })).filter((_, i) => sections[i]!.title || sections.length < 40),
    sections: sections.map((s, i) => ({
      id: i,
      size: s.html.length,
      linear: 'yes',
      load: () => {
        if (!urls.has(i)) urls.set(i, URL.createObjectURL(new Blob([page(s, i)], { type: 'text/html' })));
        return urls.get(i);
      },
      unload: () => {
        const u = urls.get(i);
        if (u) URL.revokeObjectURL(u);
        urls.delete(i);
      },
      createDocument: () => new DOMParser().parseFromString(page(s, i), 'text/html'),
    })),
    resolveHref: (href: string) => {
      const i = Number(/#s(\d+)/.exec(href)?.[1] ?? 0);
      return { index: i, anchor: (doc: Document) => doc.body };
    },
    splitTOCHref: (href: string) => [Number(/#s(\d+)/.exec(href)?.[1] ?? 0), null],
    getTOCFragment: (doc: Document) => doc.body,
    isExternal: (href: string) => /^\w+:/.test(href),
    getCover: () => null,
  };
}
