// Compiled output is .js, and the runtime resolves these specifiers verbatim.
import { FIELD, PAY_PAID, patchFields, readFields } from "./save-design.js";
import { verifySignature } from "./stripe.js";

/**
 * POST /api/stripe-webhook
 *
 * How Payment status ever becomes Paid.
 *
 * approve-proof gets as far as "Link sent" and then stops knowing anything: the
 * customer pays on Stripe's page, not on ours, and nothing comes back through
 * the browser that can be trusted with that. Stripe tells us instead, here.
 * Without this endpoint registered the flow still works and still takes money —
 * Airtable just never finds out, and every paid order sits at Link sent.
 *
 * Register it in the Stripe dashboard for `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded`, and put the signing secret in
 * STRIPE_WEBHOOK_SECRET. The second event is the one that fires when a slower
 * payment method settles after the customer has already left the page.
 *
 * Always answers 2xx once the signature checks out, even when the record can't
 * be written. Stripe retries a non-2xx for days, and re-delivering an event
 * whose real problem is a bad Airtable field id will not fix the field id — the
 * failure belongs in the log, where somebody can read it.
 */

/* Payment landing is what these mean; the rest of Stripe's firehose is ignored
   rather than refused, so adding an event in the dashboard by mistake is a
   logged line and not an error. */
const PAID_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

export async function POST(request: Request): Promise<Response> {
  /* The exact bytes Stripe signed. Parsing first and re-serialising would
     change the whitespace and every signature would fail. */
  const raw = await request.text();
  const signature = request.headers.get("stripe-signature");

  const checked = verifySignature(raw, signature);
  if (!checked.ok) {
    // 400 on purpose: a delivery we cannot verify is one we will not act on,
    // and Stripe should show it as failing rather than as accepted.
    console.error(`stripe-webhook REFUSED :: ${checked.why}`);
    return Response.json({ error: checked.why }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error("stripe-webhook: signature checked out but the body isn't JSON");
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const type: string = event?.type ?? "(none)";
  if (!PAID_EVENTS.has(type)) {
    console.log(`stripe-webhook: ignoring ${type}`);
    return Response.json({ received: true, ignored: type });
  }

  const session = event?.data?.object ?? {};
  const recordId: string | null =
    session.client_reference_id ?? session.metadata?.record_id ?? null;
  const code: string = session.metadata?.design_code ?? "-";

  if (session.payment_status !== "paid") {
    // completed but not paid happens on a session that needed no payment, and
    // on some async methods before they settle. The later event covers those.
    console.log(
      `stripe-webhook: ${type} for ${code} is payment_status=${session.payment_status}, not filing it as paid`,
    );
    return Response.json({ received: true, filed: false });
  }
  if (!recordId) {
    console.error(`stripe-webhook: ${type} for session ${session.id} carries no record id, nothing to file`);
    return Response.json({ received: true, filed: false });
  }

  /* What Stripe says was actually paid, against what the order said it cost.
     They should agree — the session was priced from the record — and a
     disagreement means the roster changed under a live payment link, which is
     worth a line in the log rather than silence. */
  const on = await readFields(recordId);
  const expected = Math.round(Number(on?.[FIELD.orderTotal] ?? 0) * 100);
  const paid = Number(session.amount_total ?? 0);
  if (expected && paid !== expected) {
    console.warn(
      `stripe-webhook: ${code} paid ${paid} cents against an order of ${expected} cents — ` +
      `the order changed after the link went out`,
    );
  }

  const snag = await patchFields(recordId, {
    [FIELD.payment]: PAY_PAID,
    [FIELD.stripeSession]: session.id,
    // What was really charged, so the row matches the receipt rather than the
    // quote it was generated from.
    [FIELD.orderTotal]: paid / 100,
  });
  if (snag) {
    // Answered 2xx anyway — see the note at the top. Retrying will not fix this.
    console.error(`stripe-webhook: ${code} paid but NOT filed against ${recordId} :: ${snag.message}`);
    return Response.json({ received: true, filed: false });
  }

  console.log(`stripe-webhook OK ${type} ${code} record=${recordId} paid=${paid} session=${session.id}`);
  return Response.json({ received: true, filed: true });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
