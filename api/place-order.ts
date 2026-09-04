// Compiled output is .js, and the runtime resolves these specifiers verbatim.
import {
  EMAIL, FIELD, PAY_UNPAID, STATUS_ORDERED,
  normalPhone, patchFields, readFields, recordIdFor, rosterText,
  type Body,
} from "./save-design.js";
import { KIT, MOQ, money, quote, refuse } from "./pricing.js";

/**
 * POST /api/place-order
 *
 * The order, with no money in it.
 *
 * This is the end of what the customer does in one sitting: the roster, the
 * kit, who they are and how to reach them. It files all of that against the
 * design and marks the row Ordered, and it does not charge anybody. Payment
 * comes later and somewhere else — the factory redraws the jersey, the customer
 * approves that proof, and approve-proof is what asks for money. Taking payment
 * here would be charging for a garment nobody has agreed to yet.
 *
 * The total is written all the same, priced by pricing.ts from the roster count
 * and the kit. It is what the customer was shown and what the Stripe session
 * will charge, and having it on the row means the two can be compared later
 * without recomputing a price that may since have changed.
 *
 * The minimum is enforced here as well as on the page. The page can be edited
 * by anybody with a browser, and an order of three jerseys that reaches the
 * factory is a phone call and an apology.
 *
 * Env vars required: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID.
 */

type OrderBody = {
  recordId?: string;
  code?: string;
  email?: string;
  /** The person. Goes to the CRM, and has no column on the Designs table. */
  name?: string;
  phone?: string;
  team?: string;
  roster?: Body["roster"];
  kit?: string[];
};

export async function POST(request: Request): Promise<Response> {
  let body: OrderBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const email = (body.email || "").trim();
  if (!EMAIL.test(email)) {
    return Response.json(
      { error: "We need an email address to send your proof to — check it and try again." },
      { status: 400 },
    );
  }

  /* Priced from the roster in this request, not from whatever the debounced
     patch happened to leave on the row. The order is what was on screen when
     the customer pressed the button. */
  const roster = body.roster ?? [];
  const kit = (body.kit ?? []).filter((k) => k in KIT);
  const q = quote(roster.length, kit);

  const no = refuse(q);
  if (no) {
    console.log(`place-order REFUSED players=${roster.length} kit=${kit.join("|") || "-"} :: ${no}`);
    return Response.json({ error: no, players: roster.length, moq: MOQ, short: q.short }, { status: 400 });
  }

  const recordId = await recordIdFor(body);
  if (!recordId) {
    return Response.json(
      { error: "That design isn't on file, so there's nothing to order against." },
      { status: 404 },
    );
  }

  /* Refusing to re-place an order that is already paid for. Everything else is
     a legitimate edit — a roster corrected before the proof goes out is exactly
     what this flow is for — but a paid order changing underneath the payment
     is how somebody ends up with 40 jerseys they were charged for 12 of. */
  const on = await readFields(recordId);
  if (on?.[FIELD.payment] === "Paid") {
    return Response.json(
      { error: "This order is already paid for. Get in touch and we'll change it by hand." },
      { status: 409 },
    );
  }

  const fields: Record<string, unknown> = {
    [FIELD.email]: email,
    [FIELD.roster]: rosterText(roster),
    [FIELD.rosterCount]: roster.length,
    [FIELD.kit]: kit,
    [FIELD.status]: STATUS_ORDERED,
    // Cents everywhere but here: the Airtable column is currency, in dollars.
    [FIELD.orderTotal]: q.total / 100,
    [FIELD.payment]: PAY_UNPAID,
  };
  const team = (body.team || "").trim();
  if (team) fields[FIELD.team] = team.slice(0, 200);
  const phone = normalPhone((body.phone || "").trim());
  if (phone) fields[FIELD.phone] = phone;

  const snag = await patchFields(recordId, fields);
  if (snag) {
    return Response.json(
      { error: "We couldn't file that order just now — try again in a moment.", detail: snag },
      { status: 502 },
    );
  }

  console.log(
    `place-order OK ${recordId} players=${roster.length} kit=${kit.join("|") || "-"} ` +
    `total=${money(q.total)} unpaid`,
  );
  return Response.json({
    ok: true,
    players: roster.length,
    lines: q.lines.map((l) => ({ label: l.label, unit: l.unit, qty: l.qty, total: l.total })),
    total: q.total,
    totalText: money(q.total),
  });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
