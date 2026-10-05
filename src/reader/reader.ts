import { db, type BookRecord, type Note } from '../lib/db';
import { loadFoliate, openBook, PasswordError, type FBook } from '../lib/formats';
import { native, isNative } from '../lib/native';
import { Sheet, toast, closeAllSheets, promptSheet } from '../ui/sheet';
import { icon } from '../ui/icons';
import { Lookup, COLORS } from './lookup';
import { bookCSS, FONTS, gapPct, marginPx, savePrefs, THEMES, type Prefs } from './prefs';

/**
 * The reading screen. foliate-js lays the book out; this adds the chrome
 * (which hides itself while you read), tap zones and swipes for turning
 * pages, contents, search, bookmarks and highlights, the look settings,
 * and press-and-hold lookup.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FView = HTMLElement & any;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = () => new URL('foliate-js/', document.baseURI).href;

export class Reader {
  readonly root: HTMLElement;
  private view!: FView;
  private book!: FBook;
  private record: BookRecord;
  private prefs: Prefs;
  private lookup: Lookup;
  private notes: Note[] = [];
  private chrome = false;
  private tapBlockedUntil = 0;
  private saveTimer = 0;
  private location: { cfi?: string; fraction?: number; tocItem?: { label?: string; href?: string }; range?: Range; index?: number; time?: { section?: number } } = {};
  private onCloseCb: (rec: BookRecord) => void;
  private closed = false;
  private sliding = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Overlayer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private CFI: any;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(record: BookRecord, prefs: Prefs, onClose: (rec: BookRecord) => void) {
    this.record = record;
    this.prefs = prefs;
    this.onCloseCb = onClose;
    this.root = document.createElement('div');
    this.root.className = 'reader';
    this.root.innerHTML = `
      <div class="reader__view"></div>
      <div class="reader__status" aria-hidden="true"><span class="reader__status-l"></span><span class="reader__status-r"></span></div>
      <header class="reader__top">
        <button class="ibtn" data-a="back" aria-label="Back to library">${icon('back')}</button>
        <div class="reader__title"><span class="reader__book"></span><span class="reader__chapter"></span></div>
        <button class="ibtn" data-a="search" aria-label="Search">${icon('search')}</button>
        <button class="ibtn" data-a="bookmark" aria-label="Bookmark this page" aria-pressed="false">${icon('bookmark')}</button>
        <button class="ibtn" data-a="settings" aria-label="Reading settings"><span class="aa">Aa</span></button>
        <button class="ibtn" data-a="toc" aria-label="Contents">${icon('toc')}</button>
      </header>
      <footer class="reader__bottom">
        <div class="reader__progress"><span class="reader__where"></span><span class="reader__pct"></span></div>
        <input class="reader__slider" type="range" min="0" max="1000" step="1" value="0" aria-label="Position in book">
        <div class="reader__actions">
          <button class="pill" data-a="notes">${icon('notes')}<span>Notes</span></button>
        </div>
      </footer>
      <div class="reader__loading"><div class="spinner"></div></div>`;
    this.root.querySelector('.reader__book')!.textContent = record.title;
    this.root.addEventListener('click', (e) => this.onChromeClick(e));
    this.wireSlider();
    this.lookup = new Lookup({
      lang: () => {
        const l = this.book?.metadata?.language;
        return (typeof l === 'string' ? l : Array.isArray(l) ? l[0] : '') || 'en';
      },
      canHighlight: () => !this.view?.isFixedLayout,
      onHighlight: (range, color) => void this.addHighlight(range, color),
      suppressTap: (ms) => (this.tapBlockedUntil = performance.now() + ms),
      bounds: () => this.root.querySelector('.reader__view')!.getBoundingClientRect(),
    });
  }

  /* ---------------------------------------------------------------- open */

  async open(file: Blob) {
    document.body.append(this.root);
    this.applyTheme();
    void this.root.offsetWidth; // commit the start state so the entrance animates
    this.root.classList.add('is-in');

    const [, overlayer, cfi] = await Promise.all([
      loadFoliate(),
      import(/* @vite-ignore */ base() + 'overlayer.js'),
      import(/* @vite-ignore */ base() + 'epubcfi.js'),
    ]);
    this.Overlayer = overlayer.Overlayer;
    this.CFI = cfi;

    let password: string | undefined;
    for (;;) {
      try {
        this.book = await openBook(file, this.record.format, password);
        break;
      } catch (e) {
        if (!(e instanceof PasswordError)) throw e;
        const p = await promptSheet('Locked PDF', e.message === 'wrong' ? 'That password didn’t work. Try again.' : 'This PDF is protected. Enter its password to open it.', 'password');
        if (p === null) {
          this.close();
          return;
        }
        password = p;
      }
    }
    if (this.closed) return;

    const view = (this.view = document.createElement('foliate-view') as FView);
    this.root.querySelector('.reader__view')!.append(view);
    view.addEventListener('load', (e: CustomEvent) => this.onLoad(e.detail));
    view.addEventListener('relocate', (e: CustomEvent) => this.onRelocate(e.detail));
    view.addEventListener('create-overlay', (e: CustomEvent) => this.paintNotes(e.detail.index));
    view.addEventListener('draw-annotation', (e: CustomEvent) => {
      const { draw, annotation } = e.detail;
      draw(this.Overlayer.highlight, { color: annotation.color });
    });
    view.addEventListener('show-annotation', (e: CustomEvent) => this.showHighlight(e.detail.value));
    view.addEventListener('external-link', (e: CustomEvent) => {
      // Links out of the book open in the system browser only on purpose.
      e.preventDefault();
      toast('External link: ' + (e.detail.href_ ?? '').slice(0, 60));
    });
    view.addEventListener('click', (e: MouseEvent) => this.onPageTap(e.clientX, e.clientY, e.target as Element));

    await view.open(this.book);
    if (this.closed) return;
    this.root.classList.toggle('is-fxl', view.isFixedLayout);
    this.root.classList.toggle('is-comic', this.record.format === 'cbz');
    this.root.querySelector<HTMLElement>('[data-a="search"]')!.hidden = view.isFixedLayout;
    this.applyLayout();

    this.notes = await db.notes(this.record.id);
    try {
      await view.init({ lastLocation: this.record.location, showTextStart: !this.record.location });
    } catch {
      await view.init({ showTextStart: true });
    }
    this.root.querySelector('.reader__loading')?.remove();

    document.addEventListener('keydown', this.keyHandler);
    void native.keepAwake(true);
    void native.immersive(true);
    if (this.prefs.volumeKeys) void native.volumeKeys(true);
    void db.patchBook(this.record.id, { openedAt: Date.now() });
    if (this.book.dir === 'rtl') this.root.dir = 'rtl';
  }

  /** Back button / Escape: true if the reader used it. */
  back(): boolean {
    if (this.closed) return false;
    if (document.querySelector('.selbar, .mark')) {
      this.lookup.dismiss();
      return true;
    }
    this.close();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.saveTimer);
    void this.save();
    closeAllSheets();
    this.lookup.destroy();
    document.removeEventListener('keydown', this.keyHandler);
    void native.keepAwake(false);
    void native.volumeKeys(false);
    void native.immersive(false);
    delete document.body.dataset.rtheme;
    this.root.classList.remove('is-in');
    this.root.classList.add('is-out');
    setTimeout(() => {
      try {
        this.view?.close();
        this.book?.destroy?.();
      } catch {
        /* already gone */
      }
      this.root.remove();
    }, 280);
    this.onCloseCb({ ...this.record, location: this.location.cfi ?? this.record.location, progress: this.location.fraction ?? this.record.progress });
  }

  onVolumeKey(dir: 1 | -1) {
    if (!this.view) return;
    void (dir > 0 ? this.view.next() : this.view.prev());
  }

  /* -------------------------------------------------------------- layout */

  private applyTheme() {
    const t = THEMES[this.prefs.theme];
    this.root.dataset.theme = this.prefs.theme;
    // Panels opened over the book take its colours, not the system's.
    document.body.dataset.rtheme = this.prefs.theme;
    this.root.style.setProperty('--r-bg', t.bg);
    this.root.style.setProperty('--r-fg', t.fg);
    this.root.style.setProperty('--r-muted', t.muted);
    this.root.classList.toggle('is-darkpages', t.dark && this.prefs.darkPages);
    void native.statusStyle(t.dark);
  }

  private applyLayout() {
    const r = this.view?.renderer;
    if (!r) return;
    const p = this.prefs;
    if (this.view.isFixedLayout) {
      r.setAttribute('zoom', p.zoom);
    } else {
      r.setAttribute('flow', p.flow);
      r.setAttribute('margin', `${Math.max(36, marginPx(p) + 8)}px`);
      r.setAttribute('gap', `${gapPct(p)}%`);
      r.setAttribute('max-inline-size', '680px');
      r.setAttribute('max-column-count', '2');
      r.setAttribute('animated', '');
      r.setStyles?.(bookCSS(p));
    }
    this.root.classList.toggle('is-scrolled', !this.view.isFixedLayout && p.flow === 'scrolled');
  }

  private setPrefs(patch: Partial<Prefs>) {
    Object.assign(this.prefs, patch);
    void savePrefs(this.prefs);
    this.applyTheme();
    this.applyLayout();
    if ('volumeKeys' in patch) void native.volumeKeys(!!patch.volumeKeys);
    requestAnimationFrame(() => this.lookup.repaint());
  }

  /* -------------------------------------------------------------- events */

  private onLoad({ doc }: { doc: Document; index: number }) {
    if (import.meta.env.DEV) (globalThis as { __doc?: Document }).__doc = doc;
    this.lookup.attach(doc);
    doc.addEventListener('click', (e) => {
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      const fr = frame?.getBoundingClientRect();
      const sx = fr && frame ? fr.width / (frame.offsetWidth || fr.width) : 1;
      this.onPageTap((fr?.left ?? 0) + e.clientX * sx, (fr?.top ?? 0) + e.clientY * sx, e.target as Element);
    });
    doc.addEventListener('keydown', this.keyHandler);
    if (this.view.isFixedLayout) this.fxlGestures(doc);
  }

  /**
   * Fixed-layout pages (PDF, comics): swipe sideways to turn, pinch or
   * double-tap to zoom (re-rendered sharp at the new size), drag to pan.
   */
  private zoom = 1;
  private lastTap = { t: 0, x: 0, y: 0 };
  private tapTimer = 0;

  private fxlGestures(doc: Document) {
    const win = doc.defaultView!;
    const toScreen = (t: Touch) => {
      const frame = win.frameElement as HTMLElement;
      const fr = frame.getBoundingClientRect();
      const k = fr.width / (frame.offsetWidth || fr.width);
      return { x: fr.left + t.clientX * k, y: fr.top + t.clientY * k };
    };
    const dist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    let swipe: { x: number; y: number; t: number } | null = null;
    let pinch: { d0: number; cx: number; cy: number; z0: number; ratio: number } | null = null;

    doc.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0]!, e.touches[1]!];
        const pa = toScreen(a);
        const pb = toScreen(b);
        pinch = { d0: dist(a, b), cx: (pa.x + pb.x) / 2, cy: (pa.y + pb.y) / 2, z0: this.zoom, ratio: 1 };
        swipe = null;
      } else if (e.touches.length === 1 && !pinch) {
        const p = toScreen(e.touches[0]!);
        swipe = { ...p, t: performance.now() };
      }
    }, { passive: true });

    doc.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length < 2) return;
      e.preventDefault();
      const r = this.view.renderer as HTMLElement;
      const rr = r.getBoundingClientRect();
      pinch.ratio = Math.min(4, Math.max(1, pinch.z0 * (dist(e.touches[0]!, e.touches[1]!) / pinch.d0))) / pinch.z0;
      r.style.transformOrigin = `${pinch.cx - rr.left}px ${pinch.cy - rr.top}px`;
      r.style.transform = `scale(${pinch.ratio})`;
    }, { passive: false });

    doc.addEventListener('touchend', (e) => {
      if (pinch) {
        if (e.touches.length) return;
        const p = pinch;
        pinch = null;
        this.tapBlockedUntil = performance.now() + 400;
        void this.setZoom(p.z0 * p.ratio, p.cx, p.cy);
        return;
      }
      if (!swipe || e.touches.length) return;
      const end = toScreen(e.changedTouches[0]!);
      const dx = end.x - swipe.x;
      const dy = end.y - swipe.y;
      const dt = performance.now() - swipe.t;
      swipe = null;
      if (this.zoom <= 1.01 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 700) {
        this.tapBlockedUntil = performance.now() + 350;
        void (dx < 0 ? this.view.goRight() : this.view.goLeft());
        return;
      }
      // Double-tap: zoom in where you tapped, or back out.
      if (Math.hypot(dx, dy) < 12 && dt < 300) {
        const now = performance.now();
        if (now - this.lastTap.t < 320 && Math.hypot(end.x - this.lastTap.x, end.y - this.lastTap.y) < 40) {
          clearTimeout(this.tapTimer);
          this.lastTap.t = 0;
          this.tapBlockedUntil = now + 400;
          void this.setZoom(this.zoom > 1.01 ? 1 : 2.2, end.x, end.y);
        } else this.lastTap = { t: now, x: end.x, y: end.y };
      }
    });
  }

  private async setZoom(z: number, fx: number, fy: number) {
    const r = this.view.renderer as HTMLElement;
    z = Math.min(4, Math.max(1, z));
    const rr = r.getBoundingClientRect();
    const x = fx - rr.left;
    const y = fy - rr.top;
    const old = this.zoom;
    const px = (r.scrollLeft + x) / old;
    const py = (r.scrollTop + y) / old;
    this.zoom = z;
    r.setAttribute('zoom-factor', String(z));
    r.style.transform = '';
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    r.scrollLeft = px * z - x;
    r.scrollTop = py * z - y;
    this.root.classList.toggle('is-zoomed', z > 1.01);
  }

  private onPageTap(x: number, _y: number, target: Element | null) {
    if (performance.now() < this.tapBlockedUntil) return;
    if (target?.closest?.('a[href]')) return;
    if (document.querySelector('.selbar') || document.querySelector('.sheet--define.is-open')) {
      this.lookup.dismiss();
      return;
    }
    if (this.view.isFixedLayout) {
      // Wait a moment: this may be the first half of a double-tap.
      clearTimeout(this.tapTimer);
      this.tapTimer = window.setTimeout(() => {
        if (performance.now() < this.tapBlockedUntil) return;
        this.tapZones(x, this.zoom > 1.01);
      }, 280);
      return;
    }
    this.tapZones(x, this.root.classList.contains('is-scrolled'));
  }

  private tapZones(x: number, noTurn: boolean) {
    const w = innerWidth;
    const scrolled = noTurn;
    if (!scrolled && x < w * 0.27) {
      this.setChrome(false);
      void this.view.goLeft();
    } else if (!scrolled && x > w * 0.73) {
      this.setChrome(false);
      void this.view.goRight();
    } else this.setChrome(!this.chrome);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest?.('input, textarea')) return;
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') void this.view.goLeft();
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') void this.view.goRight();
    else return;
    e.preventDefault();
  }

  private setChrome(on: boolean) {
    if (this.chrome === on) return;
    this.chrome = on;
    this.root.classList.toggle('is-chrome', on);
    void native.immersive(!on);
  }

  private onRelocate(d: Reader['location'] & { fraction: number }) {
    // A page that settles back where it was isn't a page turn.
    const moved = d.cfi !== this.location.cfi;
    this.location = d;
    const pct = Math.round((d.fraction ?? 0) * 100);
    const chapter = d.tocItem?.label?.trim() ?? '';
    const q = (s: string) => this.root.querySelector<HTMLElement>(s)!;
    q('.reader__chapter').textContent = chapter;
    q('.reader__where').textContent = chapter;
    q('.reader__pct').textContent = `${pct}%`;
    const mins = d.time?.section;
    q('.reader__status-l').textContent = this.view.isFixedLayout
      ? ''
      : mins != null && mins > 0.5
        ? `${Math.round(mins)} min left in chapter`
        : chapter;
    q('.reader__status-r').textContent = `${pct}%`;
    if (!this.sliding) this.root.querySelector<HTMLInputElement>('.reader__slider')!.value = String(Math.round((d.fraction ?? 0) * 1000));
    this.updateBookmark();
    if (moved) this.lookup.dismiss();
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 700);
  }

  private async save() {
    if (!this.location.cfi) return;
    await db.patchBook(this.record.id, { location: this.location.cfi, progress: this.location.fraction ?? 0, openedAt: Date.now() });
  }

  private onChromeClick(e: Event) {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'back') this.close();
    else if (a === 'toc') this.openTOC();
    else if (a === 'search') this.openSearch();
    else if (a === 'settings') this.openSettings();
    else if (a === 'bookmark') void this.toggleBookmark();
    else if (a === 'notes') this.openNotes();
  }

  /* --------------------------------------------------------------- panels */

  private openTOC() {
    const toc = (this.book.toc ?? []) as { label: string; href: string; subitems?: unknown[] }[];
    const s = new Sheet({ title: 'Contents', className: 'sheet--tall' });
    if (!toc.length) {
      s.body.innerHTML = `<p class="empty-note">This book has no table of contents.</p>`;
    } else {
      const current = this.location.tocItem?.href;
      const list = (items: typeof toc, depth: number): string =>
        `<ol class="toc toc--${Math.min(depth, 3)}">${items
          .map(
            (i) => `<li><button class="toc__item ${i.href === current ? 'is-current' : ''}" data-href="${esc(i.href ?? '')}">${esc(i.label?.trim() || 'Untitled')}</button>${
              i.subitems?.length ? list(i.subitems as typeof toc, depth + 1) : ''
            }</li>`,
          )
          .join('')}</ol>`;
      s.body.innerHTML = list(toc, 0);
      s.body.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-href]');
        if (!b) return;
        void this.view.goTo(b.dataset.href);
        s.close();
        this.setChrome(false);
      });
    }
    s.open();
    requestAnimationFrame(() => s.body.querySelector('.is-current')?.scrollIntoView({ block: 'center' }));
  }

  private openSearch() {
    const s = new Sheet({ className: 'sheet--tall', onClose: () => this.view.clearSearch?.() });
    s.body.innerHTML = `<form class="search"><input class="field" type="search" placeholder="Search in this book" enterkeyhint="search" autocomplete="off"></form><div class="search__status"></div><ol class="search__results"></ol>`;
    const input = s.body.querySelector('input')!;
    const status = s.body.querySelector<HTMLElement>('.search__status')!;
    const out = s.body.querySelector<HTMLElement>('.search__results')!;
    let run = 0;
    s.body.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      input.blur();
      const id = ++run;
      out.innerHTML = '';
      status.textContent = 'Searching…';
      let count = 0;
      for await (const r of this.view.search({ query })) {
        if (id !== run || !s.isOpen) return;
        if (r === 'done') break;
        if (r.progress != null) {
          status.textContent = `Searching… ${Math.round(r.progress * 100)}%`;
          continue;
        }
        const frag = document.createDocumentFragment();
        if (r.label) {
          const h = document.createElement('li');
          h.className = 'search__label';
          h.textContent = r.label;
          frag.append(h);
        }
        for (const item of r.subitems ?? []) {
          count++;
          const li = document.createElement('li');
          const { pre, match, post } = item.excerpt;
          li.innerHTML = `<button class="search__hit" data-cfi="${esc(item.cfi)}">${esc(pre)}<mark>${esc(match)}</mark>${esc(post)}</button>`;
          frag.append(li);
        }
        out.append(frag);
      }
      if (id === run) status.textContent = count ? `${count} result${count === 1 ? '' : 's'}` : 'No results';
    });
    out.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cfi]');
      if (!b) return;
      void this.view.goTo(b.dataset.cfi);
      s.close();
      this.setChrome(false);
    });
    s.open();
    setTimeout(() => input.focus(), 260);
  }

  private openSettings() {
    const s = new Sheet({ title: 'Reading', className: 'sheet--settings' });
    const render = () => {
      const p = this.prefs;
      const fxl = this.view.isFixedLayout;
      const seg = (key: string, opts: [string | number, string][], val: unknown) =>
        `<div class="seg" role="radiogroup">${opts
          .map(([v, l]) => `<button role="radio" aria-checked="${v === val}" data-k="${key}" data-v="${v}">${l}</button>`)
          .join('')}</div>`;
      s.body.innerHTML = `
        <div class="set">
          <div class="swatches" role="radiogroup" aria-label="Theme">${Object.entries(THEMES)
            .map(([k, t]) => `<button class="swatch" role="radio" aria-checked="${p.theme === k}" data-k="theme" data-v="${k}" style="--bg:${t.bg};--fg:${t.fg}"><span>Aa</span>${t.label}</button>`)
            .join('')}</div>
        </div>
        ${fxl ? `
        <div class="set"><span class="set__label">Page</span>${seg('zoom', [['fit-page', 'Fit page'], ['fit-width', 'Fit width']], p.zoom)}</div>
        ${this.record.format !== 'cbz' ? `<div class="set"><span class="set__label">Dark pages</span>${seg('darkPages', [['true', 'On'], ['false', 'Off']], String(p.darkPages))}</div>` : ''}
        ` : `
        <div class="set"><span class="set__label">Size</span>
          <div class="stepper"><button data-step="-10" aria-label="Smaller text"><span style="font-size:13px">A</span></button><output>${p.size}%</output><button data-step="10" aria-label="Larger text"><span style="font-size:20px">A</span></button></div>
        </div>
        <div class="set"><span class="set__label">Font</span>${seg('font', Object.entries(FONTS).map(([k, f]) => [k, f.label]), p.font)}</div>
        <div class="set"><span class="set__label">Spacing</span>${seg('spacing', [[1.3, 'Tight'], [1.5, 'Normal'], [1.75, 'Loose'], [2, 'Airy']], p.spacing)}</div>
        <div class="set"><span class="set__label">Margins</span>${seg('margin', [[0, 'Narrow'], [1, 'Normal'], [2, 'Wide']], p.margin)}</div>
        <div class="set"><span class="set__label">Layout</span>${seg('flow', [['paginated', 'Pages'], ['scrolled', 'Scroll']], p.flow)}</div>
        <div class="set"><span class="set__label">Align</span>${seg('justify', [['true', 'Justified'], ['false', 'Left']], String(p.justify))}</div>
        `}
        ${isNative ? `<div class="set"><span class="set__label">Volume keys turn pages</span>${seg('volumeKeys', [['true', 'On'], ['false', 'Off']], String(p.volumeKeys))}</div>` : ''}
      `;
    };
    s.body.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b) return;
      if (b.dataset.step) {
        this.setPrefs({ size: Math.min(220, Math.max(60, this.prefs.size + Number(b.dataset.step))) });
      } else if (b.dataset.k) {
        const k = b.dataset.k as keyof Prefs;
        const raw = b.dataset.v!;
        const cur = this.prefs[k];
        const v = typeof cur === 'number' ? Number(raw) : typeof cur === 'boolean' ? raw === 'true' : raw;
        this.setPrefs({ [k]: v } as Partial<Prefs>);
      } else return;
      render();
    });
    render();
    s.open();
  }

  private openNotes() {
    const s = new Sheet({ title: 'Notes', className: 'sheet--tall' });
    const render = () => {
      const marks = this.notes.filter((n) => n.kind === 'bookmark');
      const hls = this.notes.filter((n) => n.kind === 'highlight');
      const item = (n: Note) => `<li class="note">
          <button class="note__go" data-cfi="${esc(n.cfi)}">
            ${n.kind === 'highlight' ? `<span class="note__text" style="--c:${n.color}">${esc(n.text)}</span>` : `<span class="note__text note__text--bm">${esc(n.text || 'Bookmark')}</span>`}
            <span class="note__meta">${esc(n.label ?? '')}</span>
          </button>
          <button class="ibtn ibtn--sm" data-del="${n.id}" aria-label="Delete">${icon('trash')}</button>
        </li>`;
      s.body.innerHTML =
        !marks.length && !hls.length
          ? `<p class="empty-note">Nothing here yet.<br>Tap ${icon('bookmark')} to bookmark a page. Press and hold a word, then drag across a passage to highlight it.</p>`
          : `${marks.length ? `<h3 class="notes__h">Bookmarks</h3><ol class="notes">${marks.map(item).join('')}</ol>` : ''}
             ${hls.length ? `<h3 class="notes__h">Highlights</h3><ol class="notes">${hls.map(item).join('')}</ol>` : ''}`;
    };
    s.body.addEventListener('click', async (e) => {
      const t = e.target as HTMLElement;
      const del = t.closest<HTMLElement>('[data-del]')?.dataset.del;
      if (del) {
        await this.removeNote(del);
        render();
        return;
      }
      const go = t.closest<HTMLElement>('[data-cfi]')?.dataset.cfi;
      if (go) {
        void this.view.goTo(go);
        s.close();
        this.setChrome(false);
      }
    });
    render();
    s.open();
  }

  /* ------------------------------------------------------- bookmarks/notes */

  private pageBounds(): [string, string] | null {
    const { range, index } = this.location;
    if (!range || index == null) return null;
    const a = range.cloneRange();
    a.collapse(true);
    const b = range.cloneRange();
    b.collapse(false);
    return [this.view.getCFI(index, a), this.view.getCFI(index, b)];
  }

  private bookmarkHere(): Note | undefined {
    const b = this.pageBounds();
    if (!b) return undefined;
    return this.notes.find((n) => n.kind === 'bookmark' && this.CFI.compare(n.cfi, b[0]) >= 0 && this.CFI.compare(n.cfi, b[1]) <= 0);
  }

  private updateBookmark() {
    const on = !!this.bookmarkHere();
    const btn = this.root.querySelector<HTMLElement>('[data-a="bookmark"]')!;
    btn.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('has-bookmark', on);
  }

  private async toggleBookmark() {
    const existing = this.bookmarkHere();
    if (existing) {
      await this.removeNote(existing.id);
      toast('Bookmark removed');
    } else {
      const b = this.pageBounds();
      const cfi = b?.[0] ?? this.location.cfi;
      if (!cfi) return;
      const text = (this.location.range?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const note: Note = { id: crypto.randomUUID?.() ?? String(Date.now()), bookId: this.record.id, kind: 'bookmark', cfi, text, label: this.location.tocItem?.label ?? `${Math.round((this.location.fraction ?? 0) * 100)}%`, createdAt: Date.now() };
      this.notes.push(note);
      await db.putNote(note);
      toast('Page bookmarked');
    }
    this.updateBookmark();
  }

  private async addHighlight(range: Range, color: string) {
    const index = this.view.renderer.getContents().find((c: { doc: Document }) => c.doc === range.startContainer.ownerDocument)?.index;
    if (index == null) return;
    const cfi = this.view.getCFI(index, range);
    const note: Note = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      bookId: this.record.id,
      kind: 'highlight',
      cfi,
      text: range.toString().replace(/\s+/g, ' ').trim(),
      color,
      label: this.location.tocItem?.label ?? '',
      createdAt: Date.now(),
    };
    this.notes.push(note);
    await db.putNote(note);
    await this.view.addAnnotation({ value: cfi, color });
  }

  private async removeNote(id: string) {
    const n = this.notes.find((x) => x.id === id);
    this.notes = this.notes.filter((x) => x.id !== id);
    await db.removeNote(id);
    if (n?.kind === 'highlight') await this.view.deleteAnnotation({ value: n.cfi });
    this.updateBookmark();
  }

  private paintNotes(index: number) {
    for (const n of this.notes) {
      if (n.kind !== 'highlight') continue;
      try {
        const r = this.view.resolveNavigation(n.cfi);
        if (r?.index === index) void this.view.addAnnotation({ value: n.cfi, color: n.color ?? COLORS.yellow });
      } catch {
        /* a note from a different edition of the file */
      }
    }
  }

  private showHighlight(cfi: string) {
    const n = this.notes.find((x) => x.cfi === cfi);
    if (!n) return;
    this.tapBlockedUntil = performance.now() + 400;
    const s = new Sheet({ className: 'sheet--hl' });
    s.body.innerHTML = `<blockquote class="hl__quote" style="--c:${n.color}"></blockquote>
      <div class="hl__actions">
        ${Object.entries(COLORS).map(([name, c]) => `<button class="selbar__dot" data-color="${c}" aria-label="${name}" style="--c:${c}"></button>`).join('')}
        <span class="grow"></span>
        <button class="chip" data-a2="copy">${icon('copy')}Copy</button>
        <button class="chip chip--danger" data-a2="del">${icon('trash')}Remove</button>
      </div>`;
    s.body.querySelector('.hl__quote')!.textContent = n.text;
    s.body.addEventListener('click', async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (!b) return;
      if (b.dataset.color) {
        n.color = b.dataset.color;
        await db.putNote(n);
        await this.view.addAnnotation({ value: n.cfi, color: n.color });
      } else if (b.dataset.a2 === 'copy') {
        await navigator.clipboard?.writeText(n.text).catch(() => undefined);
        toast('Copied');
      } else if (b.dataset.a2 === 'del') {
        await this.removeNote(n.id);
      }
      s.close();
    });
    s.open();
  }

  /** Slider: preview while dragging, jump on release. */
  private wireSlider() {
    const slider = this.root.querySelector<HTMLInputElement>('.reader__slider')!;
    const pct = this.root.querySelector<HTMLElement>('.reader__pct')!;
    slider.addEventListener('input', () => {
      this.sliding = true;
      pct.textContent = `${Math.round(Number(slider.value) / 10)}%`;
    });
    slider.addEventListener('change', () => {
      this.sliding = false;
      void this.view.goToFraction(Number(slider.value) / 1000);
    });
  }
}
