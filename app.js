// Interactive stadium seat map built straight from the Figma export.
//
// Nothing about the layout is hardcoded: the SVG is fetched at runtime and the
// model is derived from its layer ids, so dropping in a re-export picks up the
// changes without touching this file.

const SVG_URL = "stadium_correct_size.svg";
const SVG_NS = "http://www.w3.org/2000/svg";

const MIN_SCALE = 1;
const MAX_SCALE = 24;
const LOD_ROWS = 3; // row letters appear from here
const LOD_SEATS = 6; // seat numbers appear from here
const SEAT_PICK_SCALE = 4; // below this a tap on a band zooms in instead of selecting
const TAP_SLOP_PX = 6; // pointer travel still counted as a tap
const TAP_MAX_MS = 500;
const MAX_SEATS = 10; // seats per order
const MAX_QTY = 10; // tickets per order when buying a section
const TOAST_MS = 2500;
const BAR_RESERVE_PX = 130; // room the floating bottom bar needs when it opens

/**
 * Zones, their colour, and what a ticket costs.
 *
 * Prices are set rather than generated — real ticket prices are decided, and a
 * random ladder can put the back floor above the front. Two things drive them:
 * the floor is picked seat-by-seat right at the stage, so it carries the
 * premium; the ring is sold by quantity and stays cheap. Within the ring the
 * order follows the tiers' mean distance from the `Stage` rect in the SVG —
 * D 688, C 750, B 869, E 1047, A 1563 user units.
 */
const ZONES = [
  { key: "floor-front", name: "Front Floor", color: "#f2545b", price: 100 },
  { key: "floor-mid", name: "Mid Floor", color: "#f2a03d", price: 80 },
  { key: "floor-back", name: "Back Floor", color: "#f7d154", price: 65 },
  { key: "tier-D", name: "Tier D", color: "#a56be8", price: 28 },
  { key: "tier-C", name: "Tier C", color: "#5b7cfa", price: 25 },
  { key: "tier-B", name: "Tier B", color: "#3bafda", price: 22 },
  { key: "tier-E", name: "Tier E", color: "#ee6fb1", price: 18 },
  { key: "tier-A", name: "Tier A", color: "#4cc38a", price: 14 },
];

// Fallback colours for a zone the SVG names but ZONES does not list.
const SPARE_COLORS = ["#7fd1c1", "#d9a066", "#8fa1b8", "#c98fd9"];
const FALLBACK_PRICE = 20;

const stage = document.getElementById("stage");
const stageMsg = document.getElementById("stage-msg");
const hint = document.getElementById("hint");
const legend = document.getElementById("legend");
const legendList = document.getElementById("legend-list");
const bottombar = document.getElementById("bottombar");
const bbQty = bottombar.querySelector(".bb-qty");
const bbChips = bottombar.querySelector(".bb-chips");
const toastEl = document.getElementById("toast");

/** @type {SVGSVGElement} */ let svg;
/** @type {SVGGElement} */ let labels;
const zones = new Map(); // key -> {key, name, color, price}
const items = new Map(); // data-id -> {id, label, zoneKey, kind, els[]}
const bandBoxes = new Map(); // zone key -> DOMRect, for tap-to-zoom

// The basket is either loose seats or a quantity in one section, never both:
// `kind` says which, `ids` holds seats in tap order (so chips keep that order)
// or the single section id, and `qty` applies to sections only.
const selection = { kind: null, ids: [], qty: 1 };

const view = { x: 0, y: 0, w: 0, h: 0 }; // current viewBox
const world = { w: 0, h: 0 }; // full extent of the export

/* ------------------------------------------------------------------ pricing */

// Deterministic PRNG, used for section stock. Availability that reshuffled on
// every refresh would be impossible to talk about with anyone.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildZones() {
  for (const zone of ZONES) zones.set(zone.key, { ...zone });
}

/**
 * Zone for `key`, inventing one if the SVG names something ZONES does not list.
 * Without this an unrecognised layer name would drop every shape under it
 * silently — a renamed Figma group should show up looking odd, not vanish.
 */
