import { APICallError, RetryError, experimental_generateImage as generateImage, generateText } from "ai";
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

/* Checked against the gateway's public model list (GET
   https://ai-gateway.vercel.sh/v1/models, no key needed): openai/gpt-image-2 is
   there, type "image", text in and image out. So is google/gemini-2.5-flash-image
   and the checker's google/gemini-2.5-flash-lite. Other candidates if this one
   disappoints: openai/gpt-image-1.5, bfl/flux-2-pro (note the owner is "bfl",
   not "black-forest-labs"), bytedance/seedream-5.0-pro, recraft/recraft-v4-pro.
   These move — re-check the list rather than trusting this comment. */
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
  "no lettering anywhere except the chest crest and the back nameplate",
  "no misspelled words", "no invented words", "no repeated or doubled letters",
  "no garbled text", "no city name", "no real player name",
  "no lettering on the sleeves", "no lettering on the shoulders",
  "no lettering on the collar", "no lettering on the socks",
  "no lettering on the hem", "no numbers on the front", "no numbers on the socks",
  "no sleeve numbers",
  "no captions", "no signage", "no signature", "no date", "no watermark",
  "no badge", "no medallion", "no shield", "no roundel", "no monogram",
  "no coat of arms", "no enclosing border around the chest crest",
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
  "seams running down its length and a set of horizontal stripe bands across its",
  "lower third. One sock shows its front, the other its back.",
  "Soft, even studio lighting with gentle shadows. Plain neutral light grey",
  "background, no props, no model, no mannequin.",
  "The front and the back are the same garment and the same design: the same yoke,",
  "the same stripes at the same height and the same placement, the same collar,",
  "the same sleeve design and the same color blocking. Anything that appears on",
  "one appears on the other in the same place.",
  "The socks are drawn from the same palette and coordinate with the jersey, but",
  "they are not a copy of it: the scene and the artwork do not continue onto them.",
  "Their design is the horizontal stripe bands across the lower third and nothing",
  "else — plain above those bands.",
  "Every piece is shown complete and in full: both jerseys entire from collar to",
  "hem, and both socks entire and full length, from the open top to the open",
  "tapered bottom. Nothing is cropped by the edge of the frame or runs off it,",
  "and nothing overlaps anything",
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
  "name or number. The number is solid filled, in one color, with two contrast " +
  "outlines around it: an inner outline and a second outline around that, each in " +
  "a different color from the fill and from each other. It is never hollow, never " +
  "outline-only, and never left as the artwork showing through. Both the number " +
  "and the nameplate must stay clearly legible against whatever sits behind them.";

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
 * they do, that file is composited onto this chest afterwards and anything the
 * model puts there ends up underneath it.
 *
 * This is the one place the team name is drawn by the model, and it is drawn at
 * some risk: no image model sets type reliably, and asking for a name is how
 * eleven generations in a row came back garbled. What makes it survivable is
 * that we know the string. The checker is handed the same name and rejects
 * anything that is not exactly it — a misspelling, a doubled letter, an invented
 * word — so a garbled crest costs a redraw rather than reaching a customer. */
function mascot(team: string | null): string {
  const base =
    "At the centre chest of the front view, as the focal point of the design, place " +
    "a single illustrated mascot or icon drawn from the theme: one clear subject, " +
    "large enough to read from across the rink, sitting within the scene rather than " +
    "pasted on top of it. No enclosing circle, shield or roundel around it.";
  if (!team) return base + " No lettering in or near it.";
  return (
    base +
    ` Integrate the team name as a wordmark with it — set below the mascot, or ` +
    `running across it — as one crest rather than two elements sharing a space. ` +
    `The wordmark reads exactly "${team}", spelled exactly that way and nothing ` +
    `else. It must be clean, evenly spaced, correctly spelled and legible at a ` +
    `glance. If it cannot be set legibly at this size, make it larger rather than ` +
    `smaller.`
  );
}

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

