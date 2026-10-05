import '@fontsource/instrument-serif/latin-400.css';
import '@fontsource-variable/inter';
import './styles.css';

import { db, type BookRecord } from './lib/db';
import { ACCEPT, FORMAT_LABEL } from './lib/formats';
import { importFile, seedSample } from './lib/library';
import { native, isNative } from './lib/native';
import { createBookshelf, supportsWebGL, type Bookshelf, type ShelfBook } from './shelf/bookshelf';
import { Reader } from './reader/reader';
import { loadPrefs } from './reader/prefs';
import { closeTopSheet, confirmSheet, Sheet, toast } from './ui/sheet';
import { icon } from './ui/icons';

/**
 * Glossa: the library (a 3D shelf you swipe through) and the reader.
 */

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="lib__head">
    <h1 class="brand">Glossa<span class="brand__dot" aria-hidden="true"></span></h1>
    <span class="lib__count"></span>
    <span class="grow"></span>
    <button class="ibtn" data-a="find" aria-label="All books">${icon('grid')}</button>
    <button class="btn btn--primary btn--add" data-a="add">${icon('plus')}<span>Add books</span></button>
  </header>
  <main class="lib__stage" aria-label="Bookshelf">
    <p class="lib__hint">Swipe to browse · tap a book to read</p>
  </main>
  <section class="lib__card" aria-live="polite">
    <div class="card">
      <p class="card__kicker"></p>
      <h2 class="card__title"></h2>
      <p class="card__author"></p>
      <div class="card__bar" aria-hidden="true"><span></span></div>
      <div class="card__actions">
        <button class="btn btn--primary btn--read" data-a="read">${icon('book')}<span>Start reading</span></button>
        <button class="ibtn" data-a="remove" aria-label="Remove from library">${icon('trash')}</button>
      </div>
    </div>
  </section>
  <section class="lib__empty" hidden>
    <div class="empty">
      <div class="empty__art" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
      <h2 class="empty__title">Your shelf is empty</h2>
      <p class="empty__text">Add EPUB, PDF, MOBI, AZW3, FB2, CBZ, TXT or Markdown files. Or open one from your file manager with Glossa.</p>
      <button class="btn btn--primary" data-a="add">${icon('plus')}<span>Add books</span></button>
    </div>
  </section>
  <input class="lib__file" type="file" multiple accept="${ACCEPT}" hidden>
  <div class="drop" aria-hidden="true"><p>Drop books to add them</p></div>