function zoneFor(key, fallbackName) {
  let zone = zones.get(key);
  if (!zone) {
    const spare =
      SPARE_COLORS[(zones.size - ZONES.length) % SPARE_COLORS.length];
    zone = { key, name: fallbackName, color: spare, price: FALLBACK_PRICE };
    zones.set(key, zone);
    console.warn(`unlisted zone "${key}" in the SVG — using a fallback colour`);
  }
  return zone;
}

const money = (n) => "$" + n.toLocaleString("en-US");

/**
 * Tickets still on sale in a section, 8..60.
 *
 * Seeded off a hash of the id, so each section's stock stands on its own and
 * cannot shift because something was added or reordered elsewhere.
 */
function availabilityFor(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 8 + Math.floor(mulberry32(h)() * 53);
}

/* -------------------------------------------------------------------- model */

function register(kind, id, label, zoneKey, el) {
  el.dataset.kind = kind;
  el.dataset.id = id;
  el.dataset.zone = zoneKey;
  el.style.fill = zones.get(zoneKey).color;

  let item = items.get(id);
  if (!item) {
    item = { id, label, zoneKey, kind, els: [] };
    items.set(id, item);
  }
  item.els.push(el);
  return item;
}

// Figma appends _2/_3/... to every layer whose name repeats anywhere in the
// file. Seat names 1..51 recur in all 15 rows, so a round-trip through Figma
// returns them as 1, 1_2, 1_3 and so on. The suffix carries no meaning — strip
// it to get back to the name the designer typed, which is what lets the SVG be
// re-exported without touching this file.
const baseName = (id) => id.replace(/_\d+$/, "");

function classify(root) {
  for (const child of Array.from(root.children)) {
    const id = child.getAttribute("id") || "";

    if (id.startsWith("seat:")) {
      classifySeatBand(child, id.slice(5));
    } else if (child.tagName.toLowerCase() === "path" && id) {
      classifySection(child, id);
    } else {
      // stadium bowl, pitch markings, outer stands, stage — backdrop only
      child.setAttribute("pointer-events", "none");
    }
  }
}

// A band (seat:Front) is a pricing zone, not part of the seat's name: rows are
// unique across the whole floor and each spans all 51 seats through the aisles,
// so the row letter alone places the seat. Hence A1..A51, not AA1/BA1/CA1.
function classifySeatBand(group, bandName) {
  const zoneKey = `floor-${bandName.toLowerCase()}`;
  zoneFor(zoneKey, `${bandName} Floor`);

  for (const row of Array.from(group.children)) {
    const rowLetter = baseName(row.getAttribute("id") || "");
    for (const seat of Array.from(row.children)) {
      const number = baseName(seat.getAttribute("id") || "");
      const label = `${rowLetter}${number}`;
      register("seat", label, label, zoneKey, seat);
    }
  }
}

function classifySection(path, rawId) {
  // D101 and D101-SMALL are two shapes of one section: same identity, same
  // colour, same price, and they highlight together.
  const id = rawId.replace(/-SMALL$/, "");
  const zoneKey = `tier-${id[0]}`;
  zoneFor(zoneKey, `Tier ${id[0]}`);
  register("section", id, id, zoneKey, path);
}

/* ------------------------------------------------------------------- labels */

