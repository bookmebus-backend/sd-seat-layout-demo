# Stadium Seat Demo

An interactive seat map built directly from the Figma export `stadium_correct_size.svg`. Zoom and pan the stadium, pick individual seats or buy a whole section by quantity, and the bottom bar keeps a running total.

Prototype only — no build step, no bundler, no backend. The one network request is Poppins from Google Fonts; the page falls back to system fonts and stays fully usable offline.

See [FEATURES.md](FEATURES.md) for a tour of what it can do, with screenshots. This file covers how it's built.

## Run it

```sh
cd seat-layout-demo
python3 -m http.server 8000
```

Then open http://localhost:8000.

Opening `index.html` straight from the filesystem will **not** work: the page `fetch`es the SVG at runtime and browsers block that over `file://`. Any static server will do.

## How the SVG maps to the model

Everything is derived from the layer ids at runtime, so re-exporting the SVG picks up the changes without editing any code.

| Layer                                 | Becomes                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `seat:Front`, `seat:Mid`, `seat:Back` | Row bands on the floor. Each holds 5 row groups × 51 rects = one selectable seat, labelled `<row><number>` → `A1` … `O51`. 765 in total. |
| Named root paths (`D101`, `B111`, …)  | Selectable sections. Users pick the whole section, not a seat inside it.                                                                 |
| `unnamed` (bowl, pitch, outer stands) | Backdrop. Never interactive.                                                                                                             |

### Why rows are flat

The floor is physically one continuous row of 51 seats broken by two aisles, so a row is numbered straight through: `A1` … `A51`. An earlier version split it into three vertical blocks and labelled seats `AA1` / `BA1` / `CA1`, which encoded a distinction no ticket buyer cares about.

The three `seat:*` groups are therefore **pricing bands, not part of the seat's name** — rows `A`–`O` are unique across the whole floor, so the row letter alone places the seat:

```
seat:Front   rows A–E    A1 … E51
seat:Mid     rows F–J    F1 … J51
seat:Back    rows K–O    K1 … O51
```

Two quirks of the export are absorbed by `app.js`:

- **`-SMALL` companions.** `D101-SMALL`, `A101-SMALL`, `B101-SMALL` and `B111-SMALL` are second shapes of a section that already exists. The suffix is stripped, so 39 paths become 35 logical sections that share one colour, one price, and highlight together.
- **Figma dedup suffixes.** Figma appends `_2`, `_3`, … to any layer name that repeats anywhere in the file. Seat names `1`–`51` recur in all 15 rows, so a Figma round-trip returns them as `1`, `1_2`, `1_3` and so on. A trailing `_<digits>` is stripped to recover the name the designer typed, which is what keeps re-exporting safe.

## Colours and prices

Eight zones — the three floor bands plus sections grouped by their leading letter (`A1xx` … `E1xx` → Tier A … Tier E).

The **Zones** panel top-left is the price list. Collapsed it is a pill showing the overall range (`$14–$100`); tapping it expands to a row per zone with swatch, price, and what the zone contains — `Rows A–E · 255 seats` for a floor band, `12 sections` for a tier. Those counts are read back off the classified SVG rather than written down, so they cannot drift from the file. It animates open from a height measured in JS. The usual `grid-template-rows: 0fr → 1fr` trick was tried first and opened the panel 10px tall: it needs `overflow: hidden` on the grid item, which zeroes that item's contribution, so the flexible track resolved to nothing but the padding.

Prices are **set, not generated**. Real ticket prices are decided, and a random ladder happily prices the back floor above the front. Two things drive them:

| Zone                                 |                       Price | Why                                                                                                                                                     |
| ------------------------------------ | --------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Front Floor / Mid Floor / Back Floor |            $100 / $80 / $65 | Picked seat-by-seat, right at the stage — the premium product.                                                                                          |
| Tier D / C / B / E / A               | $28 / $25 / $22 / $18 / $14 | Ring sections, sold by quantity. Ordered by each tier's mean distance from the `Stage` rect in the SVG: D 688, C 750, B 869, E 1047, A 1563 user units. |

Section **availability** is still generated — seeded from a hash of the section id, so it is stable across reloads and independent of every other zone.

A `seat:` group or section prefix that the code does not recognise still renders, with a fallback colour and price and a console warning, rather than disappearing.

## Interaction

Mouse, trackpad, and touch all run through the same Pointer Events handlers.

