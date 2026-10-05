import * as THREE from 'three';

/**
 * The library as a 3D bookshelf: solid cloth-bound books on a wooden shelf.
 *
 * Each book is dressed from its own cover: the front board is the cover,
 * and the spine is made from the cover's edge — its colours and artwork,
 * softened, with the title set in whichever of light or dark reads best on
 * it. Books without a cover get a cloth binding in a colour from their
 * title. Cream page edges top and fore-edge; light and shade are painted
 * in, so no lights are needed and every frame is cheap.
 *
 * Swipe sideways to slide the shelf (it carries momentum and settles on a
 * book); the middle book rises a little and is described under the shelf.
 * Tap a book and it comes off the shelf and turns its cover to you; tap it
 * again to open it. Tap elsewhere, swipe, or press back to put it back.
 *
 * Only the books near the view exist in the scene, and frames are drawn
 * only while something moves, so a library of thousands costs the same as
 * a dozen and an idle shelf costs nothing.
 */

export type ShelfBook = {
  id: string;
  title: string;
  author: string;
  color: string;
  cover?: Blob;
  progress?: number;
  size: number;
};

export type BookshelfOptions = {
  /** The book in the middle of the shelf changed. */
  onCenter: (book: ShelfBook | null) => void;
  /** A book was pulled out (or put back: null). */
  onPick: (book: ShelfBook | null) => void;
  /** The pulled-out book was tapped again. */
  onOpen: (book: ShelfBook) => void;
};

type Slot = {
  book: ShelfBook;
  index: number;
  h: number;
  t: number;
  x: number;
  style: number;
  tone: string;
};

type Volume = {
  slot: Slot;
  mesh: THREE.Mesh;
  mats: THREE.MeshBasicMaterial[];
  shadow: THREE.Mesh;
  pos: THREE.Vector3;
  rot: THREE.Euler;
};

const DEPTH = 1.5;
const GAP = 0.025;
const FOV = 30;
const LOOK_Y = 1.15;
const SERIF = '"Literata Variable", Literata, Georgia, serif';
const SANS = '"Inter Variable", Inter, system-ui, sans-serif';

