import { lookup, type Entry } from '../dict/dictionary';
import { native } from '../lib/native';
import { Sheet, toast } from '../ui/sheet';
import { icon } from '../ui/icons';

/**
 * Press and hold a word: it lights up, the phone ticks, and its meaning
 * slides up from the bottom, in the app. Keep holding and drag to select a
 * passage instead; let go and you can highlight or copy it.
 *
 * The system's own long-press selection is switched off inside books so it
 * can't fight with this (that is what breaks most readers' dictionaries).
 */

export type LookupHost = {
  /** Language of the book, for word breaking and online lookups. */
  lang: () => string;
  canHighlight: () => boolean;
  onHighlight: (range: Range, color: string) => void;
  /** True while a press shouldn't count as a tap. */
  suppressTap: (ms: number) => void;
  /** The visible page, in screen coordinates. */
  bounds: () => DOMRect;
};

const HOLD_MS = 520;
const SLOP = 8;
export const COLORS = { yellow: '#f6d365', green: '#9be2a8', blue: '#9cc7ff', pink: '#ffa9c6' } as const;

export class Lookup {
  private host: LookupHost;
  private marks: HTMLElement;
  private sheet: Sheet | null = null;
  private bar: HTMLElement | null = null;
  private range: Range | null = null;
  private seq = 0;

  constructor(host: LookupHost) {
    this.host = host;
    this.marks = document.createElement('div');
    this.marks.className = 'marks';
    document.body.append(this.marks);
  }

  destroy() {
    this.dismiss();
    this.marks.remove();
  }

