/**
 * Files a customer in GoHighLevel the moment they save a design with their
 * address, so the lead is in the CRM before anyone thinks to look for it.
 *
 * Triggered from save-design, in the same branch that sends the customer their
 * copy — an address arriving against a design is the only thing that calls
 * this, and it carries whatever else that save had in hand: the phone number,
 * the team name, the four-character code and the gallery link.
 *
 * Best-effort, exactly like the email beside it. The design, the address and
 * the gallery token are all on record before this runs, so GHL being down, a
 * token that expired, or a custom field nobody created costs a CRM row and
 * never the customer's save. Nothing here throws.
 *
 * No SDK. Two POSTs and a GET with JSON bodies; the repo already avoids
 * dependencies a serverless function can do without.
 *
 * Env vars required — both, or this does nothing and says so once:
 *   GHL_API_TOKEN    — a Private Integration token for the location, with
 *                      contacts.write. locations/customFields.readonly lets it
 *                      resolve the custom fields by id; see fieldIds below.
 *   GHL_LOCATION_ID  — the sub-account the contact belongs to
 */

const BASE = "https://services.leadconnectorhq.com";

/* The v2 API is versioned by header, not by path, and a request without this
   is refused. Pinned rather than tracking latest: a silent contract change
   here would fail saves nobody is watching. */
const API_VERSION = "2021-07-28";

/** What the sales side filters on to find everything this page brought in. */
const TAG = "ai-jersey-lead";

/* The custom fields on the contact, by the key half of their fieldKey. GHL
   stores these as `contact.design_code` and so on; each has to exist on the
   location or its value is dropped — see fieldIds. */
const CODE_KEY = "design_code";
const GALLERY_KEY = "design_gallery";
const IMAGE_KEY = "design_image";

/* A save already crosses the blob store, Airtable and Resend before it gets
   here. This is the least important of the four, so it is not allowed to hold
   the response open: a hung GHL costs the caller three seconds, not the save. */
const TIMEOUT_MS = 3000;

export type Lead = {
  email: string;
  /** E.164, as save-design normalises it. Absent when they left the box empty. */
  phone?: string | null;
  /** Becomes both the contact name and the company — the team is who they are. */
  team?: string | null;
  /** The design they just saved. */
  code?: string | null;
  /** Their gallery, token and all. */
  gallery?: string | null;
  /* The concept picture, as a blob URL that keeps working — never Airtable's
     attachment URL, which expires within hours and would leave a hole in every
     mail GHL sends after the first afternoon. See conceptBlobUrl in
     save-design, which is what resolves it. */
  image?: string | null;
};

export type Upserted =
  | { ok: true; id: string | null; tagged: boolean }
  | { ok: false; reason: string };

/* Never logged. Everything else about a request is — see call() — but the
   Authorization header stays out of the console on purpose. */
const headers = () => ({
  Authorization: `Bearer ${process.env.GHL_API_TOKEN}`,
  Version: API_VERSION,
  Accept: "application/json",
  "Content-Type": "application/json",
});

/* What kind of token is configured, without printing any of it.
 *
 * A Private Integration token starts `pit-`; an OAuth access token is a JWT.
 * The two are not interchangeable, and an agency-level token with no rights
 * over GHL_LOCATION_ID is a standing reason for a save to look fine from here
 * while no contact ever appears in the sub-account. */
function tokenKind(): string {
  const t = process.env.GHL_API_TOKEN ?? "";
  const kind = t.startsWith("pit-")
    ? "private-integration"
    : t.startsWith("eyJ")
      ? "jwt"
      : "unrecognised";
  return `${kind}/${t.length}ch`;
}

/** Long enough for a GHL validation list, short enough not to flood the log. */
const LOG_LIMIT = 1500;
const trim = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > LOG_LIMIT ? `${one.slice(0, LOG_LIMIT)}…[${one.length} chars]` : one;
};

type Reply = { ok: boolean; status: number; body: string; json: any };

