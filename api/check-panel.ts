import { inflateSync } from "node:zlib";

/**
 * Cheap pixel checks on a generated artwork panel, run before it is worth
 * showing anyone.
 *
 * These catch the two ways the generator misses that are obvious from the
 * pixels alone and expensive to spot by eye at thumbnail size: a centred
 * subject floating on a margin, which becomes bare fabric once the compositor
 * clips it, and a palette the model quietly ignored.
 *
 * Nothing here is a substitute for looking at the panel. Two or three attempts
 * per usable one is the expected rate, so the point of a check is to spend the
 * retry automatically rather than to be certain.
 *
 * No dependencies: this runs in a serverless function, and pulling an image
 * library in to read a few hundred pixels is not worth the cold start. PNG is
 * the only format decoded — it is what the image models return — and anything
 * else passes unchecked rather than failing.
 */

export type PanelIssue = "margins" | "palette" | "aspect" | "text";
export type PanelReport = {
  issues: PanelIssue[];
  /** Plain-language reason per issue, for the log and the retry prompt. */
  notes: string[];
  /** Null when the image could not be read, which is never itself an issue. */
  size: { width: number; height: number } | null;
};

const NONE: PanelReport = { issues: [], notes: [], size: null };

/* Sampled per corner. Big enough to survive a stray pixel of noise, small
   enough to still be the corner rather than the composition. */
const CORNER = 24;

/* How far a pixel may sit from the nearest requested colour and still count as
   on-palette, as a squared distance in RGB. 72 levels: wide enough for the
   tints and shades a flat panel is built from, narrow enough that a hue nobody
   asked for lands outside it. */
const TOLERANCE = 72 * 72;

/* Below this share of sampled pixels near the palette, the model was not
   listening. */
const ON_PALETTE = 0.6;

const SAMPLES = 200;

/* Text detection.
 *
 * Every one of eleven generations came back with lettering on it, garbled, and
 * a model that has drawn a word will draw one again however the prompt is
 * worded. So the panel is read rather than trusted.
 *
 * Flat vector artwork is the easy case: a word is drawn in one flat colour, so
 * the search runs per colour layer rather than on a single global threshold
 * that multi-coloured artwork would defeat. Quantise, take the layers with
 * enough pixels to matter, label what is connected inside each, and look for a
 * row of glyph-shaped pieces sitting on a common baseline.
 *
 * Baseline and spacing alone are not enough, because a skyline, a row of trees
 * and a shoal of fish are all a line of varied shapes standing on one. What
 * separates a letter from a silhouette is that a letter is drawn with a pen: its
 * strokes are of roughly constant width and thin against its own height, while a
 * building, a triangle or a fish is solid all the way through. Area over
 * perimeter gives that thickness for the price of counting edge pixels, and a
 * glyph lands between a twentieth and a third of its own height where a solid
 * shape lands far above it.
 *
 * Fill ratio — component pixels over bounding box — carries the rest: near 1 for
 * a square, about 0.78 for a circle, 0.2 to 0.6 for a letter.
 *
 * What this cannot do is read. A row of trees and a windowed skyline are a line
 * of varied silhouettes standing on a baseline, drawn in one weight, and no
 * amount of measuring separates them from a word without looking at the glyphs:
 * both are false positives here and tightening the numbers far enough to lose
 * them starts losing four-letter words too. So this is the free first pass, and
 * check-image asks a model that can actually read — the pixel verdict only
 * decides on its own when that call could not be made. */
