import * as THREE from 'three';

/**
 * The library as a WebGL bookshelf — the frosted-glass shelf from the
 * portfolio site, rebuilt as a browsing surface for any number of books.
 *
 * Every volume is frosted glass with a solid core of its colour blurred
 * inside, a bright rim and a glow beneath, its title set in white along the
 * spine. Swipe sideways to slide the shelf (it carries momentum and settles
 * on a book); the book in the middle rises a little and is described below
 * the shelf. Tap any book and it is pulled out, turned to show its cover,
 * and opened.
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
  onCenter: (book: ShelfBook | null) => void;
  onOpen: (book: ShelfBook) => void;
};

type Slot = {
  book: ShelfBook;
  index: number;
  h: number;
  t: number;
  x: number;
};

type Volume = {
  slot: Slot;
  mesh: THREE.Mesh;
  mats: THREE.MeshBasicMaterial[];
  edges: THREE.LineSegments;
  glow: THREE.Mesh;
  pos: THREE.Vector3;
  rot: THREE.Euler;
};

const DEPTH = 1.6;
const GAP = 0.035;
const FOV = 30;
const LOOK_Y = 1.15;
const SERIF = '"Instrument Serif", Georgia, serif';
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
    Promise.all([document.fonts.load(`64px ${SERIF}`), document.fonts.load(`500 20px ${SANS}`)]),
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
  canvas.setAttribute('aria-label', 'Your books. Swipe or use the arrow keys to browse, Enter to open.');
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
  const unitEdges = new THREE.EdgesGeometry(unitBox);
  const glowTex = tex(paintGlow(document.createElement('canvas')), anisotropy);
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  /* -------------------------------------------------------------- state */
  let slots: Slot[] = [];
  let totalW = 0;
  const live = new Map<string, Volume>();
  const spineCache = new Map<string, THREE.CanvasTexture>(); // LRU by insertion
  const glassCache = new Map<string, THREE.CanvasTexture>();
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

  /* -------------------------------------------------------------- ledge */
  const ledgeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.72 });
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, DEPTH + 0.35), ledgeMat);
  ledge.position.y = -0.05;
  const ledgeLineMat = new THREE.LineBasicMaterial({ color: 0xcfdaf0, transparent: true, opacity: 0.9 });
  const ledgeEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 0.1, DEPTH + 0.35)), ledgeLineMat);
  ledge.add(ledgeEdges);
  const shadowMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0x5a6f9e, transparent: true, depthWrite: false, opacity: 0.2 });
  const ledgeShadow = new THREE.Mesh(glowGeo, shadowMat);
  ledgeShadow.position.y = -0.34;
  row.add(ledge, ledgeShadow);

  /* ------------------------------------------------------------- layout */
  function layoutSlots(books: ShelfBook[]) {
    let x = 0;
    slots = books.map((book, index) => {
      const r = rand(book.id);
      const h = 2.0 + r() * 0.55;
      // Bigger files make (somewhat) thicker books.
      const heft = Math.min(1, Math.log10(Math.max(book.size, 1e4) / 1e4) / 3);
      const t = 0.34 + heft * 0.16 + r() * 0.1;
      x += t / 2;
      const slot = { book, index, h, t, x };
      x += t / 2 + GAP;
      return slot;
    });
    totalW = Math.max(0, x - GAP);
    const lw = totalW + 1.2;
    ledge.scale.x = lw;
    ledge.position.x = totalW / 2;
    ledgeShadow.scale.set(lw + 1.4, 1, DEPTH + 1.6);
    ledgeShadow.position.x = totalW / 2;
    ledge.visible = ledgeShadow.visible = slots.length > 0;
  }

  const resize = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Show about 5 world units across on a phone, more on wider screens,
    // and always the full height of a book with room above it.
    const want = THREE.MathUtils.clamp(w / 88, 4.3, 11);
    camDist = Math.max(want / 2 / (tanHalf * camera.aspect), 2.2 / tanHalf);
    halfW = camDist * tanHalf * camera.aspect;
    camera.position.set(0, LOOK_Y + 1.0, camDist);
    camera.lookAt(0, LOOK_Y, 0);
    camera.updateProjectionMatrix();
    wake();
  };
  new ResizeObserver(resize).observe(stage);

  /* ------------------------------------------------------------ volumes */
  function glassTex(color: string) {
    const key = `${color}|${dark}`;
    let t = glassCache.get(key);
    if (!t) {
      const c = document.createElement('canvas');
      paintGlass(c, 96, 160, color, dark);
      t = tex(c, anisotropy);
      glassCache.set(key, t);
    }
    return t;
  }

  function spineTex(slot: Slot) {
    const key = `${slot.book.id}|${dark}|${slot.book.title}`;
    let t = spineCache.get(key);
    if (t) {
      spineCache.delete(key);
      spineCache.set(key, t);
      return t;
    }
    t = tex(paintSpine(document.createElement('canvas'), slot, dark), anisotropy);
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
      const mats = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial({ transparent: true }));
      const mesh = new THREE.Mesh(unitBox, mats);
      const edges = new THREE.LineSegments(unitEdges, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9 }));
      edges.renderOrder = 2;
      const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, opacity: 0.5 }));
      glow.position.y = 0.004;
      mesh.add(edges);
      v = { slot, mesh, mats, edges, glow, pos: new THREE.Vector3(), rot: new THREE.Euler() };
    }
    v.slot = slot;
    const glass = glassTex(slot.book.color);
    // Faces: +x front cover, -x back, +y top, -y bottom, +z spine, -z fore-edge.
    v.mats.forEach((m, i) => {
      m.map = i === 4 ? spineTex(slot) : glass;
      m.needsUpdate = true;
    });
    v.mesh.scale.set(slot.t, slot.h, DEPTH);
    v.mesh.userData.id = slot.book.id;
    const tint = new THREE.Color(slot.book.color);
    (v.edges.material as THREE.LineBasicMaterial).color.copy(new THREE.Color(dark ? '#9aa3b8' : '#ffffff').lerp(tint, 0.45));
    (v.glow.material as THREE.MeshBasicMaterial).color.copy(tint);
    v.glow.scale.set(slot.t + 0.9, 1, DEPTH + 0.7);
    v.pos.set(slot.x, 0, 0);
    v.rot.set(0, 0, 0);
    v.mesh.position.copy(v.pos);
    v.mesh.rotation.set(0, 0, 0);
    v.glow.position.x = slot.x;
    row.add(v.mesh, v.glow);
    live.set(slot.book.id, v);
    return v;
  }

  function unmount(v: Volume) {
    row.remove(v.mesh, v.glow);
    live.delete(v.slot.book.id);
    // The cover map is the book's own; let it go.
    const cover = v.mats[0]!.map;
    if (cover && cover.userData.cover) cover.dispose();
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
  let down: { x: number; y: number; t: number; scroll: number; id: number } | null = null;
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
    if (focused) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), scroll, id: e.pointerId };
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
    if (!dragging && Math.abs(e.clientX - down.x) > 6) dragging = true;
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
    const quick = performance.now() - down.t < 450;
    down = null;
    dragging = false;
    canvas.classList.remove('is-dragging');
    if (!wasDrag && quick && e.type === 'pointerup') {
      const v = pick(e);
      if (v) open(v);
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

  let wheelTimer = 0;
  canvas.addEventListener(
    'wheel',
    (e) => {
      if (focused) return;
      e.preventDefault();
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
    if (focused || !slots.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      step(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'Enter' && centered >= 0) {
      e.preventDefault();
      const v = live.get(slots[centered]!.book.id);
      if (v) open(v);
    }
  });

  function step(dir: number) {
    const i = THREE.MathUtils.clamp(nearest(target) + dir, 0, slots.length - 1);
    target = slots[i]!.x;
    wake();
  }

  /* --------------------------------------------------------------- open */
  let openTimer = 0;
  async function open(v: Volume) {
    if (focused) return;
    focused = v;
    target = v.slot.x;
    hovered = null;
    stage.classList.add('is-opening');
    wake();
    // Its real cover on the front board, if the book has one.
    const coverTex = await coverTexture(v.slot, dark, anisotropy);
    if (focused === v) {
      v.mats[0]!.map = coverTex;
      v.mats[0]!.needsUpdate = true;
      wake();
    } else coverTex.dispose();
    clearTimeout(openTimer);
    openTimer = window.setTimeout(() => focused === v && options.onOpen(v.slot.book), reduced ? 60 : 620);
  }

  /** Puts the open book back on the shelf (called when the reader closes). */
  function putBack() {
    const v = focused;
    focused = null;
    stage.classList.remove('is-opening');
    if (v) {
      const glass = glassTex(v.slot.book.color);
      const cover = v.mats[0]!.map;
      v.mats[0]!.map = glass;
      v.mats[0]!.needsUpdate = true;
      if (cover && cover !== glass) cover.dispose();
    }
    wake();
  }

  /* --------------------------------------------------------------- loop */
  // Frame timing: started on wake, stopped when the shelf comes to rest.
  let last = 0;
  const clock = {
    running: false,
    start() {
      this.running = true;
      last = performance.now();
    },
    stop() {
      this.running = false;
    },
    getDelta() {
      const now = performance.now();
      const d = (now - last) / 1000;
      last = now;
      return d;
    },
  };
  const tmpPos = new THREE.Vector3();
  const tmpRot = new THREE.Euler();

  function focusPose(v: Volume) {
    const portrait = camera.aspect < 1;
    const fill = portrait ? 0.72 : 0.78;
    const dist = v.slot.h / fill / 2 / tanHalf;
    const z = Math.max(DEPTH + 0.6, camDist - dist);
    // In the row's coordinates: in front of the centre of the view.
    return {
      pos: new THREE.Vector3(scroll, LOOK_Y + 0.55 - v.slot.h / 2, z),
      rot: new THREE.Euler(0.05, -Math.PI / 2 + 0.22, 0.015),
    };
  }

  const frame = () => {
    raf = 0;
    const dt = Math.min(clock.getDelta(), 0.05);
    const k = (rate: number) => (reduced ? 1 : 1 - Math.exp(-dt * rate));
    let moving = dragging;

    if (!dragging) {
      // A critically damped approach to the resting book.
      const prev = scroll;
      scroll += (target - scroll) * k(9);
      vel = (scroll - prev) / Math.max(dt, 1e-3);
      if (Math.abs(target - scroll) > 1e-4) moving = true;
      else scroll = target;
    }
    row.position.x = -scroll;

    // The shelf turns a little with the swipe, which sells the depth.
    const wantSway = focused ? 0 : THREE.MathUtils.clamp(-vel * 0.012, -0.32, 0.32);
    swayY += (wantSway - swayY) * k(6);
    if (Math.abs(wantSway - swayY) > 1e-4) moving = true;
    pivot.rotation.y = swayY;

    cull();
    const c = nearest(scroll);
    if (c !== centered) {
      centered = c;
      options.onCenter(c >= 0 ? slots[c]!.book : null);
    }

    for (const v of live.values()) {
      const s = v.slot;
      if (v === focused) {
        const pose = focusPose(v);
        tmpPos.copy(pose.pos);
        tmpRot.copy(pose.rot);
      } else {
        const near = Math.max(0, 1 - Math.abs(s.x - scroll) / (s.t * 1.1 + 0.15));
        const lift = Math.max(near, v === hovered ? 0.8 : 0);
        tmpPos.set(s.x, lift * 0.2, lift * 0.22);
        tmpRot.set(-lift * 0.05, 0, 0);
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
      v.glow.visible = v !== focused;
    }

    renderer.render(scene, camera);
    if (moving) raf = requestAnimationFrame(frame);
    else clock.stop();
  };

  function wake() {
    if (raf) return;
    if (!clock.running) clock.start();
    raf = requestAnimationFrame(frame);
  }

  /* -------------------------------------------------------------- theme */
  function applyTheme() {
    dark = isDark();
    ledgeMat.color.set(dark ? '#2a2e3a' : '#ffffff');
    ledgeMat.opacity = dark ? 0.85 : 0.72;
    ledgeLineMat.color.set(dark ? '#4a5266' : '#cfdaf0');
    shadowMat.color.set(dark ? '#000000' : '#5a6f9e');
    shadowMat.opacity = dark ? 0.45 : 0.2;
    for (const v of [...live.values()]) {
      unmount(v);
    }
    for (const t of glassCache.values()) t.dispose();
    glassCache.clear();
    for (const t of spineCache.values()) t.dispose();
    spineCache.clear();
    wake();
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  resize();

  return {
    /** Replaces the books; keeps the view on `keepId` (or the current book). */
    setBooks(books: ShelfBook[], keepId?: string) {
      const current = keepId ?? (centered >= 0 ? slots[centered]?.book.id : undefined);
      // Drop textures for books whose look changed.
      const old = new Map(slots.map((s) => [s.book.id, s.book]));
      for (const v of [...live.values()]) unmount(v);
      for (const b of books) {
        const o = old.get(b.id);
        if (o && (o.title !== b.title || o.color !== b.color)) {
          for (const [k, t] of spineCache) if (k.startsWith(b.id + '|')) (t.dispose(), spineCache.delete(k));
        }
      }
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
    focus: () => canvas.focus({ preventScroll: true }),
    get centeredBook() {
      return centered >= 0 ? slots[centered]!.book : null;
    },
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

function paintGlow(c: HTMLCanvasElement) {
  const ctx = size(c, 128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return c;
}

/**
 * One face of frosted glass: milky translucent white (smoky in the dark)
 * with the solid core of `color` blurred behind it, a haze low down and a
 * bright rim along the top. The blur is a shadow cast from off-canvas,
 * which every browser's canvas can draw.
 */
function paintGlass(c: HTMLCanvasElement, W: number, H: number, color: string, dark: boolean) {
  const ctx = size(c, W, H);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = dark ? 'rgba(30,33,44,0.62)' : 'rgba(255,255,255,0.86)';
  ctx.fillRect(0, 0, W, H);

  const m = Math.min(W, H);
  const inset = m * 0.2;
  const blur = m * 0.16;
  const light = '#' + new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4).getHexString();
  const blob = (x: number, y: number, w: number, h: number, fill: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = fill;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetX = W * 4;
    ctx.fillStyle = fill;
    ctx.fillRect(x - W * 4, y, w, h);
    ctx.restore();
  };
  blob(inset, inset, W - inset * 2, H - inset * 2, color, 0.92);
  blob(inset, inset, W - inset * 2, (H - inset * 2) * 0.35, light, dark ? 0.45 : 0.7);

  const haze = ctx.createLinearGradient(0, H * 0.6, 0, H);
  haze.addColorStop(0, 'rgba(255,255,255,0)');
  haze.addColorStop(1, dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.4)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = dark ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)';
  ctx.fillRect(0, 0, W, Math.max(2, H * 0.005));
  return ctx;
}

function fit(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, start: number, max: number) {
  let px = start;
  ctx.font = font(px);
  while (ctx.measureText(text).width > max && px > 10) {
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

function paintSpine(c: HTMLCanvasElement, slot: Slot, dark: boolean) {
  const H = 768;
  const W = Math.max(48, Math.round((H * slot.t) / slot.h));
  const ctx = paintGlass(c, W, H, slot.book.color, dark);
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 6;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Progress, as a small mark at the head of the spine.
  const p = slot.book.progress ?? 0;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  if (p > 0.995) {
    ctx.font = `600 ${Math.round(W * 0.26)}px ${SANS}`;
    ctx.fillText('✓', W / 2, 46);
  } else if (p >= 0.01) {
    ctx.font = `600 ${Math.round(W * 0.2)}px ${SANS}`;
    ctx.fillText(`${Math.round(p * 100)}%`, W / 2, 46);
  } else {
    ctx.beginPath();
    ctx.arc(W / 2, 46, Math.max(3, W * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }

  // Title, set along the spine and read top to bottom; author below it.
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(Math.PI / 2);
  const author = slot.book.author.split(',')[0]!.trim();
  const titleLen = author ? H * 0.56 : H * 0.72;
  const titleCentre = author ? -H * 0.07 : H * 0.03;
  ctx.fillStyle = '#ffffff';
  const px = fit(ctx, slot.book.title, (n) => `${n}px ${SERIF}`, Math.round(W * 0.5), titleLen);
  ctx.font = `${px}px ${SERIF}`;
  ctx.fillText(ellipsize(ctx, slot.book.title, titleLen), titleCentre, 2);
  if (author) {
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.font = `500 ${Math.round(W * 0.2)}px ${SANS}`;
    ctx.fillText(ellipsize(ctx, author.toUpperCase(), H * 0.22), H * 0.34, 2);
  }
  ctx.restore();
  return c;
}

async function coverTexture(slot: Slot, dark: boolean, anisotropy: number) {
  const W = 640;
  const H = Math.round((W * slot.h) / DEPTH);
  const c = document.createElement('canvas');
  const ctx = paintGlass(c, W, H, slot.book.color, dark);
  const img = slot.book.cover ? await createImageBitmap(slot.book.cover).catch(() => null) : null;
  if (img) {
    // The cover, filling the board, under a thin glass rim.
    const s = Math.max(W / img.width, H / img.height);
    const w = img.width * s;
    const h = img.height * s;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    img.close();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  } else {
    ctx.shadowColor = 'rgba(0,0,0,0.16)';
    ctx.shadowBlur = 8;
    const left = 64;
    const right = W - 56;
    ctx.fillStyle = '#ffffff';
    ctx.font = `86px ${SERIF}`;
    let y = 220;
    for (const line of wrapLines(ctx, slot.book.title, right - left).slice(0, 5)) {
      ctx.fillText(line, left, y);
      y += 84;
    }
    if (slot.book.author) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `500 28px ${SANS}`;
      ctx.fillText(ellipsize(ctx, slot.book.author, right - left), left, y + 10);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(left, H - 110);
    ctx.lineTo(right, H - 110);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 24px ${SANS}`;
    ctx.fillText('Glossa', left, H - 64);
  }
  const t = tex(c, anisotropy);
  t.userData.cover = true;
  return t;
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