// The bbox centre of a curved ring wedge often sits outside the wedge itself.
// Averaging points sampled along the outline lands inside the shape instead.
function outlineCentre(path) {
  const len =
    typeof path.getTotalLength === "function" ? path.getTotalLength() : 0;
  if (!len) {
    const box = path.getBBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  const samples = 64;
  let x = 0;
  let y = 0;
  for (let i = 0; i < samples; i++) {
    const p = path.getPointAtLength((len * i) / samples);
    x += p.x;
    y += p.y;
  }
  return { x: x / samples, y: y / samples };
}

function text(cls, x, y, content) {
  const el = document.createElementNS(SVG_NS, "text");
  el.setAttribute("class", cls);
  el.setAttribute("x", x);
  el.setAttribute("y", y);
  el.textContent = content;
  labels.appendChild(el);
  return el;
}

function buildLabels(root) {
  labels = document.createElementNS(SVG_NS, "g");
  labels.setAttribute("id", "labels");
  root.appendChild(labels);

  for (const item of items.values()) {
    if (item.kind !== "section") continue;
    // anchor on the biggest piece, so -SMALL companions never win
    const main = item.els.reduce((a, b) => {
      const area = (el) => {
        const box = el.getBBox();
        return box.width * box.height;
      };
      return area(b) > area(a) ? b : a;
    });
    const c = outlineCentre(main);
    text("lbl-section", c.x, c.y, item.label);
  }

  for (const group of Array.from(root.children)) {
    const id = group.getAttribute("id") || "";
    if (!id.startsWith("seat:")) continue;
    const bandName = id.slice(5);
    const box = group.getBBox();
    bandBoxes.set(`floor-${bandName.toLowerCase()}`, box);
    text("lbl-block", box.x + box.width / 2, box.y - 14, `${bandName} Floor`);

    for (const row of Array.from(group.children)) {
      if (row.tagName.toLowerCase() !== "g") continue;
      const rowBox = row.getBBox();
      // One gutter per row now that a row spans the whole floor, and the letter
      // alone is unique — it is exactly the prefix of every seat in the row.
      const rowLetter = baseName(row.getAttribute("id") || "");
      text("lbl-row", rowBox.x - 5, rowBox.y + rowBox.height / 2, rowLetter);
    }
  }
}

/*
 * Seat numbers, virtualized.
 *
 * 765 <text> nodes is far too many to create in one go — doing it on the frame
 * that crosses LOD_SEATS cost ~25ms, a visibly dropped frame right when the
 * user is zooming in. Instead the seats are bucketed into a lattice of chunks
 * that is cheap to cull against the viewBox, and each chunk builds its labels
 * the first time it is actually shown.
 *
 * Chunk boundaries come from gaps in the seat spacing rather than a hardcoded
 * block size, so they land on the real aisles (15 rows x 3 blocks here) and a
 * re-exported SVG with different blocks still buckets sensibly.
 */
const seatChunks = []; // {el, x0, x1, y0, y1, seats[], built, visible}

function prepareSeatChunks() {
  if (seatChunks.length) return;

  for (const group of svg.querySelectorAll('[id^="seat:"]')) {
    for (const row of group.children) {
      const seats = [...row.children]
        .map((s) => {
          const x = parseFloat(s.getAttribute("x"));
          const y = parseFloat(s.getAttribute("y"));
          const w = parseFloat(s.getAttribute("width"));
          const h = parseFloat(s.getAttribute("height"));
          // just the number inside the 10px dot; the row is in the gutter
          return {
            cx: x + w / 2,
            cy: y + h / 2,
            x0: x,
            x1: x + w,
            y0: y,
            y1: y + h,
            n: s.dataset.id.replace(/^[A-Z]+/, ""),
          };
        })
        .sort((a, b) => a.cx - b.cx);
      if (!seats.length) continue;

      const steps = seats.slice(1).map((s, i) => s.cx - seats[i].cx);
      const median = [...steps].sort((a, b) => a - b)[steps.length >> 1] || 0;
      let run = [seats[0]];
      const flush = () => {
        const el = document.createElementNS(SVG_NS, "g");
        el.style.display = "none";
        labels.appendChild(el);
        seatChunks.push({
          el,
          seats: run,
          built: false,
          visible: false,
          x0: run[0].x0,
          x1: run[run.length - 1].x1,
          y0: run[0].y0,
          y1: run[0].y1,
        });
      };
      for (let i = 1; i < seats.length; i++) {
        if (median && seats[i].cx - seats[i - 1].cx > median * 1.5) {
          flush();
          run = [];
        }
        run.push(seats[i]);
      }
      flush();
    }
  }
}

function buildChunk(chunk) {
  chunk.built = true;
  const frag = document.createDocumentFragment();
  for (const s of chunk.seats) {
    const el = document.createElementNS(SVG_NS, "text");
    el.setAttribute("class", "lbl-seat");
    el.setAttribute("x", s.cx);
    el.setAttribute("y", s.cy);
    el.textContent = s.n;
    frag.appendChild(el);
  }
  chunk.el.appendChild(frag);
}

/*
 * Culling alone does not save the frame that first shows seat numbers: the
 * whole floor is only 678x234 units, so by the time zoom reaches LOD_SEATS the
 * viewBox already contains every chunk. The build is therefore spread out —
 * pre-built in idle time from LOD_ROWS onward, and hard-capped per frame if the
 * user gets there first.
 */
const CHUNK_BUILDS_PER_FRAME = 8;
let idleHandle = 0;

function scheduleIdleBuild() {
  if (idleHandle || seatChunks.every((c) => c.built)) return;
  const idle =
    window.requestIdleCallback ||
    ((cb) => setTimeout(() => cb({ timeRemaining: () => 8 }), 200));
  idleHandle = idle((deadline) => {
    idleHandle = 0;
    for (const c of seatChunks) {
      if (c.built) continue;
      buildChunk(c);
      if (deadline.timeRemaining() < 2) break;
    }
    scheduleIdleBuild();
  });
}

/** Show only the chunks touching the viewBox; DOM is written only on change. */
function cullSeatLabels(show) {
  const x1 = view.x + view.w;
  const y1 = view.y + view.h;
  let budget = CHUNK_BUILDS_PER_FRAME;
  let deferred = false;

  for (const c of seatChunks) {
    const visible =
      show && c.x1 >= view.x && c.x0 <= x1 && c.y1 >= view.y && c.y0 <= y1;
    if (visible === c.visible) continue;
    if (visible && !c.built) {
      if (budget-- <= 0) {
        deferred = true; // finish on the next frame rather than blowing this one
        continue;
      }
      buildChunk(c);
    }
    c.visible = visible;
    c.el.style.display = visible ? "" : "none";
  }
  if (deferred) scheduleRender();
}

function buildLegend() {
  // What each zone actually contains, read back off the classified items rather
  // than restated as constants that could drift from the SVG.
  const detail = new Map();
  for (const item of items.values()) {
    const d =
      detail.get(item.zoneKey) ||
      detail
        .set(item.zoneKey, { seats: 0, sections: 0, rows: new Set() })
        .get(item.zoneKey);
    if (item.kind === "seat") {
      d.seats++;
      d.rows.add(item.id.match(/^[A-Z]+/)[0]);
    } else {
      d.sections++;
    }
  }

  legendList.innerHTML = "";
  // dearest first — the legend doubles as the price list, so read it like one
  const ordered = [...zones.values()].sort((a, b) => b.price - a.price);
  for (const zone of ordered) {
    const d = detail.get(zone.key);
    const rows = d ? [...d.rows].sort() : [];
    const note = !d
      ? ""
      : d.seats
        ? `Rows ${rows[0]}–${rows[rows.length - 1]} · ${d.seats} seats`
        : `${d.sections} section${d.sections === 1 ? "" : "s"}`;

    const li = document.createElement("li");
    li.innerHTML =
      `<span class="swatch" style="background:${zone.color}"></span>` +
      `<span class="legend-name"><b></b><small></small></span>` +
      `<em>${money(zone.price)}</em>`;
    li.querySelector("b").textContent = zone.name;
    li.querySelector("small").textContent = note;
    legendList.appendChild(li);
  }

  const prices = ordered.map((z) => z.price);
  document.getElementById("legend-range").textContent =
    `${money(Math.min(...prices))}–${money(Math.max(...prices))}`;

  legend.hidden = false;
}

/* --------------------------------------------------------------- view state */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Cached so the gesture path never triggers a synchronous layout. */
let stageRect = { left: 0, top: 0, width: 1, height: 1 };
function measureStage() {
  stageRect = stage.getBoundingClientRect();
}

/** Pure: no DOM reads or writes. */
function clampView() {
  view.w = clamp(view.w, world.w / MAX_SCALE, world.w / MIN_SCALE);
  view.h = view.w * (world.h / world.w);
  // allow a little slack past the edges, but never let the map be flung away
  const slackX = view.w * 0.25;
  const slackY = view.h * 0.25;
  view.x = clamp(view.x, -slackX, world.w - view.w + slackX);
  view.y = clamp(view.y, -slackY, world.h - view.h + slackY);
}

/**
 * On-screen px per user unit. `preserveAspectRatio` is the default
 * `xMidYMid meet`, so this is exactly what the renderer resolves to — computing
 * it beats `getScreenCTM()`, which forces a synchronous layout every call.
 */
function viewScale() {
  return Math.min(stageRect.width / view.w, stageRect.height / view.h);
}

let framePending = false;
let frameId = 0;

function scheduleRender() {
  if (framePending) return;
  framePending = true;
  // clear the flag inside the callback rather than assigning the handle after
  // scheduling — the latter relies on the callback running strictly later, and
  // silently wedges the scheduler for good if it ever does not
  frameId = requestAnimationFrame(() => {
    framePending = false;
    commit();
  });
}

/** Commit immediately. Used for the first paint, which must not wait for a
 *  frame that a throttled or hidden tab may not deliver for a long time. */
function renderNow() {
  if (framePending) cancelAnimationFrame(frameId);
  framePending = false;
  commit();
}

let lastLod = null;
let lastK = 0;

/** The only place the view touches the DOM, and at most once per frame. */
function commit() {
  clampView();
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);

  const scale = world.w / view.w;
  const lod = scale >= LOD_SEATS ? "2" : scale >= LOD_ROWS ? "1" : "0";
  if (lod !== lastLod) {
    lastLod = lod;
    svg.dataset.lod = lod;
    // start one LOD early, so the labels are usually already built by the time
    // the user zooms far enough to see them
    if (lod !== "0") {
      prepareSeatChunks();
      scheduleIdleBuild();
    }
  }
  if (seatChunks.length) cullSeatLabels(lod === "2");

  // Only the label font-sizes still ride on --k, and writing it invalidates
  // every one of them. Panning does not change scale at all, so this skip makes
  // a pan free; a zoom pays it a fraction as often, far below visible stepping.
  const k = 1 / viewScale();
  if (Math.abs(k - lastK) > lastK * 0.005) {
    lastK = k;
    svg.style.setProperty("--k", k);
  }
}

