/**
 * POST /api/save-design
 *
 * Emails the customer a copy of the concept they just generated, so they can
 * keep it, show the team and come back to it later. Not a signup — the design
 * is the reason to hand over an address.
 *
 * Nothing is delivered or stored yet: see the TODO below.
 */

type Body = {
  email?: string;
  prompt?: string;
  style?: string[];
  colors?: { name: string; hex: string }[];
  image?: string | null;
};

// Deliberately loose. The real check is whether the mail lands.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(request: Request): Promise<Response> {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim();
  if (!EMAIL.test(email)) {
    return Response.json(
      { error: "That doesn't look like an email address — check it and try again." },
      { status: 400 },
    );
  }

  if (!body.image) {
    return Response.json(
      { error: "There's no concept to send yet. Generate one first." },
      { status: 400 },
    );
  }

  const design = {
    email,
    prompt: (body.prompt || "").trim().slice(0, 600),
    style: body.style ?? [],
    colors: (body.colors ?? []).map((c) => `${c.name} ${c.hex}`),
    // The image is a ~1.5MB base64 data URL. Logging it whole would blow up
    // every log line, so record only that it arrived and how big it was.
    image: `${body.image.slice(0, body.image.indexOf(",")) || "unknown"} (${body.image.length} chars)`,
    at: new Date().toISOString(),
  };

  // TODO: wire up delivery and storage. Until all three steps exist, this
  // endpoint reports success without the customer receiving anything.
  //   1. Store the design — image, brief, colours, email — somewhere durable
  //      (blob storage for the image, a row keyed by email for the rest), so
  //      sales can pick the thread back up and the customer can return to it.
  //   2. Send the customer their copy through the transactional mail provider,
  //      with the concept attached or linked, plus the usual proof disclaimer.
  //   3. Only then return ok, and surface a real failure to the page when the
  //      mail provider rejects it — the page already renders { error }.
  console.log("save-design", design);

  return Response.json({ ok: true });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
