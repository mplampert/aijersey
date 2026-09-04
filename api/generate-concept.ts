import { experimental_generateImage as generateImage, generateText } from "ai";
// Compiled output is .js, and the runtime resolves this specifier verbatim —
// so it names the built file, not the source. A ".ts" here type-checks fine
// locally and then 500s in production.
import { checkImage } from "./check-image.js";
import { checkPanel, type PanelIssue } from "./check-panel.js";

/**
 * POST /api/generate-concept
 *
 * Generates the finished sales image: a photograph of the jersey, front and
 * back on wooden hangers, with real drape and real light on it.
 *
 * The model draws the garment. There was a pipeline here that took the garment
 * away from it — a flat artwork panel clipped through the region masks of a
 * fixed 3D render — and the compositor that does it still stands at /mockup/,
 * with its assets, unused. What it bought was a garment that never changed
 * shape; what it cost was that the render is one jersey on one hanger-less
 * silhouette, and a flat panel through it reads as a drawing rather than as a
 * photograph of a thing you can buy. This endpoint is now the second of those.
 *
 * The crest does not come from the model. It is composited onto the returned
 * photograph in the browser, so the chest is asked for clear and the customer's
 * own file goes on untouched. Neither does any lettering: no image model sets
 * type legibly, whatever it is rendering, and every word one draws has to be
 * thrown away. The team name goes on as type afterwards.
 *
 * Not production art. The factory redraws from this, and the customer approves
 * the factory's 48-hour proof, never this image.
 *
 * Routed through Vercel AI Gateway, so one key covers every provider and
 * swapping models is a string change below.
 *
 * Env var required: AI_GATEWAY_API_KEY
 */

// Confirm the exact slug in your Vercel AI Gateway model list before launch —
// these move. Candidates: "openai/gpt-image-2" (best prompt adherence),
// "google/gemini-2.5-flash-image" (cheapest), "black-forest-labs/flux-2-pro".
const MODEL = "openai/gpt-image-2";

// Refinement needs the previous panel as an input image, and generateImage()
// has no parameter for one — ImageModelV2CallOptions is prompt-only, for every
// provider, so no image model can edit through it. Editing therefore runs
// through generateText with a multimodal image model, which takes the previous
// panel as a file part and returns the edit in result.files.
const EDIT_MODEL = "google/gemini-2.5-flash-image";

/* Two views side by side, so a square frame spends most of its pixels on air
   above and below the jerseys and hands the customer two small ones. Landscape
   first, square only if the model refuses the size — a size a slug does not
   happen to accept must not be able to take generation down. */
const SIZES = ["1536x1024", "1024x1024"] as const;

// Screened before spending a call. Crude on purpose — the real gate is the
// human review on every 48-hour proof.
const BLOCKED = [
  "nhl", "nfl", "nba", "mlb", "star wars", "marvel", "disney", "pokemon",
  "bruins", "rangers", "maple leafs", "canadiens", "penguins", "oilers",
  "olympic", "team canada", "team usa hockey", "espn", "nike", "adidas",
  "bauer", "ccm", "warrior hockey",
];

const STYLE_DEFAULT =
  "sharp product photography, soft even studio lighting, natural fabric drape, " +
  "high detail, in focus from edge to edge";

/* Everything the image must not contain.
 *
 * The type terms are scoped now rather than absolute. They used to ban lettering
 * outright, which was right while the back was not being asked for — but the
 * back carries a nameplate and a number, so a blanket "no text" takes those with
 * it. What has not changed is why the terms are here at all: no image model sets
 * type legibly, and eleven generations in a row came back with a garbled team
 * name across the chest. So every place type is not wanted is named, and the one
 * place it is wanted is spelled out in NAMEPLATE, twice.
 *
 * The emblem terms stay absolute. The customer's crest is composited onto the
 * finished photograph in the browser, so a crest the model invents is a second
 * one sitting under ours. */
