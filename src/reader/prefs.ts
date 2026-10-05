import { db } from '../lib/db';
import literata from '@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url';
import literataItalic from '@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url';
import literataExt from '@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url';
import inter from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import interItalic from '@fontsource-variable/inter/files/inter-latin-wght-italic.woff2?url';
import interExt from '@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url';

/** How the reader looks; one set for every book, remembered between launches. */
export type Prefs = {
  theme: 'paper' | 'sepia' | 'night' | 'black';
  font: 'original' | 'literata' | 'inter' | 'serif' | 'sans';
  size: number; // percent
  spacing: number; // line height
  margin: number; // 0 narrow · 1 normal · 2 wide
  flow: 'paginated' | 'scrolled';
  justify: boolean;
  /** Fixed-layout books (PDF, comics). */
  zoom: 'fit-page' | 'fit-width';
  darkPages: boolean;
  volumeKeys: boolean;
};

export const DEFAULT_PREFS: Prefs = {
  theme: 'paper',
  font: 'original',
  size: 100,
  spacing: 1.5,
  margin: 1,
  flow: 'paginated',
  justify: true,
  zoom: 'fit-page',
  darkPages: true,
  volumeKeys: true,
};

export const THEMES: Record<Prefs['theme'], { label: string; bg: string; fg: string; muted: string; link: string; dark: boolean }> = {
  paper: { label: 'Paper', bg: '#f8f5ee', fg: '#26231e', muted: '#7d766a', link: '#2a5db0', dark: false },
  sepia: { label: 'Sepia', bg: '#efe2c8', fg: '#3b2f1e', muted: '#7f6a4c', link: '#8a4b14', dark: false },
  night: { label: 'Night', bg: '#1d1f26', fg: '#d5d3cc', muted: '#8a8e9a', link: '#8fb4ff', dark: true },
  black: { label: 'Black', bg: '#000000', fg: '#bdbbb5', muted: '#77777a', link: '#8fb4ff', dark: true },
};

export const FONTS: Record<Prefs['font'], { label: string; stack: string }> = {
  original: { label: 'Book', stack: '' },
  literata: { label: 'Literata', stack: '"Glossa Literata", Georgia, serif' },
  inter: { label: 'Inter', stack: '"Glossa Inter", system-ui, sans-serif' },
  serif: { label: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
  sans: { label: 'Sans', stack: 'system-ui, Roboto, "Segoe UI", sans-serif' },
};

export async function loadPrefs(): Promise<Prefs> {
  return { ...DEFAULT_PREFS, ...((await db.get<Partial<Prefs>>('prefs')) ?? {}) };
}

export const savePrefs = (p: Prefs) => db.set('prefs', p);

const abs = (u: string) => new URL(u, document.baseURI).href;

/** The stylesheet put into every page of a reflowable book. */
export function bookCSS(p: Prefs) {
  const t = THEMES[p.theme];
  const font = FONTS[p.font].stack;
  return `
@namespace epub "http://www.idpf.org/2007/ops";
@font-face { font-family: "Glossa Literata"; font-weight: 200 900; src: url("${abs(literata)}") format("woff2"); }
@font-face { font-family: "Glossa Literata"; font-weight: 200 900; src: url("${abs(literataExt)}") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Glossa Literata"; font-style: italic; font-weight: 200 900; src: url("${abs(literataItalic)}") format("woff2"); }
@font-face { font-family: "Glossa Inter"; font-weight: 100 900; src: url("${abs(inter)}") format("woff2"); }
@font-face { font-family: "Glossa Inter"; font-weight: 100 900; src: url("${abs(interExt)}") format("woff2"); unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+2020, U+20A0-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF; }
@font-face { font-family: "Glossa Inter"; font-style: italic; font-weight: 100 900; src: url("${abs(interItalic)}") format("woff2"); }

html {
  color-scheme: ${t.dark ? 'dark' : 'light'};
  background: ${t.bg} !important;
  color: ${t.fg} !important;
  font-size: ${p.size}% !important;
  -webkit-text-size-adjust: none;
  -webkit-tap-highlight-color: transparent;
  -webkit-touch-callout: none;
}
body { background: transparent !important; color: inherit !important; }
body *:not(img):not(svg):not(svg *):not(video) {
  color: inherit !important;
  background-color: transparent !important;
  border-color: color-mix(in srgb, currentColor 30%, transparent) !important;
}
a:link, a:visited, a * { color: ${t.link} !important; }
${font ? `body, p, div, span, li, blockquote, dd, dt, td, th, h1, h2, h3, h4, h5, h6, a, em, i, b, strong, cite, small, sup, sub, label { font-family: ${font} !important; }` : ''}
p, li, blockquote, dd, div {
  line-height: ${p.spacing} !important;
}
p, li, blockquote, dd {
  text-align: ${p.justify ? 'justify' : 'start'};
  -webkit-hyphens: auto;
  hyphens: auto;
  hanging-punctuation: allow-end last;
  widows: 2;
  orphans: 2;
}
pre { white-space: pre-wrap !important; }
img, svg, video { max-width: 100%; height: auto; object-fit: contain; }
${t.dark ? 'img { filter: brightness(0.88); }' : ''}
aside[epub|type~="endnote"], aside[epub|type~="footnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
::selection { background: color-mix(in srgb, ${t.link} 30%, transparent); }
`;
}

/** Margin attribute for the paginator, in px, from the 0–2 setting. */
export const marginPx = (p: Prefs) => [12, 32, 56][p.margin] ?? 32;
export const gapPct = (p: Prefs) => [4, 6, 10][p.margin] ?? 6;