function fitTo(box, padding = 0.1) {
  const rect = stageRect;
  const aspect = world.h / world.w;
  if (!rect.width || !rect.height || !box.width || !box.height) return;

  // The bottom bar floats over the map, so fitting into the full stage would
  // park the last rows underneath it the moment a selection opens the bar.
  // Reserve its height up front and nudge the view so the box lands above it.
  const reserved = Math.min(BAR_RESERVE_PX, rect.height * 0.25);
  const safeHeight = Math.max(rect.height - reserved, 80);

  // preserveAspectRatio="meet" keeps the viewBox aspect pinned to the export's,
  // so the rendered scale is whatever the tighter axis allows. Solving for that
  // scale first is what lets a wide, short stage still fill itself with a tall
  // box — sizing off the box width alone leaves most of the viewport empty.
  const scale =
    Math.min(rect.width / box.width, safeHeight / box.height) /
    (1 + padding * 2);
  view.w = Math.min(rect.width, rect.height / aspect) / scale;
  view.h = view.w * aspect;
  view.x = box.x + box.width / 2 - view.w / 2;
  // shifting the viewport down moves the content up, clear of the bar
  view.y = box.y + box.height / 2 - view.h / 2 + reserved / 2 / scale;
  scheduleRender();
}

function resetView() {
  view.x = 0;
  view.y = 0;
  view.w = world.w;
  view.h = world.h;
  scheduleRender();
}