  /** Wires up one page of the book as it loads. */
  attach(doc: Document) {
    const win = doc.defaultView!;
    let timer = 0;
    // Where the finger went down, on screen, and where the page was then:
    // if either moves before the hold completes, it was a swipe, not a hold.
    let start: { sx: number; sy: number; fx: number; fy: number } | null = null;
    let anchor: Range | null = null;
    let active = false;
    const framePos = () => {
      const r = (win.frameElement as HTMLElement | null)?.getBoundingClientRect();
      return { fx: r?.left ?? 0, fy: r?.top ?? 0 };
    };

    const cancel = () => {
      clearTimeout(timer);
      start = null;
    };

    const begin = (x: number, y: number, sx: number, sy: number) => {
      cancel();
      start = { sx, sy, ...framePos() };
      timer = win.setTimeout(() => {
        const s0 = start;
        start = null;
        const now = framePos();
        if (!s0 || Math.abs(now.fx - s0.fx) > 2 || Math.abs(now.fy - s0.fy) > 2) return;
        const word = wordAt(doc, x, y, this.host.lang());
        if (!word) return;
        active = true;
        anchor = word;
        this.range = word;
        this.host.suppressTap(700);
        void native.tick();
        this.paint(word);
        this.define(word.toString(), word);
      }, HOLD_MS);
    };

    const drag = (x: number, y: number, e: Event, sx?: number, sy?: number) => {
      if (active && anchor) {
        e.preventDefault();
        e.stopImmediatePropagation();
        // Keep the point on the visible page (a paginated section runs on
        // off-screen to the side).
        const frame = win.frameElement as HTMLElement | null;
        if (frame) {
          const fr = frame.getBoundingClientRect();
          const s = fr.width / (frame.offsetWidth || fr.width);
          const b = this.host.bounds();
          x = (Math.min(Math.max(fr.left + x * s, b.left + 2), b.right - 2) - fr.left) / s;
          y = (Math.min(Math.max(fr.top + y * s, b.top + 2), b.bottom - 2) - fr.top) / s;
        }
        const here = wordAt(doc, x, y, this.host.lang(), true);
        if (!here) return;
        const r = doc.createRange();
        if (here.compareBoundaryPoints(Range.START_TO_START, anchor) < 0) {
          r.setStart(here.startContainer, here.startOffset);
          r.setEnd(anchor.endContainer, anchor.endOffset);
        } else {
          r.setStart(anchor.startContainer, anchor.startOffset);
          r.setEnd(here.endContainer, here.endOffset);
        }
        if (r.toString() !== this.range?.toString()) {
          this.range = r;
          this.paint(r);
          if (this.sheet?.isOpen && r.toString().trim() !== anchor.toString().trim()) this.sheet.close();
        }
        return;
      }
      if (start && sx != null && sy != null && Math.hypot(sx - start.sx, sy - start.sy) > SLOP) cancel();
    };

    const end = (e: Event) => {
      cancel();
      if (!active) return;
      active = false;
      e.preventDefault();
      this.host.suppressTap(500);
      const r = this.range;
      if (r && anchor && r.toString().trim() !== anchor.toString().trim()) this.selectionBar(r);
      anchor = null;
    };

    // Touch: registered on the window in the capture phase so a drag-select
    // can stop the page from turning underneath it.
    win.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length !== 1) return cancel();
        const t = e.touches[0]!;
        begin(t.clientX, t.clientY, t.screenX, t.screenY);
      },
      { capture: true, passive: true },
    );
    win.addEventListener(
      'touchmove',
      (e) => {
        const t = e.touches[0];
        if (t) drag(t.clientX, t.clientY, e, t.screenX, t.screenY);
      },
      { capture: true, passive: false },
    );
    win.addEventListener('touchend', end, { capture: true, passive: false });
    win.addEventListener('touchcancel', () => {
      cancel();
      active = false;
    }, { capture: true });

    // Mouse: the same press-and-hold, plus double-click.
    doc.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
      begin(e.clientX, e.clientY, e.screenX, e.screenY);
    });
    doc.addEventListener('mousemove', (e) => (e.buttons & 1 ? drag(e.clientX, e.clientY, e, e.screenX, e.screenY) : undefined));
    doc.addEventListener('mouseup', (e) => end(e));
    doc.addEventListener('dblclick', (e) => {
      const word = wordAt(doc, e.clientX, e.clientY, this.host.lang());
      if (!word) return;
      this.range = word;
      this.paint(word);
      this.define(word.toString(), word);
    });

    // No native selection or context menu inside the book: Android's own
    // long-press selection would fight both page swipes and this lookup.
    doc.documentElement.style.setProperty('-webkit-user-select', 'none', 'important');
    doc.documentElement.style.setProperty('user-select', 'none', 'important');
    doc.documentElement.style.setProperty('-webkit-touch-callout', 'none', 'important');
    doc.addEventListener('selectstart', (e) => e.preventDefault());
    doc.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Clears the lit word and any panel. */
  dismiss() {
    this.marks.replaceChildren();
    this.range = null;
    this.bar?.remove();
    this.bar = null;
    this.sheet?.close();
  }

  /** Re-places the lit word after the page moved (rotation, resize). */
  repaint() {
    if (this.range) this.paint(this.range);
  }

  private paint(range: Range) {
    const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
    if (!frame) return;
    const fr = frame.getBoundingClientRect();
    const sx = fr.width / (frame.offsetWidth || fr.width);
    const sy = fr.height / (frame.offsetHeight || fr.height);
    const frag = document.createDocumentFragment();
    const b = this.host.bounds();
    for (const r of mergeRects(textRects(range))) {
      const cx = fr.left + (r.left + r.width / 2) * sx;
      if (cx < b.left || cx > b.right) continue;
      const d = document.createElement('div');
      d.className = 'mark';
      d.style.transform = `translate(${fr.left + r.left * sx - 2}px, ${fr.top + r.top * sy - 1}px)`;
      d.style.width = `${r.width * sx + 4}px`;
      d.style.height = `${r.height * sy + 2}px`;
      frag.append(d);
    }
    this.marks.replaceChildren(frag);
  }

  private anchorRect(range: Range) {
    const frame = range.startContainer.ownerDocument?.defaultView?.frameElement as HTMLElement | null;
    const r = range.getBoundingClientRect();
    if (!frame) return r;
    const fr = frame.getBoundingClientRect();
    const sx = fr.width / (frame.offsetWidth || fr.width);
    return new DOMRect(fr.left + r.left * sx, fr.top + r.top * sx, r.width * sx, r.height * sx);
  }

  /* --------------------------------------------------------------- define */

  async define(raw: string, range?: Range) {
    const word = raw.trim();
    if (!word) return;
    const id = ++this.seq;
    this.bar?.remove();
    this.bar = null;
    if (!this.sheet) {
      this.sheet = new Sheet({
        className: 'sheet--define',
        modeless: true,
        onClose: () => {
          this.marks.replaceChildren();
          this.range = null;
        },
      });
      this.sheet.body.addEventListener('click', (e) => this.onSheetClick(e));
    }
    const s = this.sheet;
    // Out of the word's way: at the top when the word is low on the screen.
    const rect = range ? this.anchorRect(range) : null;
    const top = !!rect && rect.top > innerHeight * 0.52;
    s.body.innerHTML = `<div class="define"><div class="define__head"><h2 class="define__word"></h2></div><div class="define__loading"><span></span><span></span><span></span></div></div>`;
    s.body.querySelector('.define__word')!.textContent = word;
    s.open(top);
    s.body.scrollTop = 0;

    const entry = await lookup(word, this.host.lang()).catch(() => null);
    if (id !== this.seq || !s.isOpen) return;
    s.body.innerHTML = this.render(word, entry);
  }

  private render(word: string, entry: Entry | null) {
    const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const canHL = this.host.canHighlight() && !!this.range;
    const actions = `<div class="define__actions">
      ${canHL ? `<button class="chip" data-act="hl">${icon('highlight')}Highlight</button>` : ''}
      <button class="chip" data-act="copy">${icon('copy')}Copy</button>
    </div>`;
    if (!entry) {
      const offline = !navigator.onLine;
      return `<div class="define">
        <div class="define__head"><h2 class="define__word">${esc(word)}</h2></div>
        <p class="define__empty">${offline
          ? 'Not in the offline dictionary. Connect to the internet to look it up on Wiktionary and Wikipedia — right here, without leaving the book.'
          : 'No definition found for this word.'}</p>
        ${actions}</div>`;
    }
    const block = (e: Entry, open: boolean) =>
      e.groups
        .map(
          (g) => `<section class="define__group">
          <h3 class="define__pos">${esc(g.pos)}</h3>
          <ol class="define__senses">${g.senses
            .map(
              (s, i) => `<li class="${i >= 3 && !open ? 'is-extra' : ''}">
                <p class="define__gloss">${esc(s.gloss)}</p>
                ${s.examples.length ? `<p class="define__ex">“${esc(s.examples[0]!)}”</p>` : ''}
                ${s.synonyms.length ? `<p class="define__syn">${s.synonyms.map((w) => `<button data-word="${esc(w)}">${esc(w)}</button>`).join('')}</p>` : ''}
              </li>`,
            )
            .join('')}</ol>
          ${g.senses.length > 3 && !open ? `<button class="define__more" data-act="more">${g.senses.length - 3} more</button>` : ''}
        </section>`,
        )
        .join('');
    const lemma = entry.lemma.toLowerCase() !== word.toLowerCase() ? `<span class="define__lemma">from <b>${esc(entry.lemma)}</b></span>` : '';
    return `<div class="define">
      <div class="define__head"><h2 class="define__word">${esc(word)}</h2>${lemma}</div>
      ${block(entry, false)}
      ${entry.also ? `<div class="define__also"><h3 class="define__alsohead">Also: ${esc(entry.also.lemma)}</h3>${block(entry.also, false)}</div>` : ''}
      ${actions}
      <p class="define__src">${entry.source === 'WordNet' ? 'Offline · WordNet' : `From ${entry.source}`}</p>
    </div>`;
  }

  private onSheetClick(e: Event) {
    const t = e.target as HTMLElement;
    const syn = t.closest<HTMLElement>('[data-word]');
    if (syn) {
      void this.define(syn.dataset.word!);
      return;
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'more') {
      const sec = t.closest('.define__group')!;
      sec.querySelectorAll('.is-extra').forEach((li) => li.classList.remove('is-extra'));
      t.remove();
    } else if (act === 'copy') {
      const text = this.range?.toString() ?? this.sheet?.body.querySelector('.define__word')?.textContent ?? '';
      void copy(text.trim());
    } else if (act === 'hl' && this.range) {
      this.host.onHighlight(this.range, COLORS.yellow);
      this.dismiss();
    }
  }

  /* ------------------------------------------------------------ selection */

  private selectionBar(range: Range) {
    this.bar?.remove();
    const bar = document.createElement('div');
    bar.className = 'selbar';
    const canHL = this.host.canHighlight();
    bar.innerHTML = `
      ${canHL ? Object.entries(COLORS).map(([n, c]) => `<button class="selbar__dot" data-color="${c}" aria-label="Highlight ${n}" style="--c:${c}"></button>`).join('') + '<span class="selbar__sep"></span>' : ''}
      <button data-act="copy" aria-label="Copy">${icon('copy')}</button>
      <button data-act="define" aria-label="Look up">${icon('search')}</button>
      <button data-act="close" aria-label="Close">${icon('close')}</button>`;
    document.body.append(bar);
    const r = this.anchorRect(range);
    const bw = bar.offsetWidth;
    const x = Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), innerWidth - bw - 8);
    const above = r.top - 58;
    const y = above > 60 ? above : Math.min(r.bottom + 12, innerHeight - 70);
    bar.style.transform = `translate(${x}px, ${y}px)`;
    requestAnimationFrame(() => bar.classList.add('is-on'));
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b) return;
      if (b.dataset.color) {
        this.host.onHighlight(range, b.dataset.color);
        this.dismiss();
      } else if (b.dataset.act === 'copy') {
        void copy(range.toString().trim());
        this.dismiss();
      } else if (b.dataset.act === 'define') {
        void this.define(range.toString().replace(/\s+/g, ' ').slice(0, 80), range);
      } else this.dismiss();
    });
    this.bar = bar;
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