const NEGATIVE = [
  "no lettering on the front of the jersey", "no text on the chest",
  "no team name", "no club name", "no city name", "no real player name",
  "no lettering on the sleeves", "no lettering on the shoulders",
  "no lettering on the collar", "no lettering on the socks",
  "no numbers on the front", "no numbers on the socks", "no sleeve numbers",
  "no captions", "no signage", "no signature", "no date", "no watermark",
  "no badge", "no medallion", "no shield", "no roundel", "no monogram",
  "no wordmark", "no coat of arms", "no enclosing border around the chest motif",
  "no brand marks", "no manufacturer logos", "no neck tags", "no hem tags",
  "no league marks", "no real-world team logos",
  "no ankle socks", "no crew socks", "no footwear", "no shoes", "no feet",
  "no waistband", "no elastic", "no cuff", "no ribbing", "no pants",
  "no leggings", "no shorts",
].join(", ");

/* The shot. Said before the palette, because the negative list at the end is
   the last thing read and a model needs to be told what it is making as well as
   what to leave out.

   Both views are asked for in one image so the two stay consistent with each
   other — a second call would return a different garment for the back. */
const SHOT = [
  "Product photograph of a custom sublimated ice hockey kit.",
  "The jersey is shown twice: the front view and the back view side by side, each",
  "on its own wooden hanger, hanging naturally with real fabric drape, soft folds",
  "and creases in the cloth.",
  "Alongside them, laid flat, is a matching pair of ice hockey leg socks — the",
  "kind pulled on over shin guards. Each is a tall open knitted tube, open at",
  "both ends, with no foot and no waistband: widest at the top and tapering",
  "steadily toward the bottom, roughly knee to thigh length, with visible panel",
  "seams running down its length and a set of horizontal stripes across its lower",
  "third. One sock shows its front, the other its back.",
  "Soft, even studio lighting with gentle shadows. Plain neutral light grey",
  "background, no props, no model, no mannequin.",
  "The front and the back are the same garment and the same design: the same yoke,",
  "the same stripes at the same height and the same placement, the same collar,",
  "the same sleeve design and the same color blocking. Anything that appears on",
  "one appears on the other in the same place. The socks carry that same stripe",
  "pattern, at the same proportions, in the same palette.",
  "Every piece is shown complete and in full: both jerseys entire from collar to",
  "hem, and both socks entire and full length, from the open top to the open",
  "tapered bottom. Nothing is",
  "cropped by the edge of the frame or runs off it, and nothing overlaps anything",
  "else. Leave a clear margin of background around the whole kit.",
  "No border, no frame, no vignette.",
].join(" ");

/* The single exception to the type ban, and it has to be stated twice: once as
 * what the back carries, and once after the negative list, because a list that
 * says "no lettering" eight ways will otherwise take the nameplate with it.
 *
 * Placeholders, not a real name or number. The concept sells the design, and
 * every jersey on the roster gets a different pair — so NAME and 00 is what the
 * factory proof carries and what this should show. It also means the checker has
 * one exact string to allow and can reject everything else, garbled spellings of
 * NAME included. */
const NAMEPLATE =
  "The back view carries a large two-digit player number low on the back, with a " +
  "nameplate above it across the shoulders. The nameplate reads exactly NAME and " +
  "the number is exactly 00 — these are placeholders, never an invented player " +
  "name or number. Both must stay clearly legible against whatever artwork sits " +
  "behind them. The front carries no lettering at all.";

/* The design has a subject. Left to itself a model gives back a stripe set on a
   solid body — the safe, sewn-twill answer it has seen most — and a customer who
   asked for a tropical beach gets a teal jersey with two orange bands on it. So
   the theme is asked for as an environment that runs across the garment, with
   something at the chest to look at. */
const SCENE = [
  "Build the design around the theme as an illustrated scene, not as a stripe",
  "pattern. There is an environment: a place, with a foreground, a background and",
  "depth, running across the body, over the shoulders and down the sleeves as one",
  "continuous picture.",
  "Avoid a plain stripe-on-solid layout unless the theme specifically calls for",
  "one.",
].join(" ");

/* Where the eye lands. Only when the customer has no crest of their own — when
   they do, that file is composited onto this chest afterwards and anything the
   model puts there ends up underneath it. */