/* The team name is used in exactly one place — the crest wordmark — and taken
 * out of everywhere else.
 *
 * It arrives in its own field, so the one clause that wants it can have it
 * verbatim and the checker can be handed the same string to hold the model to.
 * What it must not do is leak into the scene description, where "harbour seals
 * tropical beach" becomes a brief for seals on a beach and, worse, a second
 * place for the model to letter. So it is scrubbed out of the theme.
 *
 * Digits are left alone. "1970s" and "three stripes" are legitimate briefs, and
 * player numbers only exist on the roster, which this endpoint is never sent. */
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
  teamName?: string|null; // set as the crest wordmark, when the model draws the crest
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
  /* The chest belongs to the customer's own file or to the model's crest, never
     both — so the wordmark and the clause that promises it read one condition,
     not two that can drift apart. */
  const crest = i.ownCrest ? null : i.teamName ?? null;
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
      : mascot(crest),
    VARIANTS[i.variant ?? ""] ?? "",
    NEGATIVE,
    // Last, because the list above is emphatic and these are its exceptions.
    crest
      ? `Lettering appears in exactly two places: the wordmark "${crest}" in the chest crest, and the nameplate NAME with the number 00 on the back. Both must be spelled exactly as given. Nothing else in the image carries any letters, words or numbers.`
      : "The only lettering anywhere in the image is the nameplate reading NAME and the number 00 on the back view. Nothing else in the image carries any letters, words or numbers.",
  ]
    .filter(Boolean)
    .join(" ");
}

type Ref = { data: string; mediaType: string };
type Made = { base64: string; mediaType: string };

/* Why a generation failed, in the terms that decide what to do about it. Two of
 * three takes failing looks the same from the outside whether the provider is
 * rate limiting us, timing out, refusing the prompt, or handing back a picture
 * our own checker then threw away — and the fix is different for every one.
 *
 * The SDK retries internally and wraps what it collected in a RetryError, so
 * the useful error is the one underneath: unwrapped here, or every log line
 * says "maxRetriesExceeded" and nothing else. */
export type Trouble = {
  kind:
    | "rate-limit"
    | "timeout"
    | "content-filter"
    | "auth"
    | "bad-request"
    | "server"
    | "network"
    | "no-image"
    | "rejected"
    | "unknown";
  status: number | null;
  /** What the provider actually said, as far up as it can be dug out. */
  message: string;
  /** The provider's own error code or type, when it gives one. */
  code: string | null;
  /** Seconds, from a Retry-After header. */
  retryAfter: string | null;
  /** How many attempts the SDK made underneath us before giving up. */
  inner: number;
};

const FILTER = [
  "content policy", "content_policy", "safety system", "safety_system",
  "moderation", "blocked", "prohibited", "violates", "not allowed",
  "responsible ai", "sensitive",
];
const TIMEOUT = ["timeout", "timed out", "etimedout", "econnreset", "aborted", "socket hang up"];

/** Digs the provider's own message out of a JSON error body. */
function providerSays(body: string | undefined): { message: string | null; code: string | null } {
  if (!body) return { message: null, code: null };
  try {
    const parsed = JSON.parse(body);
    const e = parsed?.error ?? parsed;
    const message = typeof e?.message === "string" ? e.message : null;
    const code = typeof e?.code === "string" ? e.code : typeof e?.type === "string" ? e.type : null;
    return { message, code };
  } catch {
    // Not JSON — an HTML error page or a proxy's plain text. Keep a little of it.
    return { message: body.slice(0, 200).replace(/\s+/g, " ").trim() || null, code: null };
  }
}