/** Client coords -> user coords, accounting for `meet` letterboxing. */
function toUser(clientX, clientY) {
  const s = viewScale();
  const offX = (stageRect.width - view.w * s) / 2;
  const offY = (stageRect.height - view.h * s) / 2;
  return {
    x: view.x + (clientX - stageRect.left - offX) / s,
    y: view.y + (clientY - stageRect.top - offY) / s,
  };
}

/** Zoom by `factor`, holding the given client point still on screen. */
function zoomAt(factor, clientX, clientY) {
  const before = toUser(clientX, clientY);
  view.w = clamp(view.w / factor, world.w / MAX_SCALE, world.w / MIN_SCALE);
  view.h = view.w * (world.h / world.w);
  clampView(); // so `after` is measured against the view we will actually draw
  const after = toUser(clientX, clientY);
  view.x += before.x - after.x;
  view.y += before.y - after.y;
  scheduleRender();
}

function zoomCentre(factor) {
  zoomAt(
    factor,
    stageRect.left + stageRect.width / 2,
    stageRect.top + stageRect.height / 2,
  );
}

/* ------------------------------------------------------------------- gestures */

// One Pointer Events path covers mouse, pen and finger; a Map of live pointers
// is what makes the two-finger pinch fall out of the same handlers.
const pointers = new Map();
let panLast = null;
let pinchLast = null;
let tapCandidate = null;