const TEXT = {
  work: 600,          // longest side the search runs at
  layers: 32,         // colour layers examined, most common first. A gradient
                      // alone can fill a dozen, and the lettering is rarely the
                      // biggest thing on the panel — ten was not enough to
                      // reach white type over a graded sky.
  minShare: 0.0004,   // ...ignoring any too rare to be a drawn element
  maxShare: 0.55,     // ...and any big enough to be the background
  cap: 600,           // components per layer before the layer is abandoned
  run: 4,             // glyphs in a row before it counts as a word
  minH: 0.014,        // glyph height as a fraction of the panel
  maxH: 0.30,
  minFill: 0.10,      // component pixels over bounding box area
  maxFill: 0.86,
  minStroke: 0.05,    // stroke width over glyph height: thinner is a hairline
  maxStroke: 0.34,    // ...and thicker is a solid shape, not a letter
  strokeVar: 0.26,    // a word is set in one weight, so its glyphs are drawn
                      // with one stroke. A row of trees or of windowed towers
                      // is the same line of varied shapes on a baseline and
                      // this is what it fails.
  heightVar: 0.18,    // glyphs in a word are near enough the same height
  widthVar: 0.04,     // ...and are not one shape stamped out over and over,
                      // which is all this has to catch now that stroke width
                      // does the heavy lifting — DOGS is four letters of nearly
                      // equal width and must still count.
  density: 0.50,      // ...and cover this much of the row they sit in, which
                      // scattered shapes that happen to line up do not
  baseline: 0.34,     // bottoms align within this fraction of glyph height
  gap: 2.4,           // and sit within this many median widths of each other
  span: 0.10,         // the row covers at least this much of the panel's width
};

/** Box-averaged copy, so a 1500px panel is searched at 600 and thin strokes survive. */
function shrink(bm: Bitmap, max: number): Bitmap {
  const k = Math.max(1, Math.ceil(Math.max(bm.width, bm.height) / max));
  if (k === 1) return bm;
  const width = Math.max(1, Math.floor(bm.width / k));
  const height = Math.max(1, Math.floor(bm.height / k));
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * bm.width + (x * k + dx)) * 4;
          r += bm.rgba[i]; g += bm.rgba[i + 1]; b += bm.rgba[i + 2]; a += bm.rgba[i + 3];
          n++;
        }
      }
      const d = (y * width + x) * 4;
      rgba[d] = r / n; rgba[d + 1] = g / n; rgba[d + 2] = b / n; rgba[d + 3] = a / n;
    }
  }
  return { width, height, rgba };
}

type Piece = { x0: number; y0: number; x1: number; y1: number; area: number; stroke: number };

/** Coefficient of variation — spread as a fraction of the mean. */
function variation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!mean) return 0;
  const v = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(v) / mean;
}

/**
 * True when the panel carries something shaped like a word. Read alongside the
 * model's verdict in check-image, which is what settles it — see the note above
 * on what shape alone can and cannot tell you.
 */
