import type { Context, Config } from "@netlify/functions";

/**
 * Generates the customer-facing CONCEPT image only.
 *
 * This is deliberately not a production file. The factory redraws from this
 * image, and the customer approves the factory's 48-hour proof — not this.
 *
 * Env var required: GEMINI_API_KEY
 * Change MODEL if Google ships a newer image model.
 */

const MODEL = "gemini-2.5-flash-image";

// Blocked outright — self-serve means these arrive weekly.
const BLOCKED = [
  "nhl", "nfl", "nba", "mlb", "star wars", "marvel", "disney", "pokemon",
  "bruins", "rangers", "maple leafs", "canadiens", "penguins", "oilers",
  "olympic", "team canada", "team usa hockey", "espn", "nike", "adidas",
  "bauer", "ccm", "warrior hockey"
];

function screen(prompt: string): string | null {
  const p = prompt.toLowerCase();
  const hit = BLOCKED.find(b => p.includes(b));
  return hit ? hit : null;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Use POST" }, { status: 405 });
  }

  const key = Netlify.env.get("GEMINI_API_KEY");
  if (!key) {
    return Response.json({ error: "GEMINI_API_KEY is not set" }, { status: 500 });
  }

  let body: { prompt?: string; colors?: { name: string; hex: string }[]; logo?: string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const prompt = (body.prompt || "").trim().slice(0, 600);
  if (!prompt) {
    return Response.json({ error: "Describe the jersey first" }, { status: 400 });
  }

  const blocked = screen(prompt);
  if (blocked) {
    return Response.json(
      {
        error:
          `We can't build designs using "${blocked}" — it's someone else's trademark. ` +
          `Describe the look you want instead and we'll draw something original.`
      },
      { status: 422 }
    );
  }

  // Colours the factory has actually matched. Naming them constrains the model.
  const colorLine = body.colors?.length
    ? `Use only these colours: ${body.colors.map(c => `${c.name} (${c.hex})`).join(", ")}.`
    : "";

  const instruction = [
    "Product photograph of a custom sublimated ice hockey jersey.",
    "Show the front view and the back view side by side, both flat and squarely front-on.",
    "The back must show a nameplate and a large two-digit number.",
    "Plain neutral light grey studio background, even lighting, no hanger, no model, no props.",
    colorLine,
    "Design brief:",
    prompt,
    body.logo
      ? "Place the supplied logo as the chest crest, centred, without altering or redrawing it."
      : ""
  ].filter(Boolean).join(" ");

  const parts: any[] = [{ text: instruction }];

  if (body.logo && body.logo.startsWith("data:")) {
    const [meta, b64] = body.logo.split(",");
    const mime = meta.match(/data:([^;]+)/)?.[1] || "image/png";
    if (b64 && b64.length < 8_000_000) {
      parts.push({ inlineData: { mimeType: mime, data: b64 } });
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts }] })
    });

    if (!res.ok) {
      const detail = await res.text();
      console.error("Gemini error", res.status, detail.slice(0, 500));
      return Response.json(
        { error: "The image service rejected that request." },
        { status: 502 }
      );
    }

    const data = await res.json();
    const out = data?.candidates?.[0]?.content?.parts ?? [];
    const img = out.find((p: any) => p.inlineData?.data);

    if (!img) {
      return Response.json(
        { error: "No image came back. Try describing it differently." },
        { status: 502 }
      );
    }

    const mime = img.inlineData.mimeType || "image/png";
    return Response.json({ image: `data:${mime};base64,${img.inlineData.data}` });
  } catch (err: any) {
    console.error("generate-concept failed", err);
    return Response.json({ error: "Image generation failed." }, { status: 500 });
  }
};

export const config: Config = {
  path: "/api/generate-concept"
};