export function diagnose(err: unknown): Trouble {
  /* Walk the whole chain, not just the top. The gateway wraps the provider's
     APICallError in a class of its own — GatewayAuthenticationError and friends —
     which carries statusCode but is not an APICallError, so testing the top for
     one reported a plain 401 as "unknown, status -". The body, the headers and
     the status can each be at a different depth, so each is looked for
     separately rather than assuming one level holds them all. */
  let inner = 0;
  const chain: any[] = [];
  let e: unknown = err;
  for (let depth = 0; depth < 6 && e; depth++) {
    if (RetryError.isInstance(e)) {
      inner = Math.max(inner, e.errors.length);
      e = e.lastError ?? (e as any).cause;
      continue;
    }
    chain.push(e);
    e = (e as any)?.cause;
  }
  const at = <T>(pick: (x: any) => T | undefined): T | undefined => {
    for (const link of chain) {
      const got = pick(link);
      if (got !== undefined && got !== null) return got;
    }
    return undefined;
  };

  const status = at<number>((x) => (typeof x?.statusCode === "number" ? x.statusCode : undefined)) ?? null;
  const body = at<string>((x) => (typeof x?.responseBody === "string" ? x.responseBody : undefined));
  const headers = at<Record<string, string>>((x) => x?.responseHeaders);
  const said = providerSays(body);
  const typed = at<string>((x) => (typeof x?.type === "string" ? x.type : undefined));
  const top = chain[0];
  const raw = top instanceof Error ? top.message : String(err);
  // Collapsed, because a provider message with newlines in it breaks the log line.
  const message = (said.message ?? raw).replace(/\s+/g, " ").trim();
  const code = said.code ?? typed ?? null;
  const retryAfter = (headers?.["retry-after"] ?? headers?.["retry-after-ms"]) || null;
  const call = APICallError.isInstance(top) ? top : null;

  const haystack = `${message} ${code ?? ""} ${raw}`.toLowerCase();
  const kind: Trouble["kind"] =
    status === 429 ? "rate-limit"
    : status === 401 || status === 403 ? "auth"
    : status === 408 || status === 504 ? "timeout"
    : TIMEOUT.some((t) => haystack.includes(t)) ? "timeout"
    : FILTER.some((t) => haystack.includes(t)) ? "content-filter"
    : status !== null && status >= 500 ? "server"
    : status !== null && status >= 400 ? "bad-request"
    : /no image|empty response|nocontentgenerated/.test(haystack) ? "no-image"
    : call === null && status === null && /fetch|network|enotfound|econnrefused|dns/.test(haystack) ? "network"
    : "unknown";

  return { kind, status, message: message.slice(0, 400), code, retryAfter, inner };
}