const MASCOT =
  "At the centre chest of the front view, as the focal point of the design, place " +
  "a single mascot or icon drawn from the theme: one clear subject, large enough " +
  "to read from across the rink, sitting within the scene rather than pasted on " +
  "top of it. It is illustration, not a badge — no enclosing circle, shield or " +
  "roundel around it, and no lettering in or near it.";

/* This is a sublimated garment, and left alone a model reproduces what it has
   seen most of: sewn twill, a solid body with a stitched stripe set. Full-body
   artwork is the reason a customer picks this process, so the brief says so. */
const SUBLIMATION = [
  "The artwork is printed into the fabric across the entire garment: no sewn",
  "panels, no appliqué, no stitched stripes to design around, and no part of the",
  "jersey off limits to the print — not the shoulders, not the sleeves, not the",
  "hem. Gradients, fades, textures and large graphic elements cost nothing here,",
  "so use them rather than flattening the design into blocks of solid color.",
].join(" ");

/* Three takes on the same brief, so the options the customer picks between
   differ by intent rather than by chance. What moves is how hard each one leans
   on the print. Keys match CFG.variants in index.html. */
const VARIANTS: Record<string, string> = {
  safe:
    "Play this one restrained: the scene quieter and simpler, softer contrast, fewer elements, the chest motif smaller. Understated is the brief here — plain is not, and the scene still carries the whole garment.",
  scene:
    "Push this one as far as the process goes: the fullest version of the scene, painted depth, foreground and background, obviously printed and impossible to sew.",
  bold:
    "Make this one graphic: large-scale shapes, hard edges, oversized motifs running off the edges of the garment at full bleed. High contrast and poster-like.",
};

/* The team name, the player names and the numbers never reach the image prompt.
 * They drive the vector crest and nameplate layers, which are laid on after
 * compositing, and an image model handed a name draws it — eleven panels in a
 * row came back with it on them, garbled every time, because no image model
 * sets type legibly.
 *
 * The page does not put the name in the brief any more, but the brief is a free
 * text box and a customer who types their own team name into it is doing
 * nothing wrong. So the name travels in its own field, is never interpolated
 * anywhere, and is scrubbed back out of the theme if it turns up there.
 *
 * Digits are left alone. "1970s" and "three stripes" are legitimate briefs, the
 * negative list already refuses numerals, and player numbers only exist on the
 * roster, which this endpoint is never sent. */
export function scrub(theme: string, names: string[]): string {
  let out = theme;
  for (const name of names) {
    const word = name.trim();
    if (word.length < 3) continue;
    out = out.replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " ");
  }
  return out.replace(/\s{2,}/g, " ").replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "").trim();
}

/* Collar and silhouette, picked by the customer in step 1, so the garment is
   specified rather than invented afresh on every call. Keys match CFG.styles in
   index.html. */
const STYLES: Record<string, string> = {
  laced:
    "The collar is a traditional laced collar: a short lace-up placket at the throat, laces visible.",
  vneck:
    "The collar is a modern V-neck: a clean V opening at the throat, no lacing and no placket.",
  crew:
    "The collar is a plain crew neck: a round ribbed collar, no lacing, no placket and no V.",
};
const DEFAULT_STYLE = "laced";

export type ConceptInput = {
  theme: string;          // "tropical beach with palm trees and hibiscus"
  palette: string[];      // ["#F26722", "#2E9BA6", "#E8D5B0"] — 3 to 5
  look?: string;          // photographic treatment, defaults to STYLE_DEFAULT
  collar?: string;        // one of STYLES
  variant?: string;       // one of VARIANTS
  ownCrest?: boolean;     // the customer has a logo, so leave the chest clear
};

