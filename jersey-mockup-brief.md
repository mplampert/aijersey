# Brief — Jersey Mockup Compositor

Build a single-page static tool that takes flat artwork and renders it onto a
photoreal hockey jersey. No build step, no framework, no npm dependencies.
Deployed by dropping the folder on Netlify.

---

## What this replaces

Today a jersey concept is produced by asking an image generator for "a hockey
jersey," which returns a different garment every time. This tool inverts that:
the garment is fixed and comes from a real 3D render. The generator (or the
factory) supplies **flat artwork only** — no garment, no folds, no shadows.

Output is a customer-facing mockup. It is **not** production art.

---

## Files

```
index.html                     ← entire app, single file
public/mockup/front/
  Base.png                     ← neutral grey garment render (shading pass)
  mask-body.png                ← torso region
  mask-shoulders.png           ← shoulder yoke region
  mask-sleeves.png             ← both sleeves
  mask-collar.png              ← collar + neck rib
```

All five are 1500 × 1500 PNG with alpha, already mutually registered. Only the
alpha channel of the four masks is used — ignore their RGB entirely.

---

## Measured constants — do not recompute, these are verified

```js
const CANVAS   = 1500;              // all assets are 1500 x 1500
const GARMENT  = {x0:234, y0:97, x1:1251, y1:1398};  // Base.png alpha bbox
const SHADE_PIVOT = 144;            // median luminance of Base.png
```

Base.png is perfectly neutral (max R−B delta across the whole garment is 1), so
luminance can be read from the red channel alone.

Luminance distribution inside the garment: p1 = 16, p25 = 123, p50 = 144,
p75 = 162, p99 = 190. **The mid-tone is 144, not 128.** Overlay and soft-light
both pivot at 128, so Base.png must be remapped before use as a shading layer or
every render comes out washed out.

Region coverage, verified: body 647,536 px · sleeves 334,078 px ·
shoulders 94,879 px · collar 54,613 px. No region has pixels outside the base.
Pairwise overlaps are 12 px and 107 px (antialiasing only).

---

## Known geometry issues to handle in code

**1. Armhole seam gap.** There is a 2–4 px unmasked sliver on the right armhole,
roughly (1051,382)–(1097,567) and (1035,588)–(1055,721). Left it bare and a
hairline of grey shows through between body and sleeve.

Fix at load: dilate the **body** mask by 2 px before use. Draw the mask image 25
times into an offscreen canvas at every offset in −2..2 × −2..2. Cheap, runs
once. Safe because the sleeve mask draws on top of the body afterward.

**2. Neck opening must stay bare.** The region (606,148)–(893,240), about
17,886 px, is the dark mesh inside the collar. No artwork may reach it. It is
already excluded from all four masks — just never fill outside the union of the
four masks, and it takes care of itself.

**3. Sub-pixel edge noise.** ~600 regions of 1–90 px along shared edges. Ignore
them. Do not attempt to close them.

---

## Compositing algorithm

Order matters. Build it exactly this way.

### At load

1. Load all five images.
2. Build `dilatedBodyMask` per the 25-draw dilation above.
3. Build `shadeCanvas` (1500 × 1500):
   - read Base.png pixels
   - `L' = clamp(128 + (L - SHADE_PIVOT) * contrast, 0, 255)`
   - write `L'` to R, G, and B; set alpha to Base.png's alpha
   - `contrast` is a UI slider, default `1.0`, range `0.6 – 1.6`
   - rebuild this canvas whenever `contrast` changes

### Per render

For each region in order `body → shoulders → sleeves → collar`:

1. Fresh offscreen canvas, 1500 × 1500.
2. Paint the region's source: either the artwork image drawn with its transform,
   or a solid fill if the region is set to a flat color.
3. `ctx.globalCompositeOperation = 'destination-in'`
4. `ctx.drawImage(regionMask, 0, 0)` — clips to the region.

Then on the main canvas:

5. Clear, then draw the four region canvases in that same order.
6. `ctx.globalCompositeOperation = 'overlay'` (or `'soft-light'` — expose as a
   toggle, default `overlay`)
7. `ctx.drawImage(shadeCanvas, 0, 0)` — this is what makes it read as fabric.
8. `ctx.globalCompositeOperation = 'destination-in'`
9. `ctx.drawImage(baseImage, 0, 0)` — reclip to the garment silhouette, since
   the overlay pass can bleed at the edges.
10. Reset to `'source-over'`.

Skipping step 6–7 produces a flat sticker in the shape of a jersey. That step is
the entire point of the tool.

---

## Artwork modes

Two modes. **Default to `unified`.**

**`unified`** — one master artwork image, drawn once across the full
1500 × 1500 canvas, and each of the four regions clips from that same draw. A
continuous scene runs unbroken across body, shoulder, and sleeve. This is how
the factory's own flat layouts are built, so it matches production.

**`per-region`** — each region independently takes either its own image or a
solid hex color. Use for contrast sleeves, a contrast yoke, or a solid collar.

In both modes the collar defaults to a **solid color**, not artwork. Pattern
across the collar rib almost always looks wrong.

---

## Artwork transform

Per artwork source: `scale` (0.5–3.0, default = cover the garment bbox),
`offsetX`, `offsetY` (px, default 0), `rotation` (deg, default 0),
and a `tile` toggle for repeating patterns.

Default fit should cover `GARMENT`, not the full 1500 canvas — otherwise a large
share of the artwork lands outside the silhouette and is wasted.

---

## UI

Single column of controls on the left, canvas preview on the right. Preview
displayed at 600 px, rendered at 1500.

- Artwork drop zone (drag-drop and file picker)
- Mode toggle: unified / per-region
- Per-region panel when in per-region mode: image or color, per-region transform
- Shading contrast slider
- Blend mode toggle: overlay / soft-light
- Background toggle: transparent / white / dark
- **Export PNG** — 1500 × 1500, transparent background, via `toBlob`

Re-render on any control change. Debounce slider input to ~50 ms.

Everything is in-memory. No localStorage, no backend, no uploads.

---

## Acceptance tests

1. Load a solid red 1500 × 1500 PNG in unified mode. Result: a red jersey with
   visible folds, seams, and collar shadow. Neck opening stays bare.
2. Set shading contrast to 0.6, then 1.6. Fabric depth should visibly flatten
   and deepen. At 1.0 the mid-tone should sit near 128, not 144.
3. Zoom the right armhole. No grey hairline between body and sleeve.
4. Per-region mode, sleeves set to a contrasting hex. Only the sleeves change.
5. Export. Output is exactly 1500 × 1500 with a transparent background, and the
   garment silhouette matches Base.png's alpha.

---

## Explicit non-goals

- No back view. Base.png is front only. Back needs its own asset set later.
- No text, numbers, nameplate, or logo rendering. Those go on as vector in
  Illustrator afterward. The generator cannot produce legible type.
- No production output. This is a customer preview only. Production art is a
  flat panel layout at the factory's pattern dimensions.
- No design editor. Artwork comes in finished.

---

## Prompt template for generating artwork to feed this tool

> Flat vector artwork panel for a sublimated hockey jersey, 3:4 portrait.
> Full-bleed illustrated scene, edge to edge, no borders or margins. [THEME].
> Palette limited to [3–4 HEX CODES]. Bold flat color fills, clean line work,
> screen-print style. No fabric, no garment, no jersey, no folds, no shadows,
> no highlights, no mockup. No text, no letters, no numbers, no logo.
> Composition symmetric about the vertical center.

The "no shadows, no folds" clause has to stay in every time. If the generator
paints its own shading it fights the Base.png pass and the render goes muddy.
