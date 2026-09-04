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

export type PanelIssue = "margins" | "palette" | "aspect";
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

  // 3. Square. The compositor draws the master across a square canvas, so a
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
