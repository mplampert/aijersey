// Compiled output is .js, and the runtime resolves this specifier verbatim.
import {
  FIELD, PAY_PAID, PROOF_APPROVED,
  patchFields, readFields, recordIdFor,
} from "./save-design.js";

/**
 * POST /api/approve-proof   { code } or { recordId }
 *
 * The customer says yes to the factory redraw, and the order goes to be made.
 *
 * No money moves here. Payment was taken at checkout, before the factory was
 * ever asked to draw anything — they will not redraw proofs for orders that
 * never convert, so nothing reaches them until it is paid for. By the time
 * anybody is looking at a proof the order is Paid, and this endpoint is about
 * the artwork alone: it marks Proof status Approved, stamps Proof approved with
 * the time, and that is the signal production waits on.
 *
 * It refuses on an unpaid order. That should be unreachable — checkout is the
 * only way to have a proof at all — and it is checked anyway, because "release
 * this to the factory" is the one instruction here that costs real money to be
 * wrong about.
 *
 * Idempotent. A customer who presses the button twice, or an automation that
 * re-delivers, gets the same answer and the first approval time is kept: when
 * they approved is a fact about them, not about how many times the request
 * arrived.
 *
 * ## Who may call it
 *
 * Approving releases an order to production, so it is not open. Two credentials
 * work, and one of them must be presented:
 *
 *   - the customer's own gallery id, as `t`, which is the unguessable token
 *     already in their inbox — this is what a customer-facing approve button
 *     would use, and it only ever unlocks their own order;
 *   - PROOF_APPROVAL_TOKEN, as `Authorization: Bearer …`, for staff and for an
 *     Airtable automation.
 *
 * With neither configured nor supplied this endpoint refuses everything. It
 * fails closed on purpose: an approval endpoint that quietly defaults to open
 * because an env var is missing is worse than one that is switched off.
 *
 * Env vars: AIRTABLE_*; PROOF_APPROVAL_TOKEN for the staff route.
 */

/** Constant-time enough for a token compared once per request. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

export async function POST(request: Request): Promise<Response> {
  let body: { recordId?: string; code?: string; t?: string };
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

  /* Staff token first, then the customer's own gallery id. The gallery id is
     compared against this record's, so it authorises this order and no other. */
  const staffToken = (process.env.PROOF_APPROVAL_TOKEN || "").trim();
  const sent = bearer(request);
  const asStaff = staffToken.length > 0 && sent.length > 0 && sameToken(staffToken, sent);
  const gallery = (on[FIELD.gallery] || "").trim();
  const asCustomer = gallery.length > 0 && (body.t || "").trim().length > 0 &&
    sameToken(gallery, (body.t || "").trim());

  if (!asStaff && !asCustomer) {
    console.warn(`approve-proof REFUSED ${code}: no valid approval credential`);
    return Response.json(
      { error: "That approval link isn't valid. Use the link in your proof email, or ask us to approve it for you." },
      { status: 403 },
    );
  }

  /* Nothing goes to the factory unpaid. Unreachable in the normal flow — the
     only way to have a proof is to have paid for it — and checked regardless. */
  if (on[FIELD.payment] !== PAY_PAID) {
    console.warn(
      `approve-proof REFUSED ${code}: payment status is "${on[FIELD.payment] ?? "(blank)"}", not ${PAY_PAID}`,
    );
    return Response.json(
      {
        error: "This order isn't paid for, so it can't go to production yet.",
        paymentStatus: on[FIELD.payment] ?? null,
      },
      { status: 409 },
    );
  }

  // Already approved: say so and keep the original time.
  if (on[FIELD.proofStatus] === PROOF_APPROVED) {
    const already = on[FIELD.proofApproved] ?? null;
    console.log(`approve-proof: ${code} was already approved at ${already ?? "an unrecorded time"}`);
    return Response.json({ ok: true, code, approvedAt: already, alreadyApproved: true });
  }

  const approvedAt = new Date().toISOString();
  const snag = await patchFields(recordId, {
    [FIELD.proofStatus]: PROOF_APPROVED,
    [FIELD.proofApproved]: approvedAt,
  });
  if (snag) {
    return Response.json(
      { error: "We couldn't record that approval just now — try again in a moment.", detail: snag },
      { status: 502 },
    );
  }

  console.log(
    `approve-proof OK ${recordId} code=${code} released to production by ${asStaff ? "staff" : "the customer"}`,
  );
  return Response.json({ ok: true, code, approvedAt, alreadyApproved: false });
}

export async function GET(): Promise<Response> {
  return Response.json({ error: "Use POST" }, { status: 405 });
}
