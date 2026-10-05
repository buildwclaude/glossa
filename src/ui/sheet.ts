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

  private dragToClose() {
    let y0 = 0;
    let dy = 0;
    let active = false;
    const start = (e: PointerEvent) => {
      // Only from the handle/header, or from the body when it's scrolled to the top.
      const t = e.target as HTMLElement;
      const fromHead = !!t.closest('.sheet__handle, .sheet__head');
      if (!fromHead && (this.body.scrollTop > 0 || t.closest('input, button, a, [data-nodrag]'))) return;
      if (this.root.classList.contains('sheet--top')) return;
      active = true;
      y0 = e.clientY;
      dy = 0;
    };
    const move = (e: PointerEvent) => {
      if (!active) return;
      dy = Math.max(0, e.clientY - y0);
      if (dy > 6) {
        this.root.style.transition = 'none';
        this.root.style.transform = `translateY(${dy}px)`;
      }
    };
    const end = () => {
      if (!active) return;
      active = false;
      this.root.style.transition = '';
      this.root.style.transform = '';
      if (dy > 90) this.close();
    };
    this.root.addEventListener('pointerdown', start);
    this.root.addEventListener('pointermove', move);
    this.root.addEventListener('pointerup', end);
    this.root.addEventListener('pointercancel', end);
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
