// Compiled output is .js, and the runtime resolves these specifiers verbatim.
import {
  EMAIL, FIELD, PAY_PAID, PAY_UNPAID,
  normalPhone, patchFields, readFields, recordIdFor, rosterText,
  type Body,
} from "./save-design.js";
import { createSession, readSession, stillGood, type Session } from "./stripe.js";
import { KIT, MOQ, money, quote, refuse } from "./pricing.js";

/**
 * POST /api/place-order
 *
 * The end of the customer's sitting: the roster, the kit, who they are, and
 * then Stripe.
 *
 * Everything they have entered goes onto the design first, then a Checkout
 * Session is opened for the full amount and its URL handed back for the page to
 * redirect to. The order is on record before the customer ever reaches Stripe,
 * so somebody who pays and closes the tab, or whose webhook is slow, is a
 * customer we can still find and still make jerseys for.
 *
 * **Goods only.** Shipping is quoted separately by a person once there is a box
 * to weigh; it is not a line item and not an estimate. Said on the order step,
 * said again on Stripe's own page.
 *
 * The minimum is enforced here as well as on the page, and this is the one that
 * counts: a page can be edited by anyone with a browser, and a three-jersey
 * order reaching the factory is a phone call and an apology.
 *
 * Status stays where it is. Ordered means paid for, and that is the webhook's
 * word to say — see stripe-webhook.
 *
 * Env vars required: STRIPE_SECRET_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID,
 * AIRTABLE_TABLE_ID.
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

function origin(request: Request): string {
  const configured = (process.env.SITE_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const sent = request.headers.get("origin");
  if (sent) return sent.replace(/\/+$/, "");
  try {
    return new URL(request.url).origin;
  } catch {
    return "";
  }
}

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
      { error: "We need an email address for your receipt and your proof — check it and try again." },
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

  const on = await readFields(recordId);
  if (on?.[FIELD.payment] === PAY_PAID) {
    return Response.json(
      { error: "This order is already paid for. Get in touch and we'll change it by hand.", paid: true },
      { status: 409 },
    );
  }

  /* On the record before Stripe sees it. If the customer pays and the webhook
     never lands, this is what is left to work from — and it is the roster the
     factory redraws either way. */
  const fields: Record<string, unknown> = {
    [FIELD.email]: email,
    [FIELD.roster]: rosterText(roster),
    [FIELD.rosterCount]: roster.length,
    [FIELD.kit]: kit,
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

  /* Reuse before minting. Somebody who backs out of Stripe and presses the
     button again should land on the session they already have, or two live
     ways to pay the same order exist and both of them work. A changed roster
     changes the total, which is what disqualifies the old one. */
  const existing = (on?.[FIELD.stripeSession] || "").trim();
  let session: Session | null = null;
  if (existing) {
    const found = await readSession(existing);
    if (found.ok && stillGood(found.data) && found.data.amount_total === q.total) {
      session = found.data;
      console.log(`place-order: reusing open session ${existing}`);
    }
  }
  if (!session) {
    const made = await createSession({
      quote: q,
      recordId,
      code: on?.[FIELD.code] ?? "",
      email,
      team: team || (on?.[FIELD.team] ?? null),
      origin: origin(request),
    });
    if (!made.ok) {
      /* The order is filed and nothing has been charged. Worth being plain
         about that: the customer's work is not lost, only the payment page is. */
      return Response.json(
        {
          error: "We couldn't open the payment page just now. Your order is saved — try again in a moment.",
          detail: made.message,
        },
        { status: 502 },
      );
    }
    session = made.data;
  }

  if (!session.url) {
    return Response.json(
      { error: "Stripe gave us a session with no payment page on it. Your order is saved." },
      { status: 502 },
    );
  }

  // Written before the redirect, so the webhook has something to match even if
  // the customer pays faster than this function finishes.
  await patchFields(recordId, { [FIELD.stripeSession]: session.id });

  console.log(
    `place-order OK ${recordId} players=${roster.length} kit=${kit.join("|") || "-"} ` +
    `total=${money(q.total)} session=${session.id}`,
  );
  return Response.json({
    ok: true,
    url: session.url,
    sessionId: session.id,
    players: roster.length,
    lines: q.lines,
    total: q.total,
    totalText: money(q.total),
  });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