function pointerCentre() {
  let x = 0;
  let y = 0;
  for (const p of pointers.values()) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pointers.size, y: y / pointers.size };
}

function pointerSpread() {
  const [a, b] = [...pointers.values()];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(e) {
  // The Zones legend lives inside #stage (so it can float over the map) but is
  // UI chrome, not the map surface. Left alone, its pointerdown would still be
  // swallowed into the pan/tap state machine below — stage.setPointerCapture()
  // included — which is fragile for a mouse/trackpad click that drifts a pixel
  // or two, far more than a stable finger tap tends to. The bottom bar has no
  // equivalent problem only because it happens to sit outside #stage.
  if (e.target instanceof Element && e.target.closest(".legend")) return;

  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Capture keeps a drag alive when the pointer leaves the stage, but it throws
  // for a pointer the browser no longer considers active. Track state first so
  // a refused capture can never strand the gesture handlers.
  try {
    stage.setPointerCapture(e.pointerId);
  } catch {
    /* not capturable — dragging still works while the pointer stays inside */
  }

  if (pointers.size === 1) {
    panLast = { x: e.clientX, y: e.clientY };
    tapCandidate = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      target: e.target,
    };
  } else {
    // a second finger cancels the tap and starts a pinch
    tapCandidate = null;
    panLast = null;
    if (pointers.size === 2)
      pinchLast = { d: pointerSpread(), c: pointerCentre() };
  }
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (
    tapCandidate &&
    Math.hypot(e.clientX - tapCandidate.x, e.clientY - tapCandidate.y) >
      TAP_SLOP_PX
  ) {
    tapCandidate = null; // this is a drag, not a tap
  }

  if (pointers.size >= 2 && pinchLast) {
    const d = pointerSpread();
    const c = pointerCentre();
    if (pinchLast.d > 0) zoomAt(d / pinchLast.d, c.x, c.y);
    // the midpoint drifting is a pan, so honour it in the same gesture
    panBy(c.x - pinchLast.c.x, c.y - pinchLast.c.y);
    pinchLast = { d, c };
    return;
  }

  if (pointers.size === 1 && panLast) {
    panBy(e.clientX - panLast.x, e.clientY - panLast.y);
    panLast = { x: e.clientX, y: e.clientY };
  }
}

function panBy(dxClient, dyClient) {
  const s = viewScale();
  if (!s) return;
  view.x -= dxClient / s;
  view.y -= dyClient / s;
  scheduleRender();
  hideHint();
}

function onPointerUp(e) {
  // Mirrors the guard in onPointerDown: a pointer that started on the legend
  // was never added below, so it must not fall into the pointers.size === 0
  // branch and fire a tap from another gesture's leftover tapCandidate.
  if (!pointers.has(e.pointerId)) return;

  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchLast = null;
  if (pointers.size === 1) {
    const [p] = [...pointers.values()];
    panLast = { x: p.x, y: p.y };
  } else if (pointers.size === 0) {
    panLast = null;
    if (tapCandidate && performance.now() - tapCandidate.t < TAP_MAX_MS) {
      handleTap(tapCandidate.target, e.clientX, e.clientY);
    }
    tapCandidate = null;
  }
}

function onPointerCancel(e) {
  pointers.delete(e.pointerId);
  panLast = null;
  pinchLast = null;
  tapCandidate = null;
}

function onWheel(e) {
  e.preventDefault();
  // A trackpad pinch arrives as a wheel event with ctrlKey set; a plain wheel
  // notch reports in lines rather than pixels. Normalising both means the mouse
  // and the trackpad end up feeling like the same control.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const delta = e.deltaY * unit;
  const strength = e.ctrlKey ? 0.02 : 0.0022;
  zoomAt(Math.exp(-delta * strength), e.clientX, e.clientY);
  hideHint();
}

/* ------------------------------------------------------------------ selection */