export function supportsWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export async function createBookshelf(stage: HTMLElement, options: BookshelfOptions) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  await Promise.race([
    Promise.all([document.fonts.load(`600 64px ${SERIF}`), document.fonts.load(`600 20px ${SANS}`)]),
    new Promise((r) => setTimeout(r, 1200)),
  ]).catch(() => undefined);

  /* ------------------------------------------------------------ renderer */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const canvas = renderer.domElement;
  canvas.className = 'shelf__gl';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'listbox');
  canvas.setAttribute('aria-label', 'Your books. Swipe or use the arrow keys to browse, Enter to take a book out and Enter again to open it.');
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);

  const pivot = new THREE.Group(); // turns with the swipe
  const row = new THREE.Group(); // slides under it
  pivot.add(row);
  scene.add(pivot);

  const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const softTex = tex(paintSoft(document.createElement('canvas')), anisotropy);
  const flatGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  /* -------------------------------------------------------------- state */
  let slots: Slot[] = [];
  let totalW = 0;
  const live = new Map<string, Volume>();
  const spineCache = new Map<string, THREE.CanvasTexture>(); // LRU by insertion
  const faceCache = new Map<string, THREE.CanvasTexture>();
  // Decoded cover thumbnails and their front-board textures, by book.
  const bitmaps = new Map<string, Promise<ImageBitmap | null>>();
  const covers = new Map<string, THREE.CanvasTexture>();
  let dark = isDark();

  let scroll = 0; // world x under the centre of the view
  let target = 0;
  let vel = 0; // world units per second, for the sway and the fling
  let swayY = 0;
  let centered = -1;
  let focused: Volume | null = null;
  let hovered: Volume | null = null;
  let camDist = 12;
  let halfW = 3;
  let raf = 0;

  /* -------------------------------------------------------------- shelf */
  const woodTex = tex(paintWood(document.createElement('canvas'), dark), anisotropy);
  woodTex.wrapS = THREE.RepeatWrapping;
  const plankH = 0.18;
  const woodMat = new THREE.MeshBasicMaterial({ map: woodTex });
  const woodTop = new THREE.MeshBasicMaterial({ map: woodTex, color: 0xf2e6d8 });
  const woodSide = new THREE.MeshBasicMaterial({ map: woodTex, color: 0x9a8a7a });
  // Faces: +x, -x, +y (top, lit), -y, +z (front edge), -z.
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(1, plankH, DEPTH + 0.4), [woodSide, woodSide, woodTop, woodSide, woodMat, woodSide]);
  ledge.position.set(0, -plankH / 2, 0.05);
  const shadowMat = new THREE.MeshBasicMaterial({ map: softTex, color: 0x2a1a10, transparent: true, depthWrite: false, opacity: 0.28 });
  const ledgeShadow = new THREE.Mesh(flatGeo, shadowMat);
  ledgeShadow.position.y = -0.6;
  row.add(ledge, ledgeShadow);

  /* ------------------------------------------------------------- layout */
  function layoutSlots(books: ShelfBook[]) {
    let x = 0;
    slots = books.map((book, index) => {
      const r = rand(book.id);
      const h = 2.0 + r() * 0.55;
      // Bigger files make (somewhat) thicker books.
      const heft = Math.min(1, Math.log10(Math.max(book.size, 1e4) / 1e4) / 3);
      const t = 0.36 + heft * 0.16 + r() * 0.1;
      const style = Math.floor(r() * 3);
      x += t / 2;
      const slot = { book, index, h, t, x, style, tone: vivid(book.color, r()) };
      x += t / 2 + GAP;
      return slot;
    });
    totalW = Math.max(0, x - GAP);
    const lw = totalW + 1.0;
    ledge.scale.x = lw;
    ledge.position.x = totalW / 2;
    woodTex.repeat.set(Math.max(1, lw / 4), 1);
    ledgeShadow.scale.set(lw + 1.2, 1, DEPTH + 1.4);
    ledgeShadow.position.x = totalW / 2;
    ledge.visible = ledgeShadow.visible = slots.length > 0;
  }

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // About 4.3 world units across on a phone, more on wider screens,
    // and always the full height of a book with room above it.
    const want = THREE.MathUtils.clamp(w / 88, 4.3, 11);
    camDist = Math.max(want / 2 / (tanHalf * camera.aspect), 2.2 / tanHalf);
    halfW = camDist * tanHalf * camera.aspect;
    camera.position.set(0, LOOK_Y + 1.1, camDist);
    camera.lookAt(0, LOOK_Y, 0);
    camera.updateProjectionMatrix();
    wake();
  };
  new ResizeObserver(resize).observe(stage);

  /* ------------------------------------------------------------ volumes */
  function faceTex(kind: 'pages' | 'board', tone: string) {
    const key = `${kind}|${tone}`;
    let t = faceCache.get(key);
    if (!t) {
      const c = document.createElement('canvas');
      if (kind === 'pages') paintPages(c, tone);
      else paintBoard(c, tone);
      t = tex(c, anisotropy);
      faceCache.set(key, t);
    }
    return t;
  }

  function bitmap(book: ShelfBook) {
    let p = bitmaps.get(book.id);
    if (!p) {
      p = book.cover ? createImageBitmap(book.cover).catch(() => null) : Promise.resolve(null);
      bitmaps.set(book.id, p);
      // Keep a bounded number decoded.
      while (bitmaps.size > 120) {
        const [k, old] = bitmaps.entries().next().value as [string, Promise<ImageBitmap | null>];
        if (live.has(k)) break;
        bitmaps.delete(k);
        void old.then((b) => b?.close());
        covers.get(k)?.dispose();
        covers.delete(k);
      }
    }
    return p;
  }

  function coverTex(slot: Slot, img: ImageBitmap) {
    let t = covers.get(slot.book.id);
    if (!t) {
      t = tex(paintCover(document.createElement('canvas'), slot, img), anisotropy);
      covers.set(slot.book.id, t);
    }
    return t;
  }

  /** Swaps the plain faces for ones made from the book's cover, once it's decoded. */
  async function dress(v: Volume) {
    const slot = v.slot;
    const img = await bitmap(slot.book);
    if (!img || v.slot !== slot || !live.has(slot.book.id)) return;
    v.mats[0]!.map = coverTex(slot, img);
    v.mats[4]!.map = spineTex(slot, img);
    v.mats[0]!.needsUpdate = v.mats[4]!.needsUpdate = true;
    wake();
  }

  function spineTex(slot: Slot, img?: ImageBitmap) {
    const key = `${slot.book.id}|${slot.book.title}|${slot.tone}|${Math.round((slot.book.progress ?? 0) * 100)}|${img ? 'c' : 'p'}`;
    let t = spineCache.get(key);
    if (t) {
      spineCache.delete(key);
      spineCache.set(key, t);
      return t;
    }
    t = tex(img ? paintCoverSpine(document.createElement('canvas'), slot, img) : paintSpine(document.createElement('canvas'), slot), anisotropy);
    spineCache.set(key, t);
    while (spineCache.size > 90) {
      const [k, old] = spineCache.entries().next().value as [string, THREE.CanvasTexture];
      if ([...live.values()].some((v) => v.mats[4]!.map === old)) break;
      old.dispose();
      spineCache.delete(k);
    }
    return t;
  }

  const pool: Volume[] = [];

  function mount(slot: Slot): Volume {
    let v = pool.pop();
    if (!v) {
      const mats = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial());
      const mesh = new THREE.Mesh(unitBox, mats);
      const shadow = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({ map: softTex, color: 0x1a0f08, transparent: true, depthWrite: false, opacity: 0.4 }));
      shadow.position.y = 0.003;
      v = { slot, mesh, mats, shadow, pos: new THREE.Vector3(), rot: new THREE.Euler() };
    }
    v.slot = slot;
    const pages = faceTex('pages', slot.tone);
    const board = faceTex('board', slot.tone);
    // Faces: +x front cover, -x back cover, +y top (pages), -y bottom,
    // +z spine, -z fore-edge (pages).
    const maps = [board, board, pages, board, spineTex(slot), pages];
    v.mats.forEach((m, i) => {
      m.map = maps[i]!;
      m.needsUpdate = true;
    });
    v.mesh.scale.set(slot.t, slot.h, DEPTH);
    v.mesh.userData.id = slot.book.id;
    v.shadow.scale.set(slot.t + 0.5, 1, DEPTH + 0.4);
    v.pos.set(slot.x, 0, 0);
    v.rot.set(0, 0, 0);
    v.mesh.position.copy(v.pos);
    v.mesh.rotation.set(0, 0, 0);
    v.shadow.position.x = slot.x;
    row.add(v.mesh, v.shadow);
    live.set(slot.book.id, v);
    if (slot.book.cover) void dress(v);
    return v;
  }

  function unmount(v: Volume) {
    row.remove(v.mesh, v.shadow);
    live.delete(v.slot.book.id);
    pool.push(v);
  }

  /** Mounts the books near the view and lets the rest go. */
  function cull() {
    if (!slots.length) {
      for (const v of [...live.values()]) unmount(v);
      return;
    }
    const lo = scroll - halfW - 2.2;
    const hi = scroll + halfW + 2.2;
    let i = lowerBound(slots, lo);
    const want = new Set<string>();
    for (; i < slots.length && slots[i]!.x <= hi; i++) want.add(slots[i]!.book.id);
    if (focused) want.add(focused.slot.book.id);
    for (const v of [...live.values()]) if (!want.has(v.slot.book.id)) unmount(v);
    for (const id of want) if (!live.has(id)) mount(slots.find((s) => s.book.id === id)!);
  }

  function nearest(x: number) {
    if (!slots.length) return -1;
    let i = lowerBound(slots, x);
    if (i >= slots.length) i = slots.length - 1;
    if (i > 0 && Math.abs(slots[i - 1]!.x - x) < Math.abs(slots[i]!.x - x)) i--;
    return i;
  }

  const clampScroll = (x: number) => (slots.length ? THREE.MathUtils.clamp(x, slots[0]!.x, slots[slots.length - 1]!.x) : 0);

  /* -------------------------------------------------------- interaction */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number; t: number; id: number } | null = null;
  let lastX = 0;
  let lastT = 0;
  let dragging = false;

  const worldPerPx = () => (2 * halfW) / Math.max(1, canvas.clientWidth);

  const pick = (e: PointerEvent): Volume | null => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects([...live.values()].map((v) => v.mesh), false)[0];
    return hit ? live.get(hit.object.userData.id as string) ?? null : null;
  };

  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    lastX = e.clientX;
    lastT = down.t;
    vel = 0;
    target = scroll;
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!down) {
      if (e.pointerType === 'mouse') {
        const v = pick(e);
        if (v !== hovered) {
          hovered = v;
          canvas.style.cursor = v ? 'pointer' : 'grab';
          wake();
        }
      }
      return;
    }
    const now = performance.now();
    if (!dragging && Math.abs(e.clientX - down.x) > 6) {
      dragging = true;
      // Sliding the shelf puts a pulled-out book back.
      if (focused) putBack();
    }
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dt = Math.max(1, now - lastT) / 1000;
    let next = scroll - dx * worldPerPx();
    // Rubber-band past the ends.
    const c = clampScroll(next);
    if (c !== next) next = c + (next - c) * 0.35;
    const instant = (next - scroll) / dt;
    vel = vel * 0.6 + instant * 0.4;
    scroll = target = next;
    lastX = e.clientX;
    lastT = now;
    canvas.classList.add('is-dragging');
    wake();
  });

  const release = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return;
    const wasDrag = dragging;
    const quick = performance.now() - down.t < 500;
    down = null;
    dragging = false;
    canvas.classList.remove('is-dragging');
    if (!wasDrag && quick && e.type === 'pointerup') {
      tap(pick(e));
      return;
    }
    // Momentum: carry on in the direction of the fling, then settle on a book.
    if (performance.now() - lastT > 80) vel = 0;
    const thrown = scroll + vel * (reduced ? 0 : 0.32);
    const i = nearest(clampScroll(thrown));
    if (i >= 0) target = slots[i]!.x;
    wake();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => {
    if (hovered) {
      hovered = null;
      wake();
    }
  });

  /** First tap takes a book out; a second tap on it opens it. */
  function tap(v: Volume | null) {
    if (!v) {
      if (focused) putBack();
      return;
    }
    if (v === focused) {
      options.onOpen(v.slot.book);
      return;
    }
    void pullOut(v);
  }

  let wheelTimer = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (focused) putBack();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      scroll = target = clampScroll(scroll + d * worldPerPx() * 0.6);
      clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        const i = nearest(scroll);
        if (i >= 0) target = slots[i]!.x;
        wake();
      }, 140);
      wake();
    },
    { passive: false },
  );

  canvas.addEventListener('keydown', (e) => {
    if (!slots.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      if (focused) putBack();
      step(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Enter' && centered >= 0) {
      e.preventDefault();
      const v = live.get(slots[centered]!.book.id);
      if (v) tap(v);
    } else if (e.key === 'Escape' && focused) {
      e.preventDefault();
      putBack();
    }
  });

  function step(dir: number) {
    const i = THREE.MathUtils.clamp(nearest(target) + dir, 0, slots.length - 1);
    target = slots[i]!.x;
    wake();
  }

  /* -------------------------------------------------------- pull / put */
  async function pullOut(v: Volume) {
    focused = v;
    target = v.slot.x;
    hovered = null;
    stage.classList.add('has-pick');
    options.onPick(v.slot.book);
    wake();
    // A book without a cover image gets a painted one on its front board.
    if (!v.slot.book.cover && !v.mats[0]!.map?.userData.cover) {
      v.mats[0]!.map = plainCover(v.slot);
      v.mats[0]!.needsUpdate = true;
      wake();
    }
  }

  function plainCover(slot: Slot) {
    let t = covers.get(slot.book.id);
    if (!t) {
      t = tex(paintCover(document.createElement('canvas'), slot, null), anisotropy);
      t.userData.cover = true;
      covers.set(slot.book.id, t);
    }
    return t;
  }

  /** Puts the pulled-out book back on the shelf. */
  function putBack() {
    const v = focused;
    if (!v) return;
    focused = null;
    stage.classList.remove('has-pick');
    options.onPick(null);
    wake();
  }

  /* --------------------------------------------------------------- loop */
  // Frame timing: started on wake, stopped when the shelf comes to rest.
  let last = 0;
  let running = false;
  const tmpPos = new THREE.Vector3();
  const tmpRot = new THREE.Euler();

  function focusPose(v: Volume) {
    const portrait = camera.aspect < 1;
    const fill = portrait ? 0.7 : 0.78;
    const dist = v.slot.h / fill / 2 / tanHalf;
    const z = Math.max(DEPTH + 0.6, camDist - dist);
    // In the row's coordinates: in front of the centre of the view.
    return {
      pos: new THREE.Vector3(scroll, LOOK_Y + 0.6 - v.slot.h / 2, z),
      rot: new THREE.Euler(0.06, -Math.PI / 2 + 0.24, 0.015),
    };
  }

  const frame = () => {
    raf = 0;
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const k = (rate: number) => (reduced ? 1 : 1 - Math.exp(-dt * rate));
    let moving = dragging;

    if (!dragging) {
      const prev = scroll;
      scroll += (target - scroll) * k(9);
      vel = (scroll - prev) / Math.max(dt, 1e-3);
      if (Math.abs(target - scroll) > 1e-4) moving = true;
      else scroll = target;
    }
    row.position.x = -scroll;

    // The shelf turns a little with the swipe, which sells the depth.
    const wantSway = focused ? 0 : THREE.MathUtils.clamp(-vel * 0.012, -0.3, 0.3);
    swayY += (wantSway - swayY) * k(6);
    if (Math.abs(wantSway - swayY) > 1e-4) moving = true;
    pivot.rotation.y = swayY;

    cull();
    const c = nearest(scroll);
    if (c !== centered) {
      centered = c;
      if (!focused) options.onCenter(c >= 0 ? slots[c]!.book : null);
    }

    for (const v of live.values()) {
      const s = v.slot;
      if (v === focused) {
        const pose = focusPose(v);
        tmpPos.copy(pose.pos);
        tmpRot.copy(pose.rot);
      } else {
        const near = focused ? 0 : Math.max(0, 1 - Math.abs(s.x - scroll) / (s.t * 1.1 + 0.15));
        const lift = Math.max(near, v === hovered ? 0.8 : 0);
        tmpPos.set(s.x, lift * 0.18, lift * 0.2);
        tmpRot.set(-lift * 0.04, 0, 0);
      }
      const r = k(v === focused ? 7 : 12);
      const before = v.pos.x + v.pos.y + v.pos.z + v.rot.x + v.rot.y;
      v.pos.lerp(tmpPos, r);
      v.rot.x += (tmpRot.x - v.rot.x) * r;
      v.rot.y += (tmpRot.y - v.rot.y) * r;
      v.rot.z += (tmpRot.z - v.rot.z) * r;
      if (Math.abs(v.pos.x + v.pos.y + v.pos.z + v.rot.x + v.rot.y - before) > 1e-5) moving = true;
      v.mesh.position.copy(v.pos);
      v.mesh.rotation.copy(v.rot);
      v.shadow.visible = v !== focused;
    }

    renderer.render(scene, camera);
    if (moving) raf = requestAnimationFrame(frame);
    else running = false;
  };

  function wake() {
    if (raf) return;
    if (!running) {
      running = true;
      last = performance.now();
    }
    raf = requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------- theme */
  function applyTheme() {
    dark = isDark();
    paintWood(woodTex.image as HTMLCanvasElement, dark);
    woodTex.needsUpdate = true;
    shadowMat.opacity = dark ? 0.5 : 0.28;
    wake();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  resize();

  return {
    /** Replaces the books; keeps the view on `keepId` (or the current book). */
    setBooks(books: ShelfBook[], keepId?: string) {
      const current = keepId ?? (centered >= 0 ? slots[centered]?.book.id : undefined);
      if (focused) putBack();
      // A changed cover (or progress) means fresh textures for that book.
      const prev = new Map(slots.map((s) => [s.book.id, s.book]));
      for (const b of books) {
        const o = prev.get(b.id);
        if (o && o.cover !== b.cover) {
          bitmaps.delete(b.id);
          covers.get(b.id)?.dispose();
          covers.delete(b.id);
        }
      }
      for (const v of [...live.values()]) unmount(v);
      layoutSlots(books);
      const i = Math.max(0, slots.findIndex((s) => s.book.id === current));
      scroll = target = slots[i]?.x ?? 0;
      centered = slots.length ? i : -1;
      options.onCenter(slots[i]?.book ?? null);
      wake();
    },
    center(id: string) {
      const s = slots.find((x) => x.book.id === id);
      if (s) {
        target = s.x;
        wake();
      }
    },
    step,
    putBack,
    get picked() {
      return focused?.slot.book ?? null;
    },
    focus: () => canvas.focus({ preventScroll: true }),
  };
}

export type Bookshelf = Awaited<ReturnType<typeof createBookshelf>>;

/* ======================================================================
   Painting — every surface is drawn on a canvas, no image files.
   ====================================================================== */

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
}

function tex(c: HTMLCanvasElement, anisotropy: number) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function size(c: HTMLCanvasElement, w: number, h: number) {
  c.width = w;
  c.height = h;
  return c.getContext('2d')!;
}

/** A soft round shadow, opaque at the centre. */
function paintSoft(c: HTMLCanvasElement) {
  const ctx = size(c, 128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return c;
}

/* ---------------------------------------------------------------- colour */

function hsl(hex: string) {
  const c = new THREE.Color(hex);
  const o = { h: 0, s: 0, l: 0 };
  c.getHSL(o, THREE.SRGBColorSpace);
  return o;
}
const fromHsl = (h: number, s: number, l: number) => '#' + new THREE.Color().setHSL(h, s, l, THREE.SRGBColorSpace).getHexString();
const shade = (hex: string, k: number) => {
  const { h, s, l } = hsl(hex);
  return fromHsl(h, s, THREE.MathUtils.clamp(l * k, 0, 1));
};

/** Rich, bookish colours: a dull cover still makes a handsome spine. */
function vivid(hex: string, r: number) {
  const { h, s, l } = hsl(hex);
  // A grey cover gets a classic cloth colour instead.
  if (s < 0.12) {
    const cloth = ['#2f4a6e', '#7b2f36', '#2f5d4b', '#5b3a6b', '#8a5a2b', '#1f2f3f'];
    return cloth[Math.floor(r * cloth.length)]!;
  }
  return fromHsl(h, THREE.MathUtils.clamp(s * 1.25, 0.42, 0.75), THREE.MathUtils.clamp(l, 0.26, 0.46));
}

const isLight = (hex: string) => hsl(hex).l > 0.55;

/* ----------------------------------------------------------------- faces */

/** A little woven-cloth grain over everything painted so far. */
function cloth(ctx: CanvasRenderingContext2D, W: number, H: number, seed: number) {
  let a = seed >>> 0;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  ctx.save();
  ctx.globalAlpha = 0.05;
  for (let i = 0; i < (W * H) / 90; i++) {
    ctx.fillStyle = rnd() > 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1);
  }
  ctx.restore();
}

function paintSpine(c: HTMLCanvasElement, slot: Slot) {
  const H = 768;
  const W = Math.max(56, Math.round((H * slot.t) / slot.h));
  const ctx = size(c, W, H);
  const base = slot.tone;

  // A rounded spine: darker at the hinges, a soft highlight just off-centre.
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, shade(base, 0.62));
  g.addColorStop(0.18, shade(base, 0.95));
  g.addColorStop(0.38, shade(base, 1.18));
  g.addColorStop(0.62, base);
  g.addColorStop(0.88, shade(base, 0.82));
  g.addColorStop(1, shade(base, 0.6));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  cloth(ctx, W, H, slot.index * 7919 + 1);

  const gold = '#e9c77b';
  const ink = isLight(base) ? '#2a2118' : '#fbf3df';
  const accent = slot.style === 1 ? ink : gold;

  // Gilt bands at head and tail.
  const band = (y: number, h: number) => {
    const bg = ctx.createLinearGradient(0, y, 0, y + h);
    bg.addColorStop(0, '#f6dea0');
    bg.addColorStop(1, '#b8913f');
    ctx.fillStyle = slot.style === 1 ? ink : bg;
    ctx.globalAlpha = slot.style === 1 ? 0.55 : 1;
    ctx.fillRect(W * 0.08, y, W * 0.84, h);
    ctx.globalAlpha = 1;
  };
  if (slot.style !== 2) {
    band(54, 5);
    band(66, 2);
    band(H - 70, 2);
    band(H - 60, 5);
  } else {
    // A darker label panel with a fine gilt border.
    ctx.fillStyle = shade(base, 0.55);
    const ly = H * 0.17;
    const lh = H * 0.6;
    ctx.fillRect(W * 0.12, ly, W * 0.76, lh);
    ctx.strokeStyle = gold;
    ctx.lineWidth = 2;
    ctx.strokeRect(W * 0.17, ly + 6, W * 0.66, lh - 12);
  }

  // Progress at the head of the spine.
  const p = slot.book.progress ?? 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  if (p > 0.995) {
    ctx.font = `700 ${Math.round(W * 0.26)}px ${SANS}`;
    ctx.fillText('✓', W / 2, 30);
  } else if (p >= 0.01) {
    ctx.font = `700 ${Math.round(W * 0.2)}px ${SANS}`;
    ctx.fillText(`${Math.round(p * 100)}%`, W / 2, 30);
  }

  // Title along the spine, read top to bottom; author below it.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 2);
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1;
  const author = slot.book.author.split(/[,;&]/)[0]!.trim();
  const titleLen = author ? H * 0.5 : H * 0.66;
  const titleCentre = author ? -H * 0.08 : 0;
  ctx.fillStyle = slot.style === 2 ? gold : ink;
  const px = fit(ctx, slot.book.title, (n) => `600 ${n}px ${SERIF}`, Math.round(W * 0.4), titleLen);
  ctx.font = `600 ${px}px ${SERIF}`;
  ctx.fillText(ellipsize(ctx, slot.book.title, titleLen), titleCentre, 1);
  if (author) {
    ctx.fillStyle = slot.style === 2 ? ink : accent;
    ctx.globalAlpha = 0.9;
    ctx.font = `600 ${Math.round(W * 0.17)}px ${SANS}`;
    const surname = author.split(/\s+/).pop()!.toUpperCase();
    ctx.fillText(ellipsize(ctx, surname, H * 0.2), H * 0.3, 1);
  }
  ctx.restore();
  return c;
}