export function findText(full: Bitmap): { found: boolean; note: string } {
  const bm = shrink(full, TEXT.work);
  const { width: W, height: H } = bm;
  const N = W * H;

  // Colour layers, 3 bits a channel. A word is drawn in one flat colour.
  const counts = new Int32Array(512);
  const key = new Int16Array(N);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    if (bm.rgba[i + 3] < 128) { key[p] = -1; continue; }
    const k = ((bm.rgba[i] >> 5) << 6) | ((bm.rgba[i + 1] >> 5) << 3) | (bm.rgba[i + 2] >> 5);
    key[p] = k;
    counts[k]++;
  }
  const layers = [...counts.keys()]
    .filter((k) => counts[k] >= N * TEXT.minShare && counts[k] <= N * TEXT.maxShare)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, TEXT.layers);

  const minH = H * TEXT.minH, maxH = H * TEXT.maxH;
  const seen = new Int32Array(N);
  const stack = new Int32Array(N);
  let mark = 0;

  for (const layer of layers) {
    mark++;
    const pieces: Piece[] = [];
    for (let p = 0; p < N && pieces.length <= TEXT.cap; p++) {
      if (key[p] !== layer || seen[p] === mark) continue;
      seen[p] = mark;
      let head = 0, tail = 0;
      stack[tail++] = p;
      let x0 = W, y0 = H, x1 = 0, y1 = 0, area = 0, edge = 0;
      while (head < tail) {
        const q = stack[head++], x = q % W, y = (q / W) | 0;
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        const walk = (n: number, inside: boolean) => {
          if (!inside || key[n] !== layer) { edge++; return; }
          if (seen[n] !== mark) { seen[n] = mark; stack[tail++] = n; }
        };
        walk(q - 1, x > 0);
        walk(q + 1, x < W - 1);
        walk(q - W, y > 0);
        walk(q + W, y < H - 1);
      }
      const h = y1 - y0 + 1, w = x1 - x0 + 1;
      const fill = area / (w * h);
      // Area over half the perimeter is the width of the stroke that drew it.
      const stroke = edge ? (2 * area) / edge / h : 1;
      if (h < minH || h > maxH) continue;
      if (w < 2 || w > h * 4) continue;                  // a bar, a rule, a stripe
      if (fill < TEXT.minFill || fill > TEXT.maxFill) continue;
      if (stroke < TEXT.minStroke || stroke > TEXT.maxStroke) continue;
      pieces.push({ x0, y0, x1, y1, area, stroke });
    }
    if (pieces.length > TEXT.cap) continue;              // noise, not lettering

    // A word: glyphs of a kind on one baseline, spaced like a word, and not
    // all the same width.
    for (const seed of pieces) {
      const sh = seed.y1 - seed.y0 + 1;
      const row = pieces
        .filter((c) => {
          const h = c.y1 - c.y0 + 1;
          return Math.abs(c.y1 - seed.y1) <= sh * TEXT.baseline && h >= sh * 0.72 && h <= sh * 1.4;
        })
        .sort((a, b) => a.x0 - b.x0);
      if (row.length < TEXT.run) continue;

      const widths = row.map((c) => c.x1 - c.x0 + 1).sort((a, b) => a - b);
      const median = widths[widths.length >> 1];
      let start = 0;
      for (let i = 1; i <= row.length; i++) {
        const broken = i === row.length || row[i].x0 - row[i - 1].x1 > median * TEXT.gap;
        if (!broken) continue;
        const word = row.slice(start, i);
        start = i;
        if (word.length < TEXT.run) continue;
        const span = word[word.length - 1].x1 - word[0].x0;
        if (span < W * TEXT.span) continue;
        const hs = word.map((c) => c.y1 - c.y0 + 1);
        const ws = word.map((c) => c.x1 - c.x0 + 1);
        if (variation(hs) > TEXT.heightVar) continue;
        if (variation(word.map((c) => c.stroke)) > TEXT.strokeVar) continue;
        if (variation(ws) < TEXT.widthVar) continue;     // one shape repeated, not a word
        const ink = ws.reduce((a, b) => a + b, 0) / (span + 1);
        if (ink < TEXT.density) continue;                // scattered, not set
        return {
          found: true,
          note: `${word.length} letter-shaped marks sit in a row across ${Math.round((span / W) * 100)}% of the panel, so it has lettering on it.`,
        };
      }
    }
  }
  return { found: false, note: "" };
}

type Bitmap = { width: number; height: number; rgba: Uint8Array };

/**
 * Decodes an 8-bit non-interlaced PNG. Returns null for anything else —
 * 16-bit, palette, interlaced, or not a PNG at all — because a check that
 * cannot run must cost the caller nothing.
 */
export function decodePng(buf: Buffer): Bitmap | null {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || SIG.some((b, i) => buf[i] !== b)) return null;

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colour = buf[25];
  const interlace = buf[28];
  if (depth !== 8 || interlace !== 0) return null;

  // Greyscale, RGB, greyscale+alpha, RGBA. Palette (3) needs the PLTE chunk and
  // is not what a generator returns.
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (!channels) return null;
  if (width < 1 || height < 1 || width * height > 40e6) return null;

  const parts: Buffer[] = [];
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    if (type === "IDAT") parts.push(buf.subarray(p + 8, p + 8 + len));
    if (type === "IEND") break;
    p += 12 + len;
  }
  if (!parts.length) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(parts));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return null;

  // Undo the per-scanline filters. Each row is predicted from the one above and
  // the pixel to the left, so this has to run in order, whole image.
  const out = Buffer.alloc(height * stride);
  for (let y = 0, at = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const up = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= channels ? up[x - channels] : 0;
      const v = line[x];
      let px: number;
      switch (filter) {
        case 0: px = v; break;
        case 1: px = v + a; break;
        case 2: px = v + b; break;
        case 3: px = v + ((a + b) >> 1); break;
        case 4: {
          const p0 = a + b - c;
          const pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
          px = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      cur[x] = px & 255;
    }
  }

  // Widened to RGBA so the checks below do not care which form came in.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels, d = i * 4;
    if (channels <= 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s];
      rgba[d + 3] = channels === 2 ? out[s + 1] : 255;
    } else {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2];
      rgba[d + 3] = channels === 4 ? out[s + 3] : 255;
    }
  }
  return { width, height, rgba };
}