/**
 * The prompt, clause by clause. Each one is load-bearing.
 *
 * It runs about 4,500 characters. gpt-image-1 takes 32,000 and this is nowhere
 * near it, but a model with a 4,000 limit would truncate — and it truncates from
 * the end, which is where the negative list and its one exception live. Check
 * the limit before changing MODEL.
 *
 *
 * The shot first, because "product photograph ... on wooden hangers" is what
 * decides whether this reads as something you can buy or as a drawing of a
 * jersey. Both views in one image, because two calls return two different
 * garments. The sublimation clauses because a model left alone reproduces sewn
 * twill, which is the one process this is not. The explicit hex palette because
 * it is what ties the garment to the team, three to five values, since past
 * five the constraint gets ignored. A clear chest when the customer has their
 * own crest, because that file is composited on afterwards and needs somewhere
 * calm to sit. And the negative list last, which is now almost entirely about
 * type: every word the model draws has to be thrown away.
 */
export function buildPrompt(i: ConceptInput): string {
  return [
    SHOT,
    STYLES[i.collar ?? ""] ?? STYLES[DEFAULT_STYLE],
    NAMEPLATE,
    SUBLIMATION,
    SCENE,
    `The design: ${i.theme}.`,
    `Color palette limited strictly to: ${i.palette.join(", ")}. Tints, shades, blends and gradients between them are encouraged; do not introduce a hue that is not on this list.`,
    i.look ?? STYLE_DEFAULT,
    /* The chest belongs to one of them, never both. */
    i.ownCrest
      ? "Leave the centre chest of the front view clear for the team's own crest, which is composited on afterwards: no mascot, no icon, no crest, no logo, no monogram, no graphic element and no lettering of any kind there. The scene still runs across the rest of the garment, but it must settle into a calm, uncluttered area at the centre chest so a crest can sit on top of it and still read."
      : MASCOT,
    VARIANTS[i.variant ?? ""] ?? "",
    NEGATIVE,
    // Last, because the list above is emphatic and this is its one exception.
    "The only lettering anywhere in the image is the nameplate reading NAME and the number 00 on the back view. Nothing else in the image carries any letters, words or numbers.",
  ]
    .filter(Boolean)
    .join(" ");
}

type Ref = { data: string; mediaType: string };
type Made = { base64: string; mediaType: string };

/**
 * Runs a model call twice before giving up. These calls fail intermittently —
 * two of three variants have come back empty in one run — and each variant is
 * an option the customer would otherwise lose. A call that returns no image at
 * all counts as a failure and is retried the same way.
 */
async function twice<T>(
  label: string,
  call: () => Promise<T | null>,
): Promise<T | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await call();
      if (out) return out;
      if (attempt === 1) console.warn(`generate-concept: ${label} returned no image, retrying`);
    } catch (err) {
      if (attempt === 2) throw err;
      console.warn(`generate-concept: ${label} failed, retrying`, err);
    }
  }
  return null;
}

/** A concept to show, a reason not to show one, or nothing that came back at all. */
type Produced =
  | { ok: true; made: Made }
  | { ok: false; dropped: string }
  | null;

const FIX_MARKS =
  "A previous attempt showed %s. Do not include %s, or any other real-world league, team, brand or manufacturer mark, anywhere in the artwork.";
const FIX_TEXT =
  "A previous attempt had lettering on it (%s). This artwork must contain no letters, words, numbers or characters of any kind, in any language or script, however stylised or decorative. The team name is added afterwards as separate type and must never be drawn into the artwork.";

/**
 * Draws, checks, and draws once more if the check came back dirty.
 *
 * Two attempts and no more: two or three tries per usable panel is the expected
 * rate and the customer is waiting. Whatever the second attempt returns is what
 * they get — unless it is still carrying a mark or lettering, in which case they
 * get nothing rather than that. A panel with a garbled word printed into it is
 * not a design we can sell, and showing it while promising to fix it later is
 * how it ends up on a jersey.
 */
