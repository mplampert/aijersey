import { generateObject, jsonSchema } from "ai";

/**
 * POST /api/check-image
 *
 * Looks at a generated concept and answers two questions about it: does it carry
 * a real-world mark — a league shield, a professional team crest, a brand logo —
 * and does it carry any lettering it should not.
 *
 * "Should not" rather than "any", because the kit is supposed to carry type in
 * two places: a wordmark in the chest crest reading the team's own name, and a
 * nameplate and number on the back. Every one of those is a known string — the
 * caller passes the team name in, and the back is the fixed placeholders NAME
 * and 00 — so this can hold the model to an exact spelling and reject everything
 * else. That matters more than it sounds: a misspelt crest is the failure that
 * actually happens, and it is the one a customer would notice last and mind
 * most.
 *
 * Both are things image models do however firmly the prompt forbids them. They
 * are trained on real hockey imagery, which is covered in league marks and in
 * type, and prompting alone has not held: eleven panels in a row came back with
 * words on them.
 *
 * The lettering question rides along on the call the mark check was already
 * making, so it costs nothing. It is also the half that can actually read: the
 * pixel-side detector in check-panel.ts is free and caches nothing, but it can
 * only see that something is shaped like a word, and a row of trees is shaped
 * like a word too.
 *
 * Exported as a function so generate-concept can call it directly rather than
 * paying a second network hop, and as an endpoint so a suspect image can be
 * checked by hand.
 *
 * Env var required: AI_GATEWAY_API_KEY
 */

// Image understanding, not generation: the cheapest vision model on the
// gateway is plenty for a yes/no. $0.10 per 1M input tokens, $0.40 per 1M
// output. A 1024x1024 image is about 1,032 input tokens under Gemini's 768px
// tiling, so a check runs around $0.00013 — roughly a hundredth of a cent.
export const CHECK_MODEL = "google/gemini-2.5-flash-lite";

function question(expect: { crest: string | null }): string {
  const allowed = expect.crest
    ? `Two pieces of lettering belong here. On the FRONT, in the chest crest, a wordmark reading exactly "${expect.crest}". On the BACK, a nameplate reading exactly NAME with a large number reading exactly 00 below it. Those are correct and expected — do not report them, as long as each is spelled exactly as given.`
    : "Exactly one piece of lettering belongs here: on the BACK view, a nameplate reading exactly NAME with a large number reading exactly 00 below it. That is correct and expected — do not report it. The front of the jersey carries no lettering at all.";

  const misspelt = expect.crest
    ? `a chest wordmark that reads anything other than "${expect.crest}" — a misspelling, a missing or doubled letter, a different word, or characters that do not resolve into that name;`
    : "any lettering at all on the front of the jersey;";

  return [
    "This is a product photograph of a custom ice hockey kit made for a small club: the jersey shown front and back on hangers, with a pair of leg socks alongside.",
    "Answer two questions about it.",
    "First: does it show any real-world mark? That means a sports league logo or shield of any kind (the NHL shield especially), a professional, college or national team crest, or a brand or manufacturer logo such as Bauer, CCM, Nike, Adidas, Reebok or Warrior. Look at the whole kit, including the collar, the back neck, the sleeves, the shoulders, the hem and the socks. An original design invented for this club is fine and is not a real-world mark. Answer found: true only if you can actually see such a mark, and name each one you see in marks.",
    "Second: does it show any lettering it should not?",
    allowed,
    "Everything else is wrong. Report it if you see:",
    misspelt,
    "a nameplate that reads anything other than NAME, including a misspelling such as NAMF or NMAE; any number other than 00; lettering on the sleeves, the shoulders, the collar, the hem or the socks; a real or invented player name; and any garbled, distorted, doubled or unreadable characters anywhere in the image.",
    "Read every word in the image letter by letter and compare it to what is expected. Spelling is the whole point of this question: a word that is nearly right is wrong.",
    "Shapes that merely resemble letters — a row of trees, a skyline, a repeated motif — are not lettering. Answer lettering: true only if these are actually characters, and quote what you actually see in letters.",
  ].join(" ");
}

export type Verdict = {
  found: boolean;
  marks: string[];
  lettering: boolean;
  letters: string[];
  /** False when the check could not be made, so a caller can weigh it. */
  ok: boolean;
};

type Answer = Omit<Verdict, "ok">;

const VERDICT = jsonSchema<Answer>({
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description: "True only if a real-world league, team, brand or manufacturer mark is visible.",
    },
    marks: {
      type: "array",
      items: { type: "string" },
      description: "What was seen, e.g. \"NHL shield, centred\". Empty when found is false.",
    },
    lettering: {
      type: "boolean",
      description: "True if any lettering is visible other than the exact strings named as expected. A misspelling of one of them counts as true.",
    },
    letters: {
      type: "array",
      items: { type: "string" },
      description: "What the wrong lettering says, exactly as it appears, and where, e.g. \"crest reads HARBUOR SEALS\" or \"nameplate reads NAMF\". Empty when lettering is false.",
    },
  },
  required: ["found", "marks", "lettering", "letters"],
  additionalProperties: false,
});

/**
 * Returns what the checker saw. A checker that is down or confused fails open,
 * with ok:false so the caller knows to lean on the pixel checks instead: a
 * concept the customer is waiting on should not be lost because the
 * verification step broke, and the human proof is still the real gate.
 */
export async function checkImage(
  image: { data: string; mediaType: string },
  expect: { crest: string | null } = { crest: null },
): Promise<Verdict> {
  try {
    const { object } = await generateObject({
      model: CHECK_MODEL,
      schema: VERDICT,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: question(expect) },
            { type: "file", data: image.data, mediaType: image.mediaType },
          ],
        },
      ],
    });
    return {
      found: !!object.found,
      marks: object.marks ?? [],
      lettering: !!object.lettering,
      letters: object.letters ?? [],
      ok: true,
    };
  } catch (err) {
    console.error("check-image: check failed, letting the image through", err);
    return { found: false, marks: [], lettering: false, letters: [], ok: false };
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!process.env.AI_GATEWAY_API_KEY) {
    return Response.json({ error: "AI_GATEWAY_API_KEY is not set" }, { status: 500 });
  }

  let body: { image?: string; crest?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(body.image || "");
  if (!m) {
    return Response.json({ error: "Send image as a base64 data URL" }, { status: 400 });
  }

  const verdict = await checkImage(
    { mediaType: m[1], data: m[2] },
    { crest: typeof body.crest === "string" ? body.crest : null },
  );
  return Response.json({ model: CHECK_MODEL, ...verdict });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