function handleTap(target, clientX, clientY) {
  // The label layer is pointer-events:none, but a captured pointer reports the
  // capture element, so resolve the hit from the coordinates when needed.
  let el = target instanceof Element ? target.closest("[data-kind]") : null;
  if (!el) {
    const under = document.elementFromPoint(clientX, clientY);
    el = under instanceof Element ? under.closest("[data-kind]") : null;
  }

  if (!el) {
    clearSelection();
    render();
    return;
  }

  // A seat is a 10px dot on a 4016px canvas: below this zoom you cannot
  // meaningfully aim at one, so the tap means "take me there" instead.
  const scale = world.w / view.w;
  if (el.dataset.kind === "seat" && scale < SEAT_PICK_SCALE) {
    const box = bandBoxes.get(el.dataset.zone);
    if (box) {
      fitTo(box);
      hideHint();
      return;
    }
  }

  toggle(el.dataset.id);
  hideHint();
}

function clearSelection() {
  selection.kind = null;
  selection.ids = [];
  selection.qty = 1;
}

/**
 * Apply a tap to the basket. Seats accumulate and toggle off; a section is
 * bought by quantity instead, so only one can be held at a time and re-tapping
 * it is a no-op — losing a quantity you just set to a stray tap is far worse
 * than needing the × to drop it.
 */
function toggle(id) {
  const item = items.get(id);
  if (!item) return;

  if (item.kind === "seat") {
    if (selection.kind === "section") {
      clearSelection();
      toast("Section cleared — seats and sections can't be mixed");
    }
    selection.kind = "seat";
    const at = selection.ids.indexOf(id);
    if (at >= 0) {
      selection.ids.splice(at, 1);
      if (!selection.ids.length) selection.kind = null;
    } else if (selection.ids.length >= MAX_SEATS) {
      toast(`Up to ${MAX_SEATS} seats per order`);
    } else {
      selection.ids.push(id);
    }
  } else {
    if (selection.kind === "section" && selection.ids[0] === id) return;
    if (selection.kind === "seat") {
      toast("Seats cleared — sections are booked by quantity");
    }
    selection.kind = "section";
    selection.ids = [id];
    selection.qty = 1;
  }

  render();
}

function setQty(delta) {
  if (selection.kind !== "section") return;
  const max = Math.min(availabilityFor(selection.ids[0]), MAX_QTY);
  selection.qty = clamp(selection.qty + delta, 1, max);
  render();
}

function render() {
  for (const el of svg.querySelectorAll(".is-selected")) {
    el.classList.remove("is-selected");
  }
  for (const id of selection.ids) {
    // one section id can own two paths (the -SMALL companion), so mark them all
    for (const el of items.get(id).els) el.classList.add("is-selected");
  }

  bottombar.dataset.open = selection.kind ? "true" : "false";
  if (!selection.kind) {
    // leave the last content in place: repainting it now would show the bar
    // emptying itself on the way out
    setBarHeight(0);
    return;
  }

  const swatch = bottombar.querySelector(".bb-swatch");
  const label = bottombar.querySelector(".bb-label");
  const sub = bottombar.querySelector(".bb-zone");
  const price = bottombar.querySelector(".bb-price");

  if (selection.kind === "seat") {
    const seatZones = selection.ids.map((id) =>
      zones.get(items.get(id).zoneKey),
    );
    const names = [...new Set(seatZones.map((z) => z.name))];
    const colors = [...new Set(seatZones.map((z) => z.color))];
    // seats can span bands at different prices, so this is a sum, not count x price
    const total = seatZones.reduce((sum, z) => sum + z.price, 0);

    swatch.style.background =
      colors.length === 1
        ? colors[0]
        : `linear-gradient(135deg, ${colors.join(", ")})`;
    label.textContent = `${selection.ids.length} seat${selection.ids.length > 1 ? "s" : ""}`;
    sub.textContent = names.join(" · ");
    price.textContent = money(total);

    bbQty.hidden = true;
    bbChips.hidden = false;
    bbChips.innerHTML = "";
    for (const id of selection.ids) {
      const li = document.createElement("li");
      li.innerHTML = `<span></span><button type="button" data-remove aria-label="Remove">×</button>`;
      li.querySelector("span").textContent = id;
      li.querySelector("button").dataset.remove = id;
      bbChips.appendChild(li);
    }
    setBarHeight(bottombar.offsetHeight);
    return;
  }

  const id = selection.ids[0];
  const zone = zones.get(items.get(id).zoneKey);
  const available = availabilityFor(id);
  const max = Math.min(available, MAX_QTY);

  swatch.style.background = zone.color;
  label.textContent = id;
  sub.textContent = `${zone.name} · ${money(zone.price)} each · ${available} left`;
  price.textContent = money(zone.price * selection.qty);

  bbChips.hidden = true;
  bbChips.innerHTML = "";
  bbQty.hidden = false;
  bbQty.querySelector(".bb-qty-value").textContent = selection.qty;
  bbQty.querySelector('[data-step="-1"]').disabled = selection.qty <= 1;
  bbQty.querySelector('[data-step="1"]').disabled = selection.qty >= max;
  setBarHeight(bottombar.offsetHeight);
}

