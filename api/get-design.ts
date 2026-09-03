/**
 * GET /api/get-design?code=ABCD
 *
 * Opens a shared design. The page puts a code in the URL (?d=ABCD) and this
 * hands back enough to put that jersey back on screen, and nothing else.
 *
 * What never leaves here: the email address, the session id, and the Airtable
 * record id. The record id matters most — save-design patches by it, so
 * publishing one would let anybody overwrite somebody else's design. The
 * customer's typed brief stays here too: people put their team's name in it,
 * and the thing being shared is the jersey, not the sentence behind it.
 *
 * Link-based only. There are no accounts, so holding the code is the whole of
 * the access check, which is what the rate limit below is for.
 *
 * Env vars required:
 *   AIRTABLE_TOKEN     — personal access token, data.records:read on the base
 *   AIRTABLE_BASE_ID   — base "AI Jersey Designs"
 *   AIRTABLE_TABLE_ID  — table "Designs"
 */

// Read by field id so a column rename in Airtable can't break the lookup. The
// filter below is the one place a field *name* is unavoidable: Airtable
// formulas have no way to name a field by id.
const FIELD = {
  code: "fldQErtLQMODLkERB",
  style: "fldeFewvBIGbQQxGu",
  colors: "fld7YqigCvKMGi2Bs",
  concept: "fldRvuWtY3JtCNAsI",
} as const;
const CODE_FIELD_NAME = "Code";

// Matches makeCode() in save-design.ts: four glyphs, no I/1 and no O/0.
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/* Four characters out of a 32-glyph alphabet is about a million codes, which a
   script walks through in an afternoon. This is a speed bump rather than a
   lock: serverless instances come and go and each keeps its own counter, so the
   true ceiling is some multiple of ten a minute depending on how many are warm.
   It still turns a fast enumeration into a slow, obvious one, and the codes
   guard concepts rather than anything that can be spent. */
const WINDOW_MS = 60_000;
const PER_WINDOW = 10;
const MAX_TRACKED = 10_000;
const hits = new Map<string, number[]>();

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  // Cheap sweep so a long-lived instance can't accumulate every caller it has
  // ever seen. Only runs once the map is already large.
  if (hits.size > MAX_TRACKED) {
    for (const [key, seen] of hits) {
      if (!seen.some((t) => now - t < WINDOW_MS)) hits.delete(key);
    }
  }
  const seen = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(ip, seen);
  return seen.length > PER_WINDOW;
}

const table = () =>
  `https://api.airtable.com/v0/${process.env.AIRTABLE_BASE_ID}/${process.env.AIRTABLE_TABLE_ID}`;

const airtableHeaders = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
});

function unconfigured(keys: string[]): Response | null {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return null;
  console.error("get-design not configured, missing:", missing.join(", "));
  return Response.json({ error: "Design sharing isn't configured" }, { status: 503 });
}

// The reverse of colorText() in save-design.ts: "Navy #1b2f5e, White #ffffff".
// The name is greedy so the two-word entries on the card survive the trip.
function parseColors(value: unknown): { name: string; hex: string }[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((part) => /^\s*(.+)\s+(#[0-9a-f]{6})\s*$/i.exec(part))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].trim(), hex: m[2].toLowerCase() }));
}

/**
 * Airtable attachment URLs expire, and the page needs a data URL regardless:
 * refining sends the concept back to the image model as a data URL, and a
 * remote one would be refused there and would taint the canvas here. So the
 * bytes are fetched once, on this side, where there is no CORS to negotiate.
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

async function asDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("get-design: attachment fetch failed", res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      console.error("get-design: attachment too large", buf.byteLength);
      return null;
    }
    const type = res.headers.get("content-type")?.split(";")[0] || "image/png";
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch (err) {
    console.error("get-design: attachment fetch threw", err);
    return null;
  }
}

const NOT_FOUND = {
  error: "We couldn't find that design code. Check it and try again.",
};

export async function GET(request: Request): Promise<Response> {
  const code = (new URL(request.url).searchParams.get("code") || "")
    .trim()
    .toUpperCase();
  if (!CODE.test(code)) {
    return Response.json(
      { error: "That isn't a design code — they're four characters long." },
      { status: 400 },
    );
  }

  if (rateLimited(clientIp(request))) {
    return Response.json(
      { error: "Too many lookups just now. Wait a minute and try again." },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  const notReady = unconfigured([
    "AIRTABLE_TOKEN",
    "AIRTABLE_BASE_ID",
    "AIRTABLE_TABLE_ID",
  ]);
  if (notReady) return notReady;

  try {
    // The code is matched against CODE above, so only the 32 safe glyphs ever
    // reach the formula — there is nothing here to quote-escape out of.
    const query = new URLSearchParams({
      filterByFormula: `{${CODE_FIELD_NAME}}="${code}"`,
      maxRecords: "1",
      returnFieldsByFieldId: "true",
    });
    const res = await fetch(`${table()}?${query}`, { headers: airtableHeaders() });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Airtable ${res.status}: ${detail.slice(0, 300)}`);
    }

    const found = await res.json();
    const fields = found?.records?.[0]?.fields;
    if (!fields) return Response.json(NOT_FOUND, { status: 404 });

    const attachment = fields[FIELD.concept];
    const url = Array.isArray(attachment) ? attachment[0]?.url : null;
    const image = url ? await asDataUrl(url) : null;
    if (!image) {
      // The row exists but its picture doesn't, which is our problem, not a
      // wrong code — say so rather than claiming the design isn't there.
      console.error("get-design: record has no readable concept", code);
      return Response.json(
        { error: "That design is on file but its image wouldn't load. Try again in a moment." },
        { status: 502 },
      );
    }

    return Response.json({
      code,
      style: typeof fields[FIELD.style] === "string" ? fields[FIELD.style] : null,
      colors: parseColors(fields[FIELD.colors]),
      image,
    });
  } catch (err) {
    console.error("get-design failed", { code, err });
    return Response.json(
      { error: "We couldn't load that design just now. Try again in a moment." },
      { status: 502 },
    );
  }
}

export async function POST(): Promise<Response> {
  return Response.json({ error: "Use GET" }, { status: 405 });
}
