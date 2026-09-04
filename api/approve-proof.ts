// Compiled output is .js, and the runtime resolves these specifiers verbatim.
import {
  FIELD, PAY_LINK_SENT, PAY_PAID, PROOF_APPROVED,
  patchFields, readFields, recordIdFor,
} from "./save-design.js";
import { sendPaymentLink } from "./send-design.js";
import { createSession, readSession, stillGood, type Session } from "./stripe.js";
import { money, quote, refuse } from "./pricing.js";

/**
 * POST /api/approve-proof   { code } or { recordId }
 *
 * The moment money is asked for.
 *
 * The customer has a factory redraw in front of them and has said yes to it.
 * This prices the order from what is actually on the record, opens a Stripe
 * Checkout Session for the full amount, writes the session id and Link sent
 * against the design, and emails the customer the link. Nothing before this
 * point charges anybody, which is the point.
 *
 * **It does not approve anything.** Airtable is where a proof is approved —
 * somebody sets Proof status to Approved, by hand or by automation — and this
 * refuses to run until that has happened. That is what makes the endpoint safe
 * to leave open: it cannot be used to conjure a payment demand out of nothing,
 * only to re-send one for an order that a human has already approved, to the
 * address already on that order. Point an Airtable automation at it — when
 * Proof status becomes Approved, POST the record id — and the flow runs itself.
 *
 * Re-runnable on purpose. A Checkout Session expires 24 hours after it is
 * created, so the link in a mail somebody opens on Monday is dead. Running this
 * again checks the session already on the record, reuses it while it is still
 * good, and mints a fresh one when it isn't. Re-approving is how the customer
 * gets another link.
 *
 * Env vars required: STRIPE_SECRET_KEY, RESEND_API_KEY, AIRTABLE_*.
 */

const KIT_FIELD = FIELD.kit;

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
  let body: { recordId?: string; code?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const recordId = await recordIdFor(body);
  if (!recordId) {
    return Response.json({ error: "No design on file with that code." }, { status: 404 });
  }
  const on = await readFields(recordId);
  if (!on) {
    return Response.json({ error: "We couldn't read that design just now." }, { status: 502 });
  }

  const code = on[FIELD.code] ?? "";
  const proof = on[FIELD.proofStatus] ?? "Not sent";

  /* The gate. Everything below spends money's worth of trust — it emails a
     customer a demand for several hundred dollars — so it runs only for a proof
     a person has marked Approved in Airtable. */
  if (proof !== PROOF_APPROVED) {
    console.log(`approve-proof REFUSED ${recordId} code=${code} proof status is "${proof}"`);
    return Response.json(
      {
        error: `That proof isn't approved yet — its status is "${proof}". ` +
          `Set Proof status to ${PROOF_APPROVED} in Airtable first.`,
        proofStatus: proof,
      },
      { status: 409 },
    );
  }

  if (on[FIELD.payment] === PAY_PAID) {
    console.log(`approve-proof: ${recordId} code=${code} is already paid, no link sent`);
    return Response.json({ error: "This order is already paid for.", paid: true }, { status: 409 });
  }

  const email = (on[FIELD.email] || "").trim();
  if (!email) {
    return Response.json(
      { error: "There's no email address on this design, so there's nowhere to send the link." },
      { status: 409 },
    );
  }

  /* Priced from the record, never from the request: this endpoint is reachable
     by an automation and by whoever holds the code, and neither gets a say in
     what the order costs. */
  const players = Number(on[FIELD.rosterCount] ?? 0);
  const kit: string[] = Array.isArray(on[KIT_FIELD]) ? on[KIT_FIELD] : [];
  const q = quote(players, kit);
  const no = refuse(q);
  if (no) {
    console.log(`approve-proof REFUSED ${recordId} code=${code} :: ${no}`);
    return Response.json({ error: no, players, moq: q.short + players }, { status: 409 });
  }

  /* Reuse before minting. A session already sent and still open is the link the
     customer may already have in front of them, and a second one would leave
     two live ways to pay the same order. */
  const existing = (on[FIELD.stripeSession] || "").trim();
  let session: Session | null = null;
  if (existing) {
    const found = await readSession(existing);
    if (found.ok && stillGood(found.data) && found.data.amount_total === q.total) {
      session = found.data;
      console.log(`approve-proof: reusing session ${existing} for ${code}`);
    }
  }
  if (!session) {
    const made = await createSession({
      quote: q,
      recordId,
      code,
      email,
      team: (on[FIELD.team] || "").trim() || null,
      origin: origin(request),
    });
    if (!made.ok) {
      return Response.json(
        { error: "We couldn't open a payment just now — nothing has been charged.", detail: made.message },
        { status: 502 },
      );
    }
    session = made.data;
  }

  if (!session.url) {
    return Response.json(
      { error: "Stripe gave us a session with no payment link on it." },
      { status: 502 },
    );
  }

  /* Written before the mail goes. If the send fails the link is still on the
     record and re-running this reuses it, where a mail sent against a session
     nobody wrote down would be unrecoverable. */
  const snag = await patchFields(recordId, {
    [FIELD.stripeSession]: session.id,
    [FIELD.payment]: PAY_LINK_SENT,
    [FIELD.orderTotal]: q.total / 100,
  });
  if (snag) {
    console.error(`approve-proof: session ${session.id} exists but was not filed against ${recordId}`);
  }

  const sent = await sendPaymentLink({
    to: email,
    url: session.url,
    code,
    team: (on[FIELD.team] || "").trim() || null,
    lines: q.lines,
    total: q.total,
  });

  console.log(
    `approve-proof OK ${recordId} code=${code} total=${money(q.total)} ` +
    `session=${session.id} emailed=${sent.ok ? "yes" : "no"}`,
  );
  return Response.json({
    ok: true,
    code,
    sessionId: session.id,
    url: session.url,
    total: q.total,
    totalText: money(q.total),
    emailed: sent.ok,
    filed: !snag,
  });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