/** Cream page edges between two thin strips of the cover boards. */
function paintPages(c: HTMLCanvasElement, tone: string) {
  const W = 96;
  const H = 192;
  const ctx = size(c, W, H);
  ctx.fillStyle = '#f1e8d4';
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.18;
  for (let x = 8; x < W - 8; x += 2) {
    ctx.fillStyle = (x / 2) % 3 ? '#b9a98a' : '#ffffff';
    ctx.fillRect(x, 0, 1, H);
  }
  ctx.globalAlpha = 1;
  const edge = ctx.createLinearGradient(0, 0, W, 0);
  edge.addColorStop(0, 'rgba(120,95,60,0.25)');
  edge.addColorStop(0.15, 'rgba(120,95,60,0)');
  edge.addColorStop(0.85, 'rgba(120,95,60,0)');
  edge.addColorStop(1, 'rgba(120,95,60,0.25)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = shade(tone, 0.8);
  ctx.fillRect(0, 0, 7, H);
  ctx.fillRect(W - 7, 0, 7, H);
  return c;
}

/** The side boards: the book's colour in shade, with a little cloth. */
function paintBoard(c: HTMLCanvasElement, tone: string) {
  const W = 128;
  const H = 192;
  const ctx = size(c, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, shade(tone, 0.86));
  g.addColorStop(1, shade(tone, 0.68));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  cloth(ctx, W, H, tone.length * 131);
  return c;
}

/** Warm wood with a grain, darker in the dark theme. */
function paintWood(c: HTMLCanvasElement, dark: boolean) {
  const W = 1024;
  const H = 96;
  const ctx = size(c, W, H);
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, dark ? '#5a3a24' : '#b07a4c');
  g.addColorStop(1, dark ? '#3e2716' : '#8a5a34');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  let a = 12345;
  const rnd = () => ((a = (a * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 70; i++) {
    const y = rnd() * H;
    ctx.strokeStyle = rnd() > 0.5 ? 'rgba(60,30,10,0.22)' : 'rgba(255,220,170,0.12)';
    ctx.lineWidth = 0.6 + rnd() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= W; x += 64) ctx.lineTo(x, y + Math.sin(x / (90 + rnd() * 60) + i) * (1 + rnd() * 3));
    ctx.stroke();
  }
  return c;
}

function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, start: number, max: number) {
  let px = start;
  ctx.font = font(px);
  while (ctx.measureText(text).width > max && px > 12) {
    px -= 2;
    ctx.font = font(px);
  }
  return px;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s.trimEnd() + '…';
}