`;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => app.querySelector<T>(s)!;
const fileInput = $<HTMLInputElement>('.lib__file');
// Android's picker only knows MIME types, and has none for .azw3, .fb2,
// .cbz or .md — it would grey those files out. Glossa reads the bytes to
// tell formats apart anyway, so on the phone every file is offered.
if (isNative) fileInput.removeAttribute('accept');
const stage = $('.lib__stage');

let books: BookRecord[] = [];
let shelf: Bookshelf | null = null;
let current: BookRecord | null = null;
let reader: Reader | null = null;

const order = (list: BookRecord[]) => list.sort((a, b) => (b.openedAt ?? b.addedAt) - (a.openedAt ?? a.addedAt));
const toShelf = (b: BookRecord): ShelfBook => ({ id: b.id, title: b.title, author: b.author, color: b.color, cover: b.cover, progress: b.progress, size: b.size });

async function refresh(keepId?: string) {
  books = order(await db.books());
  $('.lib__count').textContent = books.length ? `${books.length} book${books.length === 1 ? '' : 's'}` : '';
  const empty = books.length === 0;
  $('.lib__empty').hidden = !empty;
  app.classList.toggle('is-empty', empty);
  if (shelf) shelf.setBooks(books.map(toShelf), keepId);
  else renderFallback();
  if (empty) showCard(null);
}

function showCard(sb: ShelfBook | null) {
  current = sb ? books.find((b) => b.id === sb.id) ?? null : null;
  const card = $('.lib__card');
  card.classList.toggle('is-on', !!current);
  if (!current) return;
  const p = current.progress ?? 0;
  const pct = Math.round(p * 100);
  $('.card__kicker').textContent = [FORMAT_LABEL[current.format], p > 0.995 ? 'Finished' : pct > 0 ? `${pct}% read` : 'New'].join(' · ');
  $('.card__title').textContent = current.title;
  $('.card__author').textContent = current.author || 'Unknown author';
  $<HTMLElement>('.card__bar span').style.width = `${pct}%`;
  $('.btn--read span').textContent = p > 0.995 ? 'Read again' : pct > 0 ? 'Continue reading' : 'Start reading';
  // Re-run the little entrance so a new book reads as new.
  const inner = card.querySelector('.card')!;
  inner.classList.remove('is-fresh');
  void (inner as HTMLElement).offsetWidth;
  inner.classList.add('is-fresh');
}

/* ----------------------------------------------------------------- open */

async function openReader(id: string) {
  if (reader) return;
  const rec = await db.book(id);
  const file = await db.file(id);
  if (!rec || !file) {
    toast('That book’s file is missing');
    shelf?.putBack();
    return;
  }
  const prefs = await loadPrefs();
  app.classList.add('is-reading');
  const r = new Reader(rec, prefs, (updated) => {
    reader = null;
    app.classList.remove('is-reading');
    shelf?.putBack();
    void refresh(updated.id);
  });
  reader = r;
  try {
    await r.open(file);
  } catch (e) {
    console.error(e);
    toast('Sorry — this book couldn’t be opened');
    r.close();
  }
}

/* --------------------------------------------------------------- import */

async function addFiles(files: File[], openFirst = false) {
  if (!files.length) return;
  toast(files.length === 1 ? `Adding “${files[0]!.name}”…` : `Adding ${files.length} books…`, 1800);
  let firstId: string | undefined;
  let added = 0;
  const failed: string[] = [];
  for (const f of files) {
    const r = await importFile(f);
    if (r.book) {
      firstId ??= r.book.id;
      if (!r.duplicate) added++;
    } else failed.push(r.name);
  }
  await refresh(firstId);
  if (failed.length) toast(failed.length === 1 ? `Couldn’t read “${failed[0]}”` : `${failed.length} files couldn’t be read`, 3200);
  else if (added) toast(added === 1 ? 'Added to your shelf' : `${added} books added`);
  else if (firstId) toast('Already on your shelf');
  if (openFirst && firstId) void openReader(firstId);
}

fileInput.addEventListener('change', () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  void addFiles(files);
});

// Desktop: drop files anywhere.
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  app.classList.add('is-dropping');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) app.classList.remove('is-dropping');
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('is-dropping');
  void addFiles([...(e.dataTransfer?.files ?? [])]);
});

/* -------------------------------------------------------------- actions */

app.addEventListener('click', async (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
  if (!a) return;
  if (a === 'add') fileInput.click();
  else if (a === 'read' && current) void openReader(current.id);
  else if (a === 'find') openAllBooks();
  else if (a === 'remove' && current) {
    const b = current;
    const ok = await confirmSheet('Remove book?', `“${b.title}” and its highlights will be removed from Glossa. The original file is not affected.`, 'Remove', true);
    if (!ok) return;
    await db.removeBook(b.id);
    const i = books.findIndex((x) => x.id === b.id);
    await refresh(books[i + 1]?.id ?? books[i - 1]?.id);
    toast('Removed');
  }
});

/** Every book as a searchable grid of covers — handy for big libraries. */
function openAllBooks() {
  const urls: string[] = [];
  const s = new Sheet({ className: 'sheet--tall sheet--all', onClose: () => urls.forEach(URL.revokeObjectURL) });
  s.body.innerHTML = `<form class="search"><input class="field" type="search" placeholder="Find by title or author" autocomplete="off"></form><ol class="grid"></ol>`;
  const grid = s.body.querySelector<HTMLElement>('.grid')!;
  const input = s.body.querySelector('input')!;
  const render = (q: string) => {
    const needle = q.trim().toLowerCase();
    const list = books.filter((b) => !needle || `${b.title} ${b.author}`.toLowerCase().includes(needle));
    grid.innerHTML = '';
    for (const b of list) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'tile';
      btn.dataset.id = b.id;
      btn.style.setProperty('--tone', b.color);
      if (b.cover) {
        const u = URL.createObjectURL(b.cover);
        urls.push(u);
        btn.innerHTML = `<img class="tile__img" alt="" loading="lazy" decoding="async" src="${u}">`;
      } else {
        btn.innerHTML = `<span class="tile__img tile__img--plain"><span></span></span>`;
        btn.querySelector('.tile__img--plain span')!.textContent = b.title;
      }
      const meta = document.createElement('span');
      meta.className = 'tile__meta';
      meta.innerHTML = `<span class="tile__title"></span><span class="tile__sub"></span>`;
      meta.firstElementChild!.textContent = b.title;
      meta.lastElementChild!.textContent = `${FORMAT_LABEL[b.format]}${b.progress ? ` · ${Math.round(b.progress * 100)}%` : ''}`;
      btn.append(meta);
      li.append(btn);
      grid.append(li);
    }
    if (!list.length) grid.innerHTML = `<li class="empty-note">No books match.</li>`;
  };
  input.addEventListener('input', () => render(input.value));
  s.body.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    input.blur();
  });
  grid.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
    if (!id) return;
    s.close();
    if (shelf) shelf.center(id);
    void openReader(id);
  });
  render('');
  s.open();
}

/** Without WebGL the shelf is a plain row of covers. */
function renderFallback() {
  stage.classList.add('is-flat');
  let row = stage.querySelector<HTMLElement>('.flat');
  if (!row) {
    row = document.createElement('ol');
    row.className = 'flat';
    stage.append(row);
    row.addEventListener('click', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) void openReader(id);
    });
    row.addEventListener('scroll', () => {
      const mid = row!.scrollLeft + row!.clientWidth / 2;
      const el = [...row!.children].find((c) => (c as HTMLElement).offsetLeft + (c as HTMLElement).offsetWidth > mid) as HTMLElement | undefined;
      const b = books.find((x) => x.id === el?.dataset.id);
      if (b && b.id !== current?.id) showCard(toShelf(b));
    }, { passive: true });
  }
  row.innerHTML = books
    .map((b) => `<li data-id="${b.id}" class="flat__book" style="--tone:${b.color}"><span></span></li>`)
    .join('');
  row.querySelectorAll('li span').forEach((el, i) => (el.textContent = books[i]!.title));
  showCard(books[0] ? toShelf(books[0]) : null);
}

/* ----------------------------------------------------------------- boot */

native.onBack(() => {
  if (closeTopSheet()) return;
  if (reader?.back()) return;
  void native.exit();
});
native.onVolumeKey((dir) => reader?.onVolumeKey(dir));
native.onFiles((files) => {
  reader?.close();
  void addFiles(files, true);
});

async function boot() {
  await seedSample();
  if (supportsWebGL()) {
    try {
      shelf = await createBookshelf(stage, {
        onCenter: showCard,
        onOpen: (b) => void openReader(b.id),
      });
    } catch (e) {
      console.warn('WebGL shelf unavailable', e);
      shelf = null;
    }
  }
  await refresh();
  document.documentElement.classList.add('is-ready');
  if (isNative) void native.statusStyle(matchMedia('(prefers-color-scheme: dark)').matches);
}

void boot();

// Ask the browser to keep the library even under storage pressure.
void navigator.storage?.persist?.().catch(() => undefined);
