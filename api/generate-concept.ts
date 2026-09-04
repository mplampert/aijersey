import { experimental_generateImage as generateImage, generateText } from "ai";
// Compiled output is .js, and the runtime resolves this specifier verbatim —
// so it names the built file, not the source. A ".ts" here type-checks fine
// locally and then 500s in production.
import { checkImage } from "./check-image.js";
import { checkPanel, type PanelIssue } from "./check-panel.js";

/**
 * POST /api/generate-concept
 *
 * Generates the artwork panel only — a flat illustrated square, no garment.
 *
 * The jersey it goes on is a fixed 3D render, and the mockup compositor at
 * /mockup/ clips this panel through the garment's four region masks and lays
 * the render's own shading back over the top. So the model is never asked for
 * a jersey. Asked for one it returns a different garment every time, and the
 * shadows it paints fight the real shading pass and the composite goes muddy.
 *
 * That inversion is the whole point of this endpoint: the garment is ours, the
 * artwork is the model's. So is the crest — it is a separate vector layer laid
 * on after compositing, driven by the team name, so the panel carries no emblem
 * of its own either. Background treatment, edge to edge, and nothing else.
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

/* The compositor's canvas is 1500 square. Ask for the nearest square the model
   will give and take 1024 if it refuses — a size a slug does not happen to
   accept must not be able to take generation down. Anything short of 1500 is
   scaled up when the compositor fits it to the garment, which is one drawImage
   there and would be a whole image library here. */
const SIZES = ["1536x1536", "1024x1024"] as const;

// Screened before spending a call. Crude on purpose — the real gate is the
// human review on every 48-hour proof.
const BLOCKED = [
  "nhl", "nfl", "nba", "mlb", "star wars", "marvel", "disney", "pokemon",
  "bruins", "rangers", "maple leafs", "canadiens", "penguins", "oilers",
  "olympic", "team canada", "team usa hockey", "espn", "nike", "adidas",
  "bauer", "ccm", "warrior hockey",
];

const STYLE_DEFAULT =
  "bold flat color fills, clean confident line work, screen-print style, " +
  "high contrast, vector illustration";

/* Everything the panel must not contain.
 *
 * The lighting terms carry a lot of the weight: Base.png supplies all the
 * shading, so a shadow the model paints is a second light source arguing with
 * the first.
 *
 * The emblem terms carry the rest. Asked for artwork for a hockey jersey a
 * model reaches for the composition it has seen most — a crest in the middle of
 * a chest — and returns a centred medallion with the treatment arranged around
 * it. That is wrong twice over: the crest is a separate vector layer laid on
 * after compositing, driven by the team name, and one baked into the print is
 * not something the factory can separate back out. Naming the shapes it reaches
 * for is what stops it; "no logo" alone did not. */
const NEGATIVE = [
  "no jersey", "no shirt", "no garment", "no clothing", "no fabric",
  "no folds", "no wrinkles", "no shadows", "no highlights", "no lighting",
  "no 3d render", "no mockup", "no hanger", "no mannequin", "no person",
  "no text", "no letters", "no words", "no lettering", "no typography",
  "no script", "no numbers", "no logo",
  "no emblem", "no badge", "no medallion", "no shield", "no roundel",
  "no centered logo mark", "no crest", "no monogram", "no wordmark",
  "no central motif", "no circular device", "no coat of arms",
  "no watermark", "no borders", "no margins", "no frame", "no drop shadow",
].join(", ");

/* Said before the palette, because the negative list at the end is the last
   thing read and a model needs to be told what the panel is as well as what it
   is not. Continuous treatment across the whole square is the shape of the
   thing: whatever it draws has to survive being cut into a body, a yoke, two
   sleeves and a collar, and a composition with a middle to it does not. */
const BACKGROUND =
  "This is background treatment only: continuous pattern, stripes, bands, " +
  "texture or an allover scene, running unbroken across the entire square. " +
  "It has no focal point and no centerpiece. Nothing is placed in the middle " +
  "of the panel: no emblem, badge, medallion, shield, roundel, crest or " +
  "centered logo mark of any kind, and no lettering. The team's crest is " +
  "added afterwards as a separate layer and must not appear in this artwork.";