/* ---------------------------------------------------------- hit testing */

const segmenters = new Map<string, Intl.Segmenter>();
function segmenter(lang: string) {
  let s = segmenters.get(lang);
  if (!s) {
    try {
      s = new Intl.Segmenter(lang || undefined, { granularity: 'word' });
    } catch {
      s = new Intl.Segmenter(undefined, { granularity: 'word' });
    }
    segmenters.set(lang, s);
  }
  return s;
}

function caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const d = doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  const r = doc.caretRangeFromPoint?.(x, y);
  return r ? { node: r.startContainer, offset: r.startOffset } : null;
}

/**
 * The word under a point, as a Range — only if the point is really on it
 * (caret hit-testing returns the nearest text even in the margins).
 */
export function wordAt(doc: Document, x: number, y: number, lang: string, loose = false): Range | null {
  const c = caretAt(doc, x, y);
  if (!c || c.node.nodeType !== Node.TEXT_NODE) return null;
  const text = (c.node as Text).data;
  const seg = segmenter(lang).segment(text);
  let s = seg.containing(Math.min(c.offset, text.length - 1));
  if (s && !s.isWordLike && c.offset > 0) s = seg.containing(c.offset - 1);
  if (!s || !s.isWordLike) return null;
  let startI = s.index;
  let endI = s.index + s.segment.length;
  // Keep hyphenated words and contractions whole: "well-known", "don't".
  while (startI > 1 && /[-'’]/.test(text[startI - 1]!) && /\p{L}/u.test(text[startI - 2]!)) {
    const prev = seg.containing(startI - 2);
    if (!prev?.isWordLike) break;
    startI = prev.index;
  }
  while (endI < text.length - 1 && /[-'’]/.test(text[endI]!) && /\p{L}/u.test(text[endI + 1]!)) {
    const next = seg.containing(endI + 1);
    if (!next?.isWordLike) break;
    endI = next.index + next.segment.length;
  }
  const range = doc.createRange();
  range.setStart(c.node, startI);
  range.setEnd(c.node, endI);
  if (loose) return range;
  const pad = 8;
  for (const r of range.getClientRects()) {
    if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return range;
  }
  return null;
}

/** Rects of the text in a range only — not the boxes of elements it crosses. */
function textRects(range: Range): DOMRect[] {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return [...range.getClientRects()];
  const doc = range.startContainer.ownerDocument!;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out: DOMRect[] = [];
  const r = doc.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const t = n as Text;
    r.setStart(t, t === range.startContainer ? range.startOffset : 0);
    r.setEnd(t, t === range.endContainer ? range.endOffset : t.length);
    out.push(...r.getClientRects());
  }
  return out;
}

function mergeRects(list: Iterable<DOMRect>) {
  const out: DOMRect[] = [];
  for (const r of list) {
    if (r.width < 1 || r.height < 1) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.top - r.top) < 2 && Math.abs(last.height - r.height) < 2 && r.left - last.right < 4) {
      out[out.length - 1] = new DOMRect(last.left, last.top, r.right - last.left, last.height);
    } else out.push(r);
  }
  return out;
}