async function produce(
  what: string,
  make: (extra: string) => Promise<Made | null>,
): Promise<Produced> {
  let last: Produced = null;

  for (let attempt = 1, extra = ""; attempt <= 2; attempt++) {
    const made = await make(extra);
    if (!made) return last ?? null;

    const seenBy = { data: made.base64, mediaType: made.mediaType || "image/png" };
    const [verdict, panel] = await Promise.all([
      checkImage(seenBy),
      Promise.resolve(checkPanel(seenBy)),
    ]);

    /* Only the model gets a vote on lettering now. The back is supposed to carry
       a nameplate and a number, and the pixel detector sees shapes rather than
       characters — it cannot tell NAME from NAMF, so it fires on every correct
       image. It stays as a log line: if it says there is type and the model says
       there is none, one of them is wrong and that is worth being able to see. */
    const lettering = verdict.lettering;
    const said = verdict.letters.join("; ") || "garbled type";
    if (!verdict.ok && panel.issues.includes("text")) {
      console.warn("check: no model verdict and the pixels look like type", { what, note: panel.notes[0] });
    }

    const fixes: string[] = [];
    if (verdict.found) fixes.push(FIX_MARKS.replaceAll("%s", verdict.marks.join(", ") || "a real-world mark"));
    if (lettering) fixes.push(FIX_TEXT.replace("%s", said));

    last = { ok: true, made };

    if (!fixes.length) return last;

    if (attempt === 2) {
      if (verdict.found) {
        console.warn("check: dropped after redraw", { what, marks: verdict.marks });
        return { ok: false, dropped: DROPPED_MARK };
      }
      if (lettering) {
        console.warn("check: dropped after redraw", { what, letters: verdict.letters, note: said });
        return { ok: false, dropped: DROPPED_TEXT };
      }
      return last;
    }

    console.warn("check: redrawing", {
      what,
      marks: verdict.marks,
      lettering,
      letters: verdict.letters,
      pixels: panel.notes,
      modelChecked: verdict.ok,
    });
    extra = fixes.join(" ");
  }
  return last;
}

const DROPPED_MARK =
  "One take kept coming back with a real team's logo on it, so we left it out. Try again for another.";
const DROPPED_TEXT =
  "One take kept coming back with lettering printed into the artwork, so we left it out. Your team name goes on as type afterwards, not into the design. Try again for another.";

/** One multimodal draw: the text plus whatever reference images go with it. */
async function draw(
  content: ({ type: "text"; text: string } | { type: "file"; data: string; mediaType: string })[],
) {
  const { files } = await generateText({
    model: EDIT_MODEL,
    messages: [{ role: "user", content }],
  });
  return files.find((f) => f.mediaType?.startsWith("image/")) ?? null;
}