/** One line per failure, in the shape a terminal can be read down. */
function report(what: string, t: Trouble, ms: number, note = "") {
  console.error(
    [
      `generate-concept FAIL ${what}`,
      t.kind,
      `status=${t.status ?? "-"}`,
      `${(ms / 1000).toFixed(1)}s`,
      t.code ? `code=${t.code}` : "",
      t.retryAfter ? `retry-after=${t.retryAfter}` : "",
      t.inner ? `sdk-retries=${t.inner}` : "",
      note,
      `:: ${t.message}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

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
    const started = Date.now();
    try {
      const out = await call();
      if (out) return out;
      report(label, { kind: "no-image", status: null, message: "the call returned no image", code: null, retryAfter: null, inner: 0 },
             Date.now() - started, `attempt=${attempt}/2`);
    } catch (err) {
      const t = diagnose(err);
      report(label, t, Date.now() - started, `attempt=${attempt}/2`);
      /* A rate limit does not clear in the milliseconds it takes to ask again,
         and asking again is one more request against the same cap. Hand it
         straight back with its retry-after and let the caller do the waiting —
         it has no execution limit to run into and this function does. */
      if (t.kind === "rate-limit" || attempt === 2) throw err;
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
  "A previous attempt had lettering wrong (%s). Every word in this image must be spelled exactly as specified and set cleanly and legibly. Lettering appears only where it was asked for; nowhere else in the image carries any letters, words or numbers.";

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
  crest: string | null,
  make: (extra: string) => Promise<Made | null>,
): Promise<Produced> {
  let last: Produced = null;
  const began = Date.now();

  for (let attempt = 1, extra = ""; attempt <= 2; attempt++) {
    const made = await make(extra);
    if (!made) return last ?? null;

    const seenBy = { data: made.base64, mediaType: made.mediaType || "image/png" };
    const [verdict, panel] = await Promise.all([
      checkImage(seenBy, { crest }),
      Promise.resolve(checkPanel(seenBy)),
    ]);

    /* Only the model gets a vote on lettering. There is type on the garment by
       design now — a crest wordmark and a back nameplate — and the pixel detector
       sees shapes rather than characters, so it cannot tell HARBOUR from HARBUOR
       and fires on every correct image. It stays as a log line: if it says there
       is type and the model says there is none, one of them is wrong and that is
       worth being able to see. */
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
        report(what, { kind: "rejected", status: null, code: "real-world mark", retryAfter: null, inner: 0,
                       message: verdict.marks.join(", ") || "a real-world mark" }, Date.now() - began, "dropped after redraw");
        return { ok: false, dropped: DROPPED_MARK };
      }
      if (lettering) {
        report(what, { kind: "rejected", status: null, code: "lettering", retryAfter: null, inner: 0,
                       message: said }, Date.now() - began, "dropped after redraw");
        return { ok: false, dropped: DROPPED_TEXT };
      }
      return last;
    }

    console.warn(
      `generate-concept REDRAW ${what} ${(( Date.now() - began) / 1000).toFixed(1)}s ` +
      `marks=${verdict.marks.join("|") || "-"} lettering=${lettering} ` +
      `letters=${verdict.letters.join("|") || "-"} model-checked=${verdict.ok} ` +
      `pixels=${panel.notes.join("|") || "-"}`,
    );
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
  /* The team name is set as the crest wordmark, and removed from the theme so it
     is not also drawn into the scene. See scrub(). The roster is not accepted:
     player names and numbers are placeholders here, never real ones. */
  teamName?: string | null;
  playerNames?: string[];
  // One of the keys of VARIANTS. Omitted on a refinement, and for anything
  // unrecognised the brief is drawn straight with no variant steer.
  variant?: string;
  // Data URL of the concept being refined. Absent on the first generation.
  baseImage?: string | null;
};

export async function POST(request: Request): Promise<Response> {
  const began = Date.now();
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

  /* The name is kept for the crest and taken out of the scene: scrubbed before
     the theme is read for anything, so it cannot reach the block list, the
     subject or the edit instruction by that route. */
  const teamName = (body.teamName ?? "").trim().slice(0, 40) || null;
  const theme = scrub(
    (body.theme || body.prompt || "").trim().slice(0, 600),
    [teamName ?? "", ...(body.playerNames ?? [])].filter(Boolean),
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
    teamName,
  });

  /* What the checker holds the model to. Null where the model is drawing no
     crest at all, because the customer's own file is going there instead. */
  const crest = body.ownCrest ? null : teamName;

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
      const edited = await produce("refinement", crest, (extra) =>
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

    const drawn = await produce(body.variant ?? "generation", crest, (extra) =>
      twice(body.variant ?? "generation", async () => {
        const text = [instruction, extra].filter(Boolean).join(" ");
        for (const size of SIZES) {
          const started = Date.now();
          try {
            const { image } = await generateImage({ model: MODEL, prompt: text, size });
            if (image) return image;
          } catch (err) {
            const t = diagnose(err);
            /* Only a complaint about the size is worth trying the next one for.
               Everything else — auth, rate limits, filters — fails the same way
               at every size, and falling through doubled both the wait and the
               spend on every failure that was never about the frame. */
            const aboutSize =
              t.status === 400 && /\bsize\b|dimension|resolution|not supported|invalid value/i.test(t.message);
            if (!aboutSize || size === SIZES[SIZES.length - 1]) throw err;
            report(`${body.variant ?? "generation"} size=${size}`, t, Date.now() - started, "trying the next size");
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
    console.log(
      `generate-concept OK ${body.variant ?? "generation"} ${((Date.now() - began) / 1000).toFixed(1)}s ${MODEL}`,
    );
    return Response.json({
      image: `data:${drawn.made.mediaType || "image/png"};base64,${drawn.made.base64}`,
    });
  } catch (err) {
    const t = diagnose(err);
    report(body.variant ?? "generation", t, Date.now() - began, "gave up");
    /* The customer gets a sentence they can act on; the caller gets the whole
       diagnosis, so the browser console carries the same detail the terminal
       does and neither has to be read to work out what the other saw. */
    return Response.json(
      { error: SORRY[t.kind] ?? SORRY.unknown, detail: t },
      { status: t.kind === "rate-limit" ? 429 : t.kind === "content-filter" ? 422 : 502 },
    );
  }
}

/* One sentence per failure, in the customer's terms. They are not going to act
   on a status code, but "too many at once" and "try describing it differently"
   are different instructions and they deserve the right one. */
const SORRY: Record<Trouble["kind"], string> = {
  "rate-limit": "The image service is busy right now. Wait a moment and try again.",
  timeout: "That took too long to come back. Try again in a moment.",
  "content-filter": "The image service wouldn't draw that one. Try describing it differently.",
  auth: "We can't reach the image service right now — that's on us, not you.",
  "bad-request": "Couldn't generate that concept. Try describing it differently.",
  server: "The image service is having trouble. Try again in a moment.",
  network: "Couldn't reach the image service. Try again in a moment.",
  "no-image": "That didn't come back as an image. Try again in a moment.",
  rejected: "That one didn't pass our own checks. Try again for another.",
  unknown: "Couldn't generate that concept. Try describing it differently.",
};

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