/** The front board: the cover itself, or a painted cloth one. */
function paintCover(c: HTMLCanvasElement, slot: Slot, img: ImageBitmap | null) {
  const W = 512;
  const H = Math.round((W * slot.h) / DEPTH);
  const ctx = size(c, W, H);
  if (img) {
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s;
    const h = img.height * s;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    // The hinge, so it still reads as a bound book.
    const hinge = ctx.createLinearGradient(0, 0, 36, 0);
    hinge.addColorStop(0, 'rgba(0,0,0,0.35)');
    hinge.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hinge;
    ctx.fillRect(0, 0, 36, H);
    return c;
  }
  const base = slot.tone;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, shade(base, 1.1));
  g.addColorStop(1, shade(base, 0.8));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  cloth(ctx, W, H, 99);
  ctx.strokeStyle = '#e9c77b';
  ctx.lineWidth = 3;
  ctx.strokeRect(32, 32, W - 64, H - 64);
  const ink = isLight(base) ? '#2a2118' : '#fbf3df';
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.font = `600 54px ${SERIF}`;
  const lines = wrapLines(ctx, slot.book.title, W - 120).slice(0, 5);
  let y = H * 0.36 - (lines.length - 1) * 30;
  for (const line of lines) {
    ctx.fillText(line, W / 2, y);
    y += 64;
  }
  if (slot.book.author) {
    ctx.fillStyle = '#e9c77b';
    ctx.font = `600 22px ${SANS}`;
    ctx.fillText(ellipsize(ctx, slot.book.author.toUpperCase(), W - 120), W / 2, H * 0.8);
  }
  return c;
}