function hex(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Mean colour and alpha of a square patch, used on the four corners. */
function patch(bm: Bitmap, x0: number, y0: number) {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = y0; y < y0 + CORNER; y++) {
    for (let x = x0; x < x0 + CORNER; x++) {
      const i = (y * bm.width + x) * 4;
      r += bm.rgba[i]; g += bm.rgba[i + 1]; b += bm.rgba[i + 2]; a += bm.rgba[i + 3];
      n++;
    }
  }
  return { r: r / n, g: g / n, b: b / n, a: a / n };
}

/**
 * Reads the panel and says what is wrong with it. An image it cannot decode
 * comes back clean — see the note on failing open at the top.
 */
export function checkPanel(image: { data: string; mediaType: string }, palette: string[]): PanelReport {
  if (!/^image\/png$/i.test(image.mediaType)) return NONE;

  let bm: Bitmap | null = null;
  try {
    bm = decodePng(Buffer.from(image.data, "base64"));
  } catch (err) {
    console.warn("check-panel: could not read the panel, letting it through", err);
    return NONE;
  }
  if (!bm) return NONE;

  const issues: PanelIssue[] = [];
  const notes: string[] = [];

  // 1. Full bleed. A model told to fill the frame still likes to centre a
  //    subject on white, and white corners become bare fabric after clipping.
  const corners = [
    patch(bm, 0, 0),
    patch(bm, bm.width - CORNER, 0),
    patch(bm, 0, bm.height - CORNER),
    patch(bm, bm.width - CORNER, bm.height - CORNER),
  ];
  const blank = corners.filter((c) => c.a < 250 || (c.r > 242 && c.g > 242 && c.b > 242));
  if (blank.length) {
    issues.push("margins");
    notes.push(
      `${blank.length} of the four corners are blank or transparent, so the artwork is not full bleed.`,
    );
  }

  // 2. Palette. Sampled on a fixed lattice rather than at random, so the same
  //    panel always gets the same verdict.
  const wanted = palette.map(hex).filter(Boolean) as [number, number, number][];
  if (wanted.length) {
    const step = Math.max(1, Math.floor(Math.sqrt((bm.width * bm.height) / SAMPLES)));
    let near = 0, seen = 0;
    for (let y = (step >> 1); y < bm.height; y += step) {
      for (let x = (step >> 1); x < bm.width; x += step) {
        const i = (y * bm.width + x) * 4;
        if (bm.rgba[i + 3] < 128) continue;
        seen++;
        for (const [r, g, b] of wanted) {
          const dr = bm.rgba[i] - r, dg = bm.rgba[i + 1] - g, db = bm.rgba[i + 2] - b;
          if (dr * dr + dg * dg + db * db <= TOLERANCE) { near++; break; }
        }
      }
    }
    const share = seen ? near / seen : 1;
    if (share < ON_PALETTE) {
      issues.push("palette");
      notes.push(
        `Only ${Math.round(share * 100)}% of the panel is near the colors that were asked for.`,
      );
    }
  }

  // 3. Lettering. The panel carries no type at all: the crest, the name and the
  //    number are a separate vector layer laid on after compositing.
  const type = findText(bm);
  if (type.found) {
    issues.push("text");
    notes.push(type.note);
  }

  // 4. Square. The compositor draws the master across a square canvas, so a
  //    panel of another shape has to be cropped and the two sleeves stop
  //    matching across the seam. Worth saying; not worth refusing over.
  if (bm.width !== bm.height) {
    issues.push("aspect");
    notes.push(
      `The panel is ${bm.width}×${bm.height}, not square, and will be centre-cropped before it is used.`,
    );
  }

  return { issues, notes, size: { width: bm.width, height: bm.height } };
}