/**
 * One request, with both halves of it in the log.
 *
 * Every response is printed — status and raw body, on success exactly as much
 * as on failure. From the outside a 200 that quietly did nothing looks like a
 * 200 that created the contact, so "the save worked and no contact appeared"
 * is not answerable without seeing what GHL actually said. The request is
 * printed too, because a rejected upsert is usually explained by the body that
 * was sent. The Authorization header is the only thing held back.
 *
 * Returns null when the request never completed at all — a timeout, DNS, a
 * dropped socket. Callers treat that the same as a refusal.
 */
async function call(step: string, url: string, init: RequestInit = {}): Promise<Reply | null> {
  const began = Date.now();
  const method = init.method ?? "GET";
  console.log(
    `ghl → ${step} ${method} ${url} token=${tokenKind()}` +
    (typeof init.body === "string" ? ` body=${trim(init.body)}` : ""),
  );
  try {
    const res = await fetch(url, {
      ...init,
      headers: headers(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text().catch(() => "");
    let json: any = null;
    try {
      json = JSON.parse(body);
    } catch {
      // Not JSON — a gateway's HTML error page, or no body at all.
    }
    const line =
      `ghl ← ${step} ${res.status} ${((Date.now() - began) / 1000).toFixed(1)}s ` +
      `:: ${trim(body) || "(empty body)"}`;
    if (res.ok) console.log(line);
    else console.error(line);

    return { ok: res.ok, status: res.status, body, json };
  } catch (err) {
    console.error(
      `ghl ← ${step} no-response ${((Date.now() - began) / 1000).toFixed(1)}s ` +
      `:: ${trim(String((err as any)?.message ?? err))}`,
    );
    return null;
  }
}

/** GHL states errors in { message }, sometimes a string and sometimes a list. */
function reasonFrom(reply: Reply): string {
  const m = reply.json?.message ?? reply.json?.error;
  const said = Array.isArray(m) ? m.join("; ") : typeof m === "string" ? m : trim(reply.body);
  return `${reply.status}: ${said || "(empty body)"}`;
}

/**
 * The location's custom fields, keyed by the half of fieldKey after the dot.
 *
 * Written by id rather than by key because the two are not interchangeable in
 * practice: the key the API accepts depends on how the field was created, and
 * a key it doesn't recognise is dropped without an error — the contact saves,
 * the design code just isn't on it. Resolving to an id once and writing that
 * turns a silent drop into a warning naming the field that is missing.
 *
 * Cached in module scope, so a warm function pays for this once. Only a
 * successful lookup is cached; a failed one falls back to writing by key,
 * which may work, and is retried on the next save.
 */
let cached: Record<string, string> | null = null;

async function fieldIds(): Promise<Record<string, string> | null> {
  if (cached) return cached;
  const location = encodeURIComponent(process.env.GHL_LOCATION_ID as string);
  const reply = await call("customFields", `${BASE}/locations/${location}/customFields?model=contact`);
  // Usually a token without locations/customFields.readonly. Not fatal — the
  // caller falls back to writing the fields by key — and call() has logged it.
  if (!reply?.ok) return null;

  const map: Record<string, string> = {};
  for (const f of reply.json?.customFields ?? []) {
    const key = String(f?.fieldKey ?? "").split(".").pop();
    if (key && f?.id) map[key] = f.id;
  }
  // What the location actually has, so a name that doesn't match is visible
  // next to the three this writes rather than inferred from their absence.
  console.log(
    `ghl: contact custom fields on ${process.env.GHL_LOCATION_ID}: ` +
    `${Object.keys(map).join(", ") || "(none)"}`,
  );
  cached = map;
  return map;
}

/** GHL takes either identifier on a value, and neither one alongside the other. */
type FieldValue = { id: string; field_value: string } | { key: string; field_value: string };

/** The two custom fields, by id where it is known and by key where it is not. */
async function customFields(lead: Lead): Promise<FieldValue[]> {
  const wanted = [
    { key: CODE_KEY, value: lead.code },
    { key: GALLERY_KEY, value: lead.gallery },
    { key: IMAGE_KEY, value: lead.image },
  ].filter((f) => f.value);
  if (!wanted.length) return [];

  const ids = await fieldIds();
  return wanted.map((f) => {
    const id = ids?.[f.key];
    if (ids && !id) {
      console.warn(
        `ghl: no custom field ${f.key} on location ${process.env.GHL_LOCATION_ID} — ` +
        `create it on the contact, or its value won't be stored`,
      );
    }
    return id
      ? { id, field_value: f.value as string }
      : { key: f.key, field_value: f.value as string };
  });
}

/**
 * Adds the tag on its own call rather than in the upsert body.
 *
 * Tags sent with an upsert replace what the contact already has, and a
 * returning customer's contact may carry tags a person put there by hand. This
 * endpoint adds; nothing this page does should quietly clear someone's CRM.
 */
async function tag(contactId: string): Promise<boolean> {
  const reply = await call("tag", `${BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags: [TAG] }),
  });
  return reply?.ok === true;
}

/**
 * Creates the contact, or updates the one already on that address.
 *
 * Upsert rather than create: a customer who saves a second design a week later
 * is the same person, and a second contact row splits their history in two.
 * GHL matches on the address within the location, which is why the address is
 * always sent and why the phone number never stands in for it.
 */
export async function upsertContact(lead: Lead): Promise<Upserted> {
  const missing = ["GHL_API_TOKEN", "GHL_LOCATION_ID"].filter((k) => !process.env[k]);
  if (missing.length) {
    /* Not an error — the page runs perfectly well without a CRM behind it — but
       said plainly, because this is the first thing "no contact appeared" turns
       out to be, and on Netlify an env var that is set but not redeployed
       behind still reads as unset in the function. */
    console.warn(`ghl: NO CONTACT WRITTEN — not configured (${missing.join(", ")})`);
    return { ok: false, reason: `not configured: ${missing.join(", ")}` };
  }

  const began = Date.now();
  try {
    const team = (lead.team || "").trim();
    const body: Record<string, unknown> = {
      locationId: process.env.GHL_LOCATION_ID,
      email: lead.email,
      // The team is the customer, as far as this business is concerned. Sent
      // as both, because GHL lists contacts by name and filters them by company.
      ...(team ? { name: team, companyName: team } : {}),
      ...(lead.phone ? { phone: lead.phone } : {}),
      customFields: await customFields(lead),
    };

    const reply = await call("upsert", `${BASE}/contacts/upsert`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!reply) return { ok: false, reason: "no response from GHL" };
    if (!reply.ok) return { ok: false, reason: reasonFrom(reply) };

    const contact = reply.json?.contact ?? reply.json ?? {};
    const id: string | null = contact?.id ?? null;
    const tagged = id ? await tag(id) : false;

    if (!id) {
      // The contact may well be written; only the tag is certainly lost. Worth
      // a line, because a lead nobody can filter for is a lead nobody works.
      console.warn("ghl: upsert returned 2xx with no contact id, so no tag was added");
    }
    /* A contact that lands somewhere other than the location this asked for is
       the quiet version of "no contact appeared": it exists, in a sub-account
       nobody is looking at. Happens with an agency token. */
    const landed = contact?.locationId ?? null;
    if (landed && landed !== process.env.GHL_LOCATION_ID) {
      console.warn(
        `ghl: contact ${id ?? "-"} landed in location ${landed}, ` +
        `not the GHL_LOCATION_ID this asked for (${process.env.GHL_LOCATION_ID})`,
      );
    }
    console.log(
      `ghl OK upsert ${id ?? "-"} ${((Date.now() - began) / 1000).toFixed(1)}s ` +
      `new=${reply.json?.new === true ? "yes" : "no"} tagged=${tagged ? "yes" : "no"}`,
    );
    return { ok: true, id, tagged };

  } catch (err) {
    const message = String((err as any)?.message ?? err);
    console.error(`ghl FAIL upsert threw :: ${trim(message)}`);
    return { ok: false, reason: message };
  }
}
