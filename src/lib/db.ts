/**
 * The library lives in IndexedDB: book records (small, read all at once for
 * the shelf), the files themselves as Blobs (read only when a book opens),
 * and notes — highlights and bookmarks — keyed by book.
 */

export type Format = 'epub' | 'pdf' | 'mobi' | 'azw3' | 'fb2' | 'cbz' | 'txt' | 'html' | 'md';

export type BookRecord = {
  id: string;
  title: string;
  author: string;
  format: Format;
  size: number;
  /** A small JPEG of the cover, if the book has one. */
  cover?: Blob;
  /** The spine's colour, taken from the cover or derived from the title. */
  color: string;
  addedAt: number;
  openedAt?: number;
  /** Reading position (CFI) and progress 0–1. */
  location?: string;
  progress?: number;
  /** Per-book reader overrides, e.g. PDF zoom. */
  prefs?: Record<string, unknown>;
};

export type Note = {
  id: string;
  bookId: string;
  kind: 'highlight' | 'bookmark';
  cfi: string;
  text: string;
  color?: string;
  label?: string;
  createdAt: number;
};

let dbp: Promise<IDBDatabase> | null = null;

function open() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('glossa', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('books', { keyPath: 'id' });
      db.createObjectStore('files');
      db.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function wrap<T>(req: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export const db = {
  async books(): Promise<BookRecord[]> {
    return wrap((await store('books')).getAll());
  },
  async book(id: string): Promise<BookRecord | undefined> {
    return wrap((await store('books')).get(id));
  },
  async putBook(b: BookRecord) {
    await wrap((await store('books', 'readwrite')).put(b));
  },
  async patchBook(id: string, patch: Partial<BookRecord>) {
    const s = await store('books', 'readwrite');
    const cur = await wrap(s.get(id));
    if (cur) await wrap(s.put({ ...cur, ...patch }));
  },
  async file(id: string): Promise<Blob | undefined> {
    return wrap((await store('files')).get(id));
  },
  async putFile(id: string, blob: Blob) {
    await wrap((await store('files', 'readwrite')).put(blob, id));
  },
  async removeBook(id: string) {
    const d = await open();
    const tx = d.transaction(['books', 'files', 'notes'], 'readwrite');
    tx.objectStore('books').delete(id);
    tx.objectStore('files').delete(id);
    const notes = tx.objectStore('notes');
    const keys = await wrap(notes.index('bookId').getAllKeys(id));
    for (const k of keys) notes.delete(k);
    await new Promise<void>((res, rej) => {
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  },
  async notes(bookId: string): Promise<Note[]> {
    const list = await wrap((await store('notes')).index('bookId').getAll(bookId));
    return list.sort((a, b) => a.createdAt - b.createdAt);
  },
  async putNote(n: Note) {
    await wrap((await store('notes', 'readwrite')).put(n));
  },
  async removeNote(id: string) {
    await wrap((await store('notes', 'readwrite')).delete(id));
  },
  async get<T>(key: string): Promise<T | undefined> {
    return wrap((await store('kv')).get(key));
  },
  async set(key: string, value: unknown) {
    await wrap((await store('kv', 'readwrite')).put(value, key));
  },
};