/**
 * A spine made from the cover: the cover's left edge, stretched across the
 * spine and softened, so the book wears its own colours and artwork; then
 * rounded with light and shade, and titled in light or dark, whichever
 * reads on it.
 */
function paintCoverSpine(c: HTMLCanvasElement, slot: Slot, img: ImageBitmap) {
  const H = 768;
  const W = Math.max(56, Math.round((H * slot.t) / slot.h));
  const ctx = size(c, W, H);

  // The cover's edge strip, blurred into the spine.
  const strip = Math.max(8, Math.round(img.width * 0.1));
  ctx.filter = 'blur(9px) saturate(1.1)';
  ctx.drawImage(img, 0, 0, strip, img.height, -8, -8, W + 16, H + 16);
  ctx.filter = 'none';

  // How light is it behind the title? Decides the type colour.
  const probe = ctx.getImageData(Math.floor(W * 0.25), Math.floor(H * 0.2), Math.max(1, Math.floor(W * 0.5)), Math.floor(H * 0.6)).data;
  let lum = 0;
  for (let i = 0; i < probe.length; i += 16) lum += 0.2126 * probe[i]! + 0.7152 * probe[i + 1]! + 0.0722 * probe[i + 2]!;
  lum /= (probe.length / 16) * 255;
  const light = lum > 0.58;
  // A veil evens out busy artwork so the title always reads.
  ctx.fillStyle = light ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.22)';
  ctx.fillRect(0, 0, W, H);

  // Round it: darker at the hinges, a soft sheen just off-centre.
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.42)');
  g.addColorStop(0.2, 'rgba(0,0,0,0.04)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.16)');
  g.addColorStop(0.6, 'rgba(255,255,255,0)');
  g.addColorStop(0.86, 'rgba(0,0,0,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const ink = light ? '#1d1a16' : '#fdfaf3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ink;

  const p = slot.book.progress ?? 0;
  if (p > 0.995) {
    ctx.font = `700 ${Math.round(W * 0.26)}px ${SANS}`;
    ctx.fillText('✓', W / 2, 30);
  } else if (p >= 0.01) {
    ctx.font = `700 ${Math.round(W * 0.2)}px ${SANS}`;
    ctx.fillText(`${Math.round(p * 100)}%`, W / 2, 30);
  }

  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 2);
  ctx.shadowColor = light ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 4;
  const author = slot.book.author.split(/[,;&]/)[0]!.trim();
  const titleLen = author ? H * 0.56 : H * 0.72;
  const px = fit(ctx, slot.book.title, (n) => `650 ${n}px ${SERIF}`, Math.round(W * 0.42), titleLen);
  ctx.font = `650 ${px}px ${SERIF}`;
  ctx.fillText(ellipsize(ctx, slot.book.title, titleLen), author ? -H * 0.07 : 0, 1);
  if (author) {
    ctx.globalAlpha = 0.85;
    ctx.font = `600 ${Math.round(W * 0.17)}px ${SANS}`;
    const surname = author.split(/\s+/).pop()!.toUpperCase();
    ctx.fillText(ellipsize(ctx, surname, H * 0.2), H * 0.33, 1);
  }
  ctx.restore();
  return c;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, max: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > max && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function lowerBound(slots: Slot[], x: number) {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid]!.x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rand(seed: string) {
  let a = 0;
  for (const ch of seed) a = Math.imul(a ^ ch.charCodeAt(0), 2654435761);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