/** A base64 data URL from the page, or null if it is missing or malformed. */
function readDataUrl(value: string | null | undefined): Ref | null {
  if (!value) return null;
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

type Body = {
  // What the artwork is of. `prompt` is what the order page has always sent.
  theme?: string;
  prompt?: string;
  // Three to five hex values. `colors` is the order page's colour card entries.
  palette?: string[];
  colors?: { name: string; hex: string }[];
  // One of the keys of STYLES: the collar the customer picked in step 1.
  style?: string;
  // Whether the customer has their own crest. The file itself never comes here:
  // it is composited onto the finished photograph in the browser.
  ownCrest?: boolean;
  /* Sent so they can be removed, never so they can be drawn. See scrub(). The
     roster is not accepted at all: player names and numbers belong to the
     nameplate, which the model is not asked for either. */
  teamName?: string;
  playerNames?: string[];
  // One of the keys of VARIANTS. Omitted on a refinement, and for anything
  // unrecognised the brief is drawn straight with no variant steer.
  variant?: string;
  // Data URL of the concept being refined. Absent on the first generation.
  baseImage?: string | null;
};

export async function POST(request: Request): Promise<Response> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json(
      { error: "AI_GATEWAY_API_KEY is not set" },
      { status: 500 },
    );
  }

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  /* Scrubbed before it is read for anything: the block list, the prompt, the
     edit instruction. Names reach this endpoint only to be taken back out. */
  const theme = scrub(
    (body.theme || body.prompt || "").trim().slice(0, 600),
    [body.teamName ?? "", ...(body.playerNames ?? [])].filter(Boolean),
  );
  if (!theme) {
    return Response.json(
      { error: "Describe the artwork first" },
      { status: 400 },
    );
  }

  // Only data URLs — the browser sends back an image this function produced.
  const base = readDataUrl(body.baseImage);
  if (body.baseImage && !base) {
    return Response.json(
      { error: "That artwork couldn't be read. Generate a new one and refine from there." },
      { status: 400 },
    );
  }

  const hit = BLOCKED.find((b) => theme.toLowerCase().includes(b));
  if (hit) {
    return Response.json(
      {
        error:
          `We can't copy "${hit}" — that team or brand belongs to someone ` +
          `else. Tell us the colors and the feel you're after — bold and ` +
          `modern, old-school, dark and mean — and we'll build something ` +
          `original for you.`,
      },
      { status: 422 },
    );
  }

  /* Five at the outside. The constraint is what ties the artwork to the team,
     and a model handed six hex codes starts treating the list as a suggestion. */
  const palette = (body.palette ?? body.colors?.map((c) => c.hex) ?? [])
    .filter((h) => /^#?[0-9a-f]{6}$/i.test(h))
    .slice(0, 5);
  if (!palette.length) {
    return Response.json(
      { error: "Pick some colors first — the artwork is built from them." },
      { status: 400 },
    );
  }

  const instruction = buildPrompt({
    theme,
    palette,
    collar: body.style,
    variant: body.variant,
    ownCrest: !!body.ownCrest,
  });

  /* An edit is told to change one thing, so the brief is not repeated — but
     everything that would break the picture is, because a refinement is just as
     free to letter the chest or lose the back view as a generation is. */
  const editInstruction = [
    "Edit the attached photograph of an ice hockey jersey.",
    "Make only this change, described by the customer:",
    theme,
    "Everything else must stay exactly as it is — the same garment, the same layout, the same striping and the same colors wherever the requested change does not touch them.",
    "Keep the front view and the back view side by side on their hangers and the socks laid alongside, in the same arrangement as the attached image, every piece complete and uncropped, and every piece the same kit as the others.",
    NAMEPLATE,
    `Color palette limited strictly to: ${palette.join(", ")}.`,
    NEGATIVE,
  ].join(" ");

  try {
    if (base) {
      const edited = await produce("refinement", (extra) =>
        twice("edit", () =>
          draw([
            { type: "text", text: extra ? `${editInstruction} ${extra}` : editInstruction },
            { type: "file", data: base.data, mediaType: base.mediaType },
          ]),
        ),
      );
      if (edited && !edited.ok) return Response.json({ error: edited.dropped }, { status: 422 });
      if (!edited) {
        // The model answered in text instead of returning an image. Say so
        // rather than falling back to a fresh generation, which would throw
        // away the panel the customer is refining.
        return Response.json(
          { error: "That change didn't come back as an image. Try describing it differently." },
          { status: 502 },
        );
      }
      return Response.json({
        image: `data:${edited.made.mediaType || "image/png"};base64,${edited.made.base64}`,
      });
    }

    const drawn = await produce(body.variant ?? "generation", (extra) =>
      twice("generation", async () => {
        const text = [instruction, extra].filter(Boolean).join(" ");
        for (const size of SIZES) {
          try {
            const { image } = await generateImage({ model: MODEL, prompt: text, size });
            if (image) return image;
          } catch (err) {
            if (size === SIZES[SIZES.length - 1]) throw err;
            console.warn(`generate-concept: ${MODEL} refused ${size}, falling back`, err);
          }
        }
        return null;
      }),
    );

    if (drawn && !drawn.ok) return Response.json({ error: drawn.dropped }, { status: 422 });
    if (!drawn) {
      return Response.json(
        { error: "That didn't come back as an image. Try again in a moment." },
        { status: 502 },
      );
    }
    return Response.json({
      image: `data:${drawn.made.mediaType || "image/png"};base64,${drawn.made.base64}`,
    });
  } catch (err) {
    console.error("generate-concept failed", err);
    return Response.json(
      { error: "Couldn't generate that artwork. Try describing it differently." },
      { status: 502 },
    );
  }
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