// The bar overlays the map, so the hint/toast pill needs to know how tall it is
// to sit above it — and the two modes are different heights.
function setBarHeight(px) {
  document.documentElement.style.setProperty("--bar-h", `${px}px`);
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, TOAST_MS);
}

function hideHint() {
  hint.hidden = true;
}

/* ----------------------------------------------------------------- wiring up */

function bindControls() {
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerCancel);
  stage.addEventListener("wheel", onWheel, { passive: false });

  // iOS Safari still fires its own pinch/double-tap zoom on top of pointer
  // events; these keep the page itself from zooming behind the map.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    stage.addEventListener(type, (e) => e.preventDefault());
  }
  stage.addEventListener("dblclick", (e) => e.preventDefault());
  stage.addEventListener("contextmenu", (e) => e.preventDefault());

  bottombar.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    if (button.classList.contains("bb-clear")) {
      clearSelection();
      render();
    } else if (button.classList.contains("bb-step")) {
      setQty(Number(button.dataset.step));
    } else if (button.dataset.remove) {
      toggle(button.dataset.remove);
    }
  });

  const legendToggle = document.getElementById("legend-toggle");
  const legendBody = document.getElementById("legend-body");
  legendToggle.addEventListener("click", () => {
    const open = legend.dataset.open !== "true";
    legend.dataset.open = String(open);
    legendToggle.setAttribute("aria-expanded", String(open));
    // scrollHeight reads the full content height even while clipped to 0
    legendBody.style.height = open ? `${legendBody.scrollHeight}px` : "0px";
  });

  window.addEventListener("keydown", (e) => {
    const step = view.w * 0.12;
    if (e.key === "Escape") {
      clearSelection();
      render();
    } else if (e.key === "+" || e.key === "=") zoomCentre(1.6);
    else if (e.key === "-" || e.key === "_") zoomCentre(1 / 1.6);
    else if (e.key === "0") resetView();
    else if (e.key === "ArrowLeft") view.x -= step;
    else if (e.key === "ArrowRight") view.x += step;
    else if (e.key === "ArrowUp") view.y -= step;
    else if (e.key === "ArrowDown") view.y += step;
    else return;
    e.preventDefault();
    scheduleRender();
  });

  // the stage rect is the one layout read the gesture path depends on, so it is
  // refreshed here rather than measured per event
  window.addEventListener("resize", () => {
    measureStage();
    scheduleRender();
  });
}

async function main() {
  buildZones();

  const res = await fetch(SVG_URL);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const doc = new DOMParser().parseFromString(
    await res.text(),
    "image/svg+xml",
  );
  if (doc.querySelector("parsererror"))
    throw new Error("the SVG could not be parsed");

  svg = document.importNode(doc.documentElement, true);
  const [, , vw, vh] = (svg.getAttribute("viewBox") || "0 0 1000 1000")
    .split(/\s+/)
    .map(Number);
  world.w = vw;
  world.h = vh;
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  stage.appendChild(svg);
  stageMsg.hidden = true;

  const root = svg.querySelector("#stadium_correct_size") || svg;
  classify(root);
  buildLabels(root);
  buildLegend();
  bindControls();
  measureStage(); // every later view calculation reads this instead of the DOM
  resetView();
  renderNow(); // paint the initial view without waiting on a frame

  console.info(
    `seats: ${svg.querySelectorAll('[data-kind="seat"]').length}, ` +
      `sections: ${[...items.values()].filter((i) => i.kind === "section").length}`,
  );
}

main().catch((err) => {
  stageMsg.hidden = false;
  stageMsg.textContent = `Could not load ${SVG_URL} — ${err.message}. Serve this folder over http (see README.md); opening index.html from the filesystem is blocked by CORS.`;
  console.error(err);
});