| Action | Mouse                 | Trackpad                    | Touch            |
| ------ | --------------------- | --------------------------- | ---------------- |
| Pan    | drag                  | drag                        | one-finger drag  |
| Zoom   | wheel (toward cursor) | two-finger scroll, or pinch | two-finger pinch |
| Select | click                 | click                       | tap              |

There is no toolbar — the map is the whole screen. Keyboard covers the rest: `+` / `−` zoom, `0` resets, arrow keys pan, `Esc` clears the selection (as does the `×`).

A tap only registers if the pointer barely moved — otherwise every pan would end in an accidental selection.

## Selecting

A basket is **either loose seats or a quantity in one section, never both** — the two are different ways of buying, so mixing them has no meaning.

**Seats** — tap to add, up to 10 per order; tap again (or the chip's `×`) to remove. The bar shows a chip per seat and a running total. Seats may span bands at different prices, so the total is the sum of each seat's own band price, not count × one price, and the swatch becomes a gradient when the selection spans more than one band.

**Sections** — you do not pick a seat inside a section, you choose how many you want. Selecting one shows a `−` / `+` stepper clamped to `1 … min(available, 10)`, with the buttons visibly disabled at the bounds; the line total updates live. Availability is seeded from a hash of the section id, so it is stable across reloads.

The bottom bar only exists while something is selected: it slides up and fades in on the first pick, and slides back down when the selection clears. It floats **over** the map rather than taking a layout row, so showing it never reflows and re-fits the stage — and `fitTo` reserves its height in advance, so zooming to a band never parks the last rows underneath it. The hint/toast pill rides above it via a measured `--bar-h`. All of it collapses to near-zero duration under `prefers-reduced-motion`.

Tapping across the two modes switches rather than refuses — the old selection clears and a toast says why, since a tap that silently does nothing reads as a broken map. Re-tapping the **selected** section is a no-op, so a stray tap cannot discard a quantity you just set; seats still toggle off, since that is the only way to drop one.

Two zoom-dependent behaviours make the 10px seats usable on a 4016px canvas:

- Below 4× zoom, tapping a seat zooms to fit its band instead of selecting the seat.
- Labels are level-of-detail: section names are always drawn, band titles and row letters appear around 3×, seat numbers inside the dots around 6×. Each row has one gutter letter at the far left of the floor, and it is exactly the prefix of every seat in that row. Section and band labels counter-scale so they hold a constant on-screen size; row letters and seat numbers are sized in map units so they stay part of the seat grid.

## Performance

The map is ~1,600 SVG nodes, so the gesture path is built to do as little as possible per event.

**Nothing in the gesture path forces layout.** Handlers only mutate a plain `view` object and call `scheduleRender()`; a single `requestAnimationFrame` commits at most once per frame, no matter how fast events arrive. The client↔user coordinate mapping is computed arithmetically from a cached stage rect rather than read from `getScreenCTM()`, which forces a synchronous layout on every call. Before this, one wheel event cost 4 `getScreenCTM()` calls and 2 `--k` rewrites.

**`--k` is only written when the scale actually changes.** It drives the counter-scaled label `font-size`, so every write re-lays-out those `<text>` nodes. Panning does not change scale, so a pan now writes it zero times. Section and halo strokes moved to `vector-effect: non-scaling-stroke`, which gets constant on-screen width from the renderer and takes 39 more elements off `--k` entirely.

Measured over 120 synthetic pan events and 60 wheel events, with commits forced inline so the comparison is like-for-like:

|               | `getScreenCTM()` | `--k` writes |      time |
| ------------- | ---------------: | -----------: | --------: |
| Pan, before   |              240 |          120 |    20.2ms |
| Pan, after    |            **0** |        **0** | **1.4ms** |
| Wheel, before |              240 |          120 |   470.2ms |
| Wheel, after  |            **0** |           37 | **2.6ms** |

**Seat labels are built in slices.** Creating all 765 `<text>` nodes on the frame that crosses `LOD_SEATS` cost ~25ms — a dropped frame exactly when zooming in. They are now bucketed into 45 chunks (15 rows × 3 blocks, split on gaps in the seat spacing rather than a hardcoded block size), pre-built during idle time from `LOD_ROWS` onward, and hard-capped at 8 chunks per frame if the user gets there first.

Chunks are also culled against the viewBox, but honestly that buys little on its own: the whole floor is 678×234 units, so by the time zoom reaches `LOD_SEATS` the viewBox already contains nearly every chunk. It only pays off at very deep zoom. The slicing, not the culling, is what removes the hitch.