/* Optional, and a nudge rather than a guarantee — models follow it
   inconsistently. The masks put the shoulder yoke in the top quarter or so and
   the hem in the bottom third, and a panel built in bands lands on them. */
const BANDS =
  "Horizontal band composition: distinct treatment across the top quarter, " +
  "main scene through the middle, distinct treatment across the bottom third.";

/* Three takes on the same brief, so the options the customer picks between
   differ by intent rather than by chance. What moves is how hard each one leans
   on the print. Keys match CFG.variants in index.html. */
const VARIANTS: Record<string, string> = {
  safe:
    "Play this one restrained: an allover texture, a quiet gradient, or a single motif repeated at a calm scale. Understated is the brief here — empty is not, and the panel still has to fill the frame.",
  scene:
    "Push this one as far as the process goes: a fully illustrated scene with a background, a foreground and depth, running to all four edges.",
  bold:
    "Make this one graphic: large-scale shapes, hard-edged color blocking, oversized forms running off every edge. Poster-like and high contrast.",
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

/* The three collar ids the order page sends in `style`. They describe the
   garment, which no longer comes from here, so they must not reach the prompt —
   "laced" in an artwork brief buys a picture of shoelaces. */
const COLLARS = ["laced", "vneck", "crew"];

export type ConceptInput = {
  theme: string;          // "tropical beach with palm trees and hibiscus"
  palette: string[];      // ["#F26722", "#2E9BA6", "#E8D5B0"] — 3 to 5
  style?: string;         // defaults to STYLE_DEFAULT
  bands?: boolean;        // add the band-composition nudge
  variant?: string;       // one of VARIANTS
};

/**
 * The prompt, clause by clause. Each one is load-bearing:
 *
 * "Flat artwork panel" is the single most important phrase. Drop it and you get
 * a jersey, every time. "Square 1:1" matches the compositor canvas so nothing
 * has to be cropped. "Full-bleed, edge to edge" because models default to a
 * centred subject with margins, and margins become bare fabric once the panel
 * is clipped. The explicit hex palette is what ties the artwork to the team's
 * colors, which is the entire reason these are team jerseys — three to five
 * values, because past five the constraint gets ignored. "Symmetric about the
 * vertical center" because the garment is: asymmetric artwork puts the weight
 * off-centre once masked and the two sleeves come out mismatched. And "as if
 * printed on paper" does more work than the whole negative list — models
 * understand printed paper better than they understand "no shadows".
 */
export function buildPrompt(i: ConceptInput): string {
  return [
    "Flat artwork panel for a sublimated hockey jersey. Square 1:1 composition.",
    `Full-bleed illustrated scene, edge to edge. Subject: ${i.theme}.`,
    BACKGROUND,
    `Color palette limited strictly to: ${i.palette.join(", ")}.`,
    i.style ?? STYLE_DEFAULT,
    "Composition symmetric about the vertical center line.",
    "Flat 2D artwork only, as if printed on paper, viewed straight on.",
    i.bands ? BANDS : "",
    VARIANTS[i.variant ?? ""] ?? "",
    NEGATIVE,
  ]
    .filter(Boolean)
    .join(" ");
}

/* What to say on the one retry a bad panel buys. Only these two are worth
   spending a call on; a panel that came back the wrong shape is centre-cropped
   and flagged, not redrawn. */
const FIXES: Partial<Record<PanelIssue, string>> = {
  margins:
    "The previous attempt left blank margins around a centred subject. Fill the entire square to all four edges, with no border, no frame and no empty background.",
  palette:
    "The previous attempt used colors that were not asked for. Use only the listed colors and tints and shades of them, and no other hue.",
};

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

/** A panel to show, a reason not to show one, or nothing that came back at all. */
type Produced =
  | { ok: true; made: Made; warnings: string[] }
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
  palette: string[],
  make: (extra: string) => Promise<Made | null>,
): Promise<Produced> {
  let last: Produced = null;

  for (let attempt = 1, extra = ""; attempt <= 2; attempt++) {
    const made = await make(extra);
    if (!made) return last ?? null;

    const [verdict, panel] = await Promise.all([
      checkImage({ data: made.base64, mediaType: made.mediaType || "image/png" }),
      Promise.resolve(checkPanel({ data: made.base64, mediaType: made.mediaType || "image/png" }, palette)),
    ]);

    /* The model read it, so its answer on lettering stands. Only when the call
       failed does the shape detector decide alone. */
    const lettering = verdict.ok ? verdict.lettering : panel.issues.includes("text");
    const said = verdict.letters.join("; ") || panel.notes.find(Boolean) || "garbled type";

    const fixes: string[] = [];
    if (verdict.found) fixes.push(FIX_MARKS.replaceAll("%s", verdict.marks.join(", ") || "a real-world mark"));
    if (lettering) fixes.push(FIX_TEXT.replace("%s", said));
    for (const issue of panel.issues) {
      const clause = FIXES[issue];
      if (clause) fixes.push(clause);
    }

    const warnings = panel.notes.filter((_, i) => panel.issues[i] !== "text");
    last = { ok: true, made, warnings };

    if (!verdict.found && !lettering && !fixes.length) return last;

    if (attempt === 2) {
      if (verdict.found) {
        console.warn("check: dropped after redraw", { what, marks: verdict.marks });
        return { ok: false, dropped: DROPPED_MARK };
      }
      if (lettering) {
        console.warn("check: dropped after redraw", { what, letters: verdict.letters, note: said });
        return { ok: false, dropped: DROPPED_TEXT };
      }
      return last;   // margins or palette only: shown, with the warning attached
    }

    console.warn("check: redrawing", {
      what,
      marks: verdict.marks,
      lettering,
      letters: verdict.letters,
      panel: panel.notes,
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
  // Illustration style. Collar ids are ignored — see COLLARS.
  style?: string;
  /* Sent so they can be removed, never so they can be drawn. See scrub(). The
     roster is not accepted at all: player names and numbers belong to the
     nameplate layer and this endpoint has no use for them. */
  teamName?: string;
  playerNames?: string[];
  // One of the keys of VARIANTS. Omitted on a refinement, and for anything
  // unrecognised the brief is drawn straight with no variant steer.
  variant?: string;
  bands?: boolean;
  // Data URL of the panel being refined. Absent on the first generation.
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

  const style = body.style && !COLLARS.includes(body.style) ? body.style : undefined;

  const instruction = buildPrompt({
    theme,
    palette,
    style,
    bands: body.bands,
    variant: body.variant,
  });

  /* An edit is told to change one thing, so the brief is not repeated — but
     everything that keeps the panel compositable is, because a refinement that
     quietly paints a jersey or a margin back in breaks the same pipeline. */
  const editInstruction = [
    "Edit the attached flat artwork panel.",
    "Make only this change, described by the customer:",
    theme,
    "Everything else must stay exactly as it is — the same composition, the same colors and the same treatment wherever the requested change does not touch them.",
    "Keep it a flat 2D artwork panel, square, full bleed to all four edges, symmetric about the vertical center line.",
    BACKGROUND,
    `Color palette limited strictly to: ${palette.join(", ")}.`,
    NEGATIVE,
  ].join(" ");

  try {
    if (base) {
      const edited = await produce("refinement", palette, (extra) =>
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
      if (edited.warnings.length) console.warn("check: refinement shipped with warnings", edited.warnings);
      return Response.json({
        image: `data:${edited.made.mediaType || "image/png"};base64,${edited.made.base64}`,
        warnings: edited.warnings,
      });
    }

    const drawn = await produce(body.variant ?? "generation", palette, (extra) =>
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
    if (drawn.warnings.length) console.warn("check: shipping with warnings", drawn.warnings);

    return Response.json({
      image: `data:${drawn.made.mediaType || "image/png"};base64,${drawn.made.base64}`,
      warnings: drawn.warnings,
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
