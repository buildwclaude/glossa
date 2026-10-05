/**
 * Bottom sheets: the one surface every panel uses (contents, settings,
 * search, the dictionary). They stack, the back button closes the top one,
 * and a downward swipe on the handle dismisses.
 */

const stack: Sheet[] = [];

export function closeTopSheet() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function closeAllSheets() {
  while (stack.length) stack[stack.length - 1]!.close();
}

export type SheetOptions = {
  title?: string;
  className?: string;
  /** Leave the page behind usable (no dimming backdrop). */
  modeless?: boolean;
  onClose?: () => void;
};

export class Sheet {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly head: HTMLElement;
  private backdrop: HTMLElement | null = null;
  private opts: SheetOptions;
  isOpen = false;

  constructor(opts: SheetOptions = {}) {
    this.opts = opts;
    this.root = document.createElement('section');
    this.root.className = `sheet ${opts.className ?? ''}`;
    this.root.setAttribute('role', 'dialog');
    this.root.innerHTML = `<div class="sheet__handle" aria-hidden="true"></div><header class="sheet__head"></header><div class="sheet__body"></div>`;
    this.head = this.root.querySelector('.sheet__head')!;
    this.body = this.root.querySelector('.sheet__body')!;
    if (opts.title) this.title(opts.title);
    else this.head.hidden = true;
    this.dragToClose();
  }

  title(text: string) {
    this.head.hidden = false;
    this.head.innerHTML = '';
    const h = document.createElement('h2');
    h.className = 'sheet__title';
    h.textContent = text;
    this.head.append(h);
    this.root.setAttribute('aria-label', text);
  }

  open(atTop = false) {
    this.root.classList.toggle('sheet--top', atTop);
    if (this.isOpen) return this;
    this.isOpen = true;
    if (!this.opts.modeless) {
      this.backdrop = document.createElement('div');
      this.backdrop.className = 'sheet-backdrop';
      this.backdrop.addEventListener('click', () => this.close());
      document.body.append(this.backdrop);
    }
    document.body.append(this.root);
    stack.push(this);
    requestAnimationFrame(() => {
      this.root.classList.add('is-open');
      this.backdrop?.classList.add('is-open');
    });
    return this;
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    stack.splice(stack.indexOf(this), 1);
    this.root.classList.remove('is-open');
    const bd = this.backdrop;
    bd?.classList.remove('is-open');
    this.backdrop = null;
    const done = () => {
      if (!this.isOpen) this.root.remove();
      bd?.remove();
    };
    this.root.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 400);
    this.opts.onClose?.();
  }

  /**
   * Swipe down to dismiss (up, for a sheet at the top). Touch events, not
   * pointer events: the browser claims a vertical pan for scrolling and
   * cancels pointer events, which is why a plain pointer drag never closed.
   */
  private dragToClose() {
    let y0 = 0;
    let x0 = 0;
    let dy = 0;
    let state: 'idle' | 'maybe' | 'drag' = 'idle';
    let t0 = 0;
    const dir = () => (this.root.classList.contains('sheet--top') ? -1 : 1);

    const start = (y: number, x: number, target: HTMLElement) => {
      const fromHead = !!target.closest('.sheet__handle, .sheet__head');
      // From the body only when it's scrolled to its start, and not from a field.
      if (!fromHead && target.closest('input, textarea, [data-nodrag]')) return;
      state = 'maybe';
      y0 = y;
      x0 = x;
      dy = 0;
      t0 = performance.now();
    };
    const move = (y: number, x: number, e: Event) => {
      if (state === 'idle') return;
      const d = (y - y0) * dir();
      if (state === 'maybe') {
        if (Math.abs(x - x0) > 12 && Math.abs(x - x0) > Math.abs(y - y0)) return void (state = 'idle');
        // Pulling towards the edge while the list is at its start: take it.
        const atStart = dir() > 0 ? this.body.scrollTop <= 0 : this.body.scrollTop + this.body.clientHeight >= this.body.scrollHeight - 1;
        if (d > 6 && atStart) state = 'drag';
        else if (Math.abs(y - y0) > 8) return void (state = 'idle');
        else return;
      }
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, d);
      this.root.style.transition = 'none';
      this.root.style.transform = `translateY(${dy * dir()}px)`;
    };
    const end = () => {
      if (state !== 'drag') return void (state = 'idle');
      state = 'idle';
      const fast = dy / Math.max(1, performance.now() - t0) > 0.5;
      this.root.style.transition = '';
      this.root.style.transform = '';
      if (dy > 80 || (fast && dy > 24)) this.close();
    };

    this.root.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) start(e.touches[0]!.clientY, e.touches[0]!.clientX, e.target as HTMLElement);
    }, { passive: true });
    this.root.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      if (t) move(t.clientY, t.clientX, e);
    }, { passive: false });
    this.root.addEventListener('touchend', end);
    this.root.addEventListener('touchcancel', end);

    // Mouse (desktop): drag the handle.
    this.root.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('.sheet__handle, .sheet__head')) return;
      start(e.clientY, e.clientX, e.target as HTMLElement);
      const mm = (ev: MouseEvent) => move(ev.clientY, ev.clientX, ev);
      const mu = () => {
        end();
        removeEventListener('mousemove', mm);
        removeEventListener('mouseup', mu);
      };
      addEventListener('mousemove', mm);
      addEventListener('mouseup', mu);
    });
  }
}

/** A short message at the bottom of the screen. */
export function toast(text: string, ms = 2400) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('is-on'));
  setTimeout(() => {
    el.classList.remove('is-on');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/** A small yes/no question in a sheet. */
export function confirmSheet(title: string, message: string, yes: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const s = new Sheet({ title, className: 'sheet--confirm', onClose: () => !answered && resolve(false) });
    s.body.innerHTML = `<p class="confirm__msg"></p><div class="confirm__actions"><button class="btn btn--ghost" data-a="no">Cancel</button><button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-a="yes"></button></div>`;
    s.body.querySelector('.confirm__msg')!.textContent = message;
    s.body.querySelector('[data-a="yes"]')!.textContent = yes;
    s.body.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (!a) return;
      answered = true;
      resolve(a === 'yes');
      s.close();
    });
    s.open();
  });
}

/** Asks for a line of text (e.g. a PDF's password). */
export function promptSheet(title: string, message: string, type = 'text'): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = false;
    const s = new Sheet({ title, className: 'sheet--confirm', onClose: () => !answered && resolve(null) });
    s.body.innerHTML = `<p class="confirm__msg"></p><form class="prompt"><input class="field" type="${type}" autocomplete="off" required><div class="confirm__actions"><button type="button" class="btn btn--ghost" data-a="no">Cancel</button><button class="btn btn--primary">Open</button></div></form>`;
    s.body.querySelector('.confirm__msg')!.textContent = message;
    const input = s.body.querySelector('input')!;
    s.body.querySelector('[data-a="no"]')!.addEventListener('click', () => s.close());
    s.body.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      answered = true;
      resolve(input.value);
      s.close();
    });
    s.open();
    setTimeout(() => input.focus(), 250);
  });
}
