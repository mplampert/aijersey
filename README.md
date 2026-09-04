# Jersey order page

One-page mobile-first flow: design → colours → roster → order.

## Deploy

Vercel. The `/api` handlers are Vercel serverless functions, and the concept
images live in Vercel Blob.

```
npm i -g vercel      # if you don't have it
vercel link          # once — connects this folder to the Vercel project
vercel --prod
```

Set the env vars, then redeploy. Vercel bakes them into a deployment as it is
built, so a variable added afterwards does not reach the functions already
running — it applies to the next deploy, and only to it:

```
vercel env add AI_GATEWAY_API_KEY production    # image generation and the checker
vercel env add BLOB_READ_WRITE_TOKEN production # concept images
vercel env add AIRTABLE_TOKEN production        # data.records:write on the base
vercel env add AIRTABLE_BASE_ID production
vercel env add AIRTABLE_TABLE_ID production
vercel env add RESEND_API_KEY production        # the customer's copy of their design
vercel env add SITE_URL production              # optional; where the reopen link points
vercel env add GHL_API_TOKEN production         # optional; the CRM row for a saved design
vercel env add GHL_LOCATION_ID production       # optional; the GHL sub-account
vercel env add STRIPE_SECRET_KEY production     # the payment link, after proof approval
vercel env add STRIPE_WEBHOOK_SECRET production # whsec_…; without it nothing is ever marked Paid
vercel env add PROOF_APPROVAL_TOKEN production  # optional; lets staff approve a proof
vercel --prod
```

Each prompts for the value rather than taking it as an argument, so no key ends
up in shell history; pipe it in to script one:
`printf %s '<key>' | vercel env add GHL_API_TOKEN production`. Repeat with
`preview` or `development` in place of `production` for the environments that
need the same value. `vercel env ls` says what is actually set, which is the
first thing to check when a function behaves as though a key is missing —
**connecting a Blob store to the project sets `BLOB_READ_WRITE_TOKEN` on its
own**, so that one is usually already there.

### api/ and lib/

**Every file in `api/` becomes a Serverless Function**, whether or not it
exports a handler, and a Hobby deployment allows twelve. Five shared modules
sitting in there took the count to thirteen and the build stopped. They live in
`lib/` now — imported by the functions, deployed as none of them — which is also
why `api/` holds nine files and no helpers. Put shared code in `lib/`; put a
thing with a `POST` in `api/`.

Local: `vercel dev` for the order page, which needs its functions. Run
`vercel env pull .env.local` first so it has the keys — that file holds real
secrets and is gitignored, along with `.vercel/`. `npm run dev` serves the repo
as static files instead, with no functions at all — enough for `/mockup/`, which
has no backend at all.

## The two halves

**`/` — the order page.** The customer flow: design, colours, roster, order.

**`/designs/` — the customer's gallery.** Every design saved under one email
address: thumbnail, code, date and a button that opens it in the builder,
newest first. Reached only by the random token in its URL — see below.

**`/mockup/` — the mockup compositor. Parked, and not in the customer path.**
It takes a flat artwork panel and renders it onto a fixed 3D jersey: the render
in `public/mockup/front/`, clipped through four region masks with its own
shading laid back over the top. It works, it is tested, and nothing calls it —
`mockup/render.js` and the five assets sit here unused.

It was built to take the garment away from the image model, which returns a
different one every time. What that bought was a garment that never changed
shape. What it cost was that the render is one jersey on one silhouette, and a
flat panel through it reads as a drawing rather than as a photograph of
something you can buy. So the generator draws the garment again, and the
compositor stays in the repo for when a second look is wanted.

`/api/generate-concept` now returns the finished sales image: the jersey front
and back on wooden hangers with a matching pair of leg socks laid alongside,
real fabric drape, soft studio light, neutral background. The socks coordinate
rather than copy: same palette, stripe bands across the lower third, and the
jersey's scene deliberately does not continue onto them. The design is asked
for as an illustrated scene built from the theme rather than a stripe set —
left to itself a model gives back two bands on a solid body — with a mascot or
icon at the chest, and the vibe the customer picks says how it is drawn rather
than what it is of.

## What's wired

- **Design** — prompt + idea chips + logo upload. Posts to `/api/generate-concept`
  and shows what comes back.
- **Find my designs** — one box beside the design code that takes a code or an
  address. The shapes are unmistakable, so nobody is asked which one they have.
  A code that turns out to be wrong costs an error message and not the concept
  already on screen.
- **Crest** — an uploaded logo is composited onto the returned photograph
  untouched, and the chest is asked to be left clear for it. Where it goes is
  found in the pixels, since the model reframes on every generation. A customer
  who has no logo answered "design one for us", and what designs it is the model:
  an illustrated mascot with the team name set as a wordmark below or across it,
  drawn into the scene, so nothing is composited over it.
- **Spelling is checked, not hoped for.** The team name reaches the model for
  that one wordmark and nowhere else, and the checker is handed the same string.
  A crest that reads anything but that name — a misspelling, a doubled letter, an
  invented word — is rejected and redrawn, and dropped if the redraw is wrong
  too. Same for the back: exactly NAME and exactly 00.
- **Colours** — factory colour card, multi-select. Passed into the prompt as the
  panel's palette, capped at five: past that a model treats the list as a
  suggestion.
- **Image checks** — every concept is read before anyone sees it. A real-world
  mark, or any lettering beyond the back nameplate, is a hard reject: one redraw,
  and if it comes back carrying either, the take is dropped rather than shown.
  The verdict comes from the vision call `api/check-image.ts` was already making,
  which knows the back is supposed to read exactly NAME and 00 and rejects
  anything else — a real name, a wrong number, a misspelling, type on the front
  or the socks. `api/check-panel.ts` still reads the pixels for type with no
  dependencies, but only as a log line: it sees shapes, not characters, so it
  cannot tell NAME from NAMF.
- **Names never reach the model.** The team name travels in its own field, is
  never interpolated into a prompt, and is scrubbed back out of the brief if a
  customer typed it there. The roster is not sent at all. No image model sets
  type legibly, and every one it draws has to be thrown away.
- **Roster** — type, paste, or CSV. Parses `12 Sullivan L` and `31 Tremblay L G`.
  Validates duplicate numbers, missing number/name/size, and the minimum.
- **Order** — live total, kit add-ons priced per player, account fields.

## Pacing

The three takes go one at a time, `CFG.spacing` apart, not all at once. Fired
together they trip the provider's images-per-minute cap and two of the three
come back 429 — the calls are spent either way, so the customer loses two
options for nothing. A take that is rate limited waits out the `Retry-After` the
provider sent and goes again, up to `CFG.rateRetries` times, counting down in
the progress list so a minute of waiting reads as waiting.

The function does not retry a 429 itself. Asking again in the same millisecond
is one more request against the same cap, and a serverless function has an
execution limit to run into where the browser does not.

Tune `spacing`, `rateRetries` and `waitCap` in `CFG`.

## Email and the gallery

`api/send-design.ts`, from `noreply@send.lampertsusa.com`. The domain has to be
verified in Resend or every send is refused. Two things trigger it, both of them
a customer typing their address and pressing a button. Nothing sends unprompted.

**Saving.** "Don't lose this design" asks for a name and an address, and takes a
phone number if it is offered. It writes Email, Team and Phone to the design and
the whole lot to the CRM, then emails one link to that customer's gallery — not
one link per design, because a gallery collects everything they ever save and a
mail full of individual links goes stale the moment they make another one. The
concept they saved is attached, so the mail still shows something to somebody
who never clicks through.

**Lookup.** "Find my designs", next to the design code, takes either. A
four-character code opens that design on the spot, no email involved. An address
is emailed the same gallery link. `api/email-designs.ts` answers identically whether or not the
address is on file: saying "no designs found" would turn it into a way to ask
which addresses are real, and the person who owns the address finds out in their
inbox either way.

### The gallery link

`/designs/?t=<token>`, read by `api/gallery.ts`. The token is 128 random bits,
base64url, minted the first time an address saves and reused ever after, stored
in **Gallery id** (`fldoNMDzarxLKYkwB`) on every design belonging to that
address.

It is deliberately not the address. `/designs?t=someone@gmail.com` would let
anybody type in an address and read that person's designs. Same unlisted-link
model as **Share id** on the Proofs table in the Lamperts base: anyone holding
the link can see the gallery, so it is unlisted rather than private, and it goes
nowhere but that customer's own inbox. The endpoint refuses anything that is not
token-shaped, and returns codes, dates and pictures only — never the address the
gallery belongs to.

Attachment URLs are handed out live rather than stored: Airtable expires them
within hours, so each load of the page gets fresh ones. The email's attachment
is Airtable's 768px thumbnail rather than the original — a concept is 2.6MB and
the thumbnail is 610KB, wider than it will ever be displayed.

**A gallery starts from the address, not before it.** A design generated before
the customer typed an email has no address on it and joins no gallery. Saving
does stamp the whole of that visit — all three takes from one generation, not
just the one on screen — but anything from an earlier visit stays out. So a
first gallery is thin, and fills up from there.

Sending is best-effort and never fails the save: the design, the address and the
token are on record before it runs, and the page says which happened rather than
promising mail that did not go. It also offers the gallery link inline, since
somebody who just typed their address is right there.

## The CRM row

`api/ghl-contact.ts`. The same save that sends the email also files the customer
in GoHighLevel, so a lead is in the CRM without anybody copying it across. It
runs after the mail, because it is the least time-critical thing a save does and
the customer is waiting on the response.

**Upsert, by email.** `POST /contacts/upsert` on the v2 API, which matches on the
address within the location. A customer who saves a second design a week later
updates the contact they already have; a create would split one person's history
across two rows. The address is always sent, and the phone number never stands in
for it.

The customer's own name goes in as `firstName` and `lastName` — first word
first, the rest last — and the team goes in as `companyName`. Not the same
field: the team used to stand in for both, which put "Riverside Rockets" where a
person's name goes and left every contact addressed as a hockey club. A one-word
name is a first name with no last. The phone goes in E.164, as the save already
normalised it. Each is sent only when that save carried it, so a save that
changed nothing but the address leaves what is already on the contact alone.

The name is the one thing here with no Airtable column behind it — it exists to
name the contact, and the Designs table has nowhere to put it. So it reaches GHL
or it is not kept at all. Add a column to the base and it can be written like
the phone and the team are.

**Three custom fields have to exist on the contact:** `design_code`,
`design_gallery` and `design_image` — the four-character code, the gallery link,
and the concept picture, so a GHL email can show the customer their own jersey
inline. They are looked up once per warm function and written by id rather than
by key, because a key GHL doesn't recognise is dropped silently — the contact
saves and the code simply isn't on it. If the lookup is refused (a token without
`locations/customFields.readonly`) it falls back to writing by key; if a field
doesn't exist at all, the log says which one to create.

`design_image` is the **blob** URL, not the Airtable attachment URL sitting next
to it. Airtable expires attachment URLs within hours, which is fine for the
email — that fetches the bytes and attaches them at send time — and wrong for
anything that stores a link and renders it later: a GHL mail would show the
jersey this afternoon and a broken image every day after. The blob is the
original upload, is public, and stays where the save put it. It is found by
listing `designs/<session>/<code>-concept`, so nothing had to be stored to make
this work and designs filed before any of it existed resolve too. That listing
needs `BLOB_READ_WRITE_TOKEN`, which saving already requires. A picture that
can't be found leaves the field empty and is logged; it never fails a save.

**The tag is `ai-jersey-lead`, added on its own call** rather than in the upsert
body. Tags sent with an upsert replace what the contact has, and a returning
customer's contact may carry tags a person put there by hand — nothing this page
does should quietly clear someone's CRM.

### Reading a GHL write

Every request and every response is logged, on success as much as on failure —
a 200 that quietly did nothing looks exactly like a 200 that created the contact
unless you can see the body. `ghl →` is what was sent, `ghl ←` is the status and
raw body that came back. The `Authorization` header is the only thing held back;
`token=private-integration/…ch` says what kind of token is configured and how
long it is, never any of it.

So, for a save where no contact appeared, in the function log:

- **`ghl: NO CONTACT WRITTEN — not configured`** — the env vars aren't reaching
  the function. Vercel bakes env vars into a deployment as it builds, so this is
  also what a variable added after the running deployment was built looks like —
  `vercel env ls` will show it and the function still won't see it.
- **Nothing at all** — the save never got as far as the CRM. Look further up for
  the Airtable patch failing, or for the address not being in the payload.
- **`ghl ← upsert 401`** — the token. `Invalid JWT` is a bad or expired one;
  `this authClass does not have access to this scope` is a real token missing
  `contacts.write`.
- **`ghl ← upsert 403`** — the token is fine but has no rights over that
  `GHL_LOCATION_ID`, which is what an agency-level token does here.
- **`ghl ← upsert 422`** with a list of messages — the payload; the `ghl →` line
  above it is exactly what was sent.
- **`ghl: contact … landed in location …`** — it worked, into a different
  sub-account. The contact exists; nobody is looking where it is.
- **`ghl OK upsert`** with a real id and no warning — GHL took it, and the
  contact is in that location under the address on the `ghl →` line.

`ghl: contact custom fields on <location>: …` lists what the location actually
has, next to a line per field this wanted and didn't find. That mapping is
cached for the life of a warm function, so fields created in GHL after the fact
are picked up on the next deploy or cold start, not immediately.

Best-effort, like the email beside it: the design, the address and the gallery
token are all on record before this runs, and nothing here can fail a save or
lose a customer their email. Leave `GHL_API_TOKEN` and `GHL_LOCATION_ID` unset and the page runs
exactly as it did, minus the contact.

## Pacing

The three takes go one at a time, `CFG.spacing` apart, not all at once. Fired
together they trip the provider's images-per-minute cap and two of the three
come back 429 — the calls are spent either way, so the customer loses two
options for nothing. A take that is rate limited waits out the `Retry-After` the
provider sent and goes again, up to `CFG.rateRetries` times, counting down in
the progress list so a minute of waiting reads as waiting.

The function does not retry a 429 itself. Asking again in the same millisecond
is one more request against the same cap, and a serverless function has an
execution limit to run into where the browser does not.

Tune `spacing`, `rateRetries` and `waitCap` in `CFG`.

## Email

`api/send-design.ts`, from `noreply@send.lampertsusa.com`. The domain has to be
verified in Resend or every send is refused. Two things trigger it, both of them
a customer typing their address and pressing a button. Nothing sends unprompted.

**Saving.** "Don't lose this design" writes Email, Team and Phone, then emails
back **every design from that session**, not just the one on screen — a customer
generates three takes and all three are theirs. The address is written to every
row in the session too, which is what makes the lookup below return all of them.
A palette or a roster patching the same row later does not re-send.

**Lookup.** "Saved a design here before?" takes an address and emails every
design filed under it. Before this, the four-character code was the only route
back to a design and nothing read the Email column at all — a customer who lost
the code had lost the design. `api/email-designs.ts` answers the same way
whether or not the address is on file: saying "no designs found" would turn it
into a way to ask which addresses are real, and the person who owns the address
finds out in their inbox either way.

Each design in the mail gets its own code, its own thumbnail and its own reopen
link. The pictures travel as attachments shown inline, not as links, because
Airtable's attachment URLs expire within hours and a customer opening the mail
next week would find holes where their jerseys were. They are Airtable's 768px
thumbnails rather than the originals: a concept is 2.6MB and a session is three
of them, and the thumbnail is 610KB and larger than it will ever be displayed.

Sending is best-effort and never fails the save: the design and the address are
on record before it runs, and the page says which happened rather than promising
mail that did not go.

## Money

Paid in full at checkout, for goods only. The flow is: concept → roster and
details → **pay** → factory redraws it → customer approves the proof →
production.

Paying before the proof exists is only reasonable because of what is promised
next to the button, in the FAQ, and in the confirmation email, in the same
words each time: *we'll revise the proof until it's right; if it still isn't, we
refund you in full; nothing goes into production until you approve.* That
sentence is load-bearing — it is the answer to "what am I paying for, exactly?"
and it should not be quietly softened.

### Prices

`api/pricing.ts`, in cents, and it is the only thing that decides what anybody
is charged.

| | each |
|---|---|
| Jersey, name and number included | $49.99 |
| Matching socks | $24.00 |
| Skate soakers | $19.00 |
| Player bags | $99.00 |

One of each per player: a roster of 14 with socks buys 14 jerseys and 14 pairs.
**Minimum order is 12 jerseys.**

Cents, not dollars, all the way to Stripe — which wants cents anyway. $49.99 is
not representable in binary floating point and twelve of them come to
599.8799999999999, which is a rounding error somebody eventually gets billed
for. `CFG.jerseyPrice` and `CFG.kit` in `index.html` carry the same numbers so
the page can show a running total as the roster is typed; **that copy is display
only and has to match `pricing.ts`.** Change both or neither — a page that
quotes one figure while the server charges another is the worst version of this.

### Shipping is not calculated

Not by the page, not by the server, not by Stripe. There is no estimate, no
shipping line item and no `shipping_options` on the session. The order summary
carries a **Shipping — quoted separately** row next to the total rather than in
small print, Stripe's own page repeats it above the pay button via
`custom_text`, and the confirmation email says it again under the amount. A
total that turns out not to have been the total is the fastest way to lose
somebody's trust, so it is said three times in the three places money is shown.

### The minimum, in three places

The button says how many more are needed rather than "fix the roster",
`validate()` won't enable it, and `place-order` refuses the request. The third
one is the one that counts: a page can be edited by anyone with a browser, and a
three-jersey order reaching the factory is a phone call and an apology.

### Checkout

`api/place-order.ts`. Writes the roster, kit, contact details and the priced
total to the design, marks it `Unpaid`, opens a Stripe Checkout Session for the
full amount and hands back the URL for the page to redirect to.

The order is on the record **before** the customer ever reaches Stripe. Somebody
who pays and closes the tab, or whose webhook is slow, is still a customer we
can find and still make jerseys for. The session id is written before the
redirect too, so a payment can be matched to the row even if Stripe's webhook
beats the function that opened the session.

Backing out and pressing the button again returns the customer to the same
session while it is still open and the total still matches — otherwise two live
ways to pay one order exist and both of them work. An order already `Paid`
refuses to be re-placed: a paid order changing underneath the payment is how
somebody ends up with 40 jerseys they were charged for 12 of.

**Status is left alone here.** `Ordered` means paid for, and only the webhook
says it.

### Getting told it was paid

`api/stripe-webhook.ts`. The customer pays on Stripe's page, so nothing that
comes back through the browser can be trusted with marking money received —
which is also why the confirmation email is sent from here rather than from the
redirect back. Somebody who pays and closes the tab has still paid, and is still
owed their receipt.

Register the endpoint for `checkout.session.completed` and
`checkout.session.async_payment_succeeded`, and set `STRIPE_WEBHOOK_SECRET`.
**Without it the money still arrives and nothing else happens** — no order is
marked `Ordered`, no payment is recorded, and no confirmation goes out.

On a paid session it writes **Payment status** `Paid`, the **Stripe session id**,
the amount actually charged into **Order total**, and **Status** `Ordered`, then
emails the confirmation from `noreply@send.lampertsusa.com` — priced from the
record, because the session would need its line items expanded to say the same
thing.

Signatures are checked against the raw body before anything is parsed, with a
five-minute tolerance so a captured delivery can't be replayed. A delivery that
fails that check gets a 400. Anything that passes gets a 2xx even when the
Airtable write fails, because Stripe retries a non-2xx for days and re-delivery
will not fix a bad field id — that belongs in the log. The webhook also compares
what Stripe charged against **Order total** and warns when they differ, which
means the roster changed while a checkout was open.

### Approving the proof

`api/approve-proof.ts`, `POST { code }` — and no money moves in it. Payment was
taken at checkout, before the factory was ever asked to draw anything, because
they will not redraw proofs for orders that never convert. By the time anybody
is looking at a proof the order is `Paid`, so approval is about the artwork
alone: it sets **Proof status** `Approved`, stamps **Proof approved**, and that
is the signal production waits on. It refuses on an unpaid order anyway.

Idempotent — pressing twice keeps the first approval time, because when they
approved is a fact about them and not about how many times the request arrived.

**It is not open.** Approving releases an order to production, so one of two
credentials is required: the customer's own **Gallery id** as `t` (the
unguessable token already in their inbox, and it unlocks only their order), or
`PROOF_APPROVAL_TOKEN` as `Authorization: Bearer …` for staff and automations.
With neither configured nor supplied it refuses everything — it fails closed on
purpose, because an approval endpoint that defaults to open because an env var
is missing is worse than one that is switched off.

There is no customer-facing approve button yet. The `t` route is there so one
can be added without touching this endpoint.

### On the record

Three fields on **Designs**, created for this:

| Field | |
|---|---|
| **Payment status** | `Unpaid` at checkout → `Paid` by the webhook. `Refunded` is by hand. |
| **Stripe session id** | `cs_live_…`, written before the redirect |
| **Order total** | goods only; rewritten by the webhook to what was really charged |
| **Proof approved** | when the customer released it to production |

## Reading a failed generation

Every failure prints one line to the function log — `vercel dev` puts those in
the terminal, and in production they are the project's Runtime Logs — and the
same diagnosis goes back to the browser console:

```
generate-concept FAIL bold rate-limit status=429 8.4s code=rate_limit_exceeded retry-after=12 sdk-retries=2 attempt=1/2 :: Rate limit reached for images per min
generate-concept FAIL safe rejected code=lettering 21.0s dropped after redraw :: crest reads HARBUOR SEALS
generate-concept OK scene 12.1s openai/gpt-image-2
```

`kind` is the thing to read first: `rate-limit`, `timeout`, `content-filter`,
`auth`, `server`, `network`, `bad-request`, `no-image`, or `rejected` — that
last one means the image arrived and our own checker threw it away, which is a
different problem from the provider failing. `sdk-retries` is how many attempts
the SDK made underneath before giving up, `attempt` is ours on top of that.

A take that is dropped is never shown, so a run of three can land one image and
still have cost six generations. `REDRAW` lines say what the checker objected to
the first time.

## What isn't

- **The model is setting type again, and that is the known risk.** Eleven
  generations in a row once came back with a garbled team name, which is why the
  name was pulled out of the prompt in the first place. It is back, for the crest
  wordmark only, with an exact-spelling check standing behind it — so a bad one
  costs a take rather than reaching a customer. Expect a lower hit rate per
  generation, and watch the drop rate in the logs.
- **The crest constants want re-measuring.** `CREST` in `index.html` was
  measured on concepts that had no hangers and no socks in the frame. The search
  handles both — it steps over a hanger hook and a sock is too narrow to mistake
  for a jersey — but `chest`, `size` and the fallback medians are all from the
  old framing. Check them against the first real batch.
- **A shared design refines from its crested copy.** Opening a saved design by
  code puts the same image in both `src` and `raw`, so a refinement sends the
  model a concept with our crest already on it and it may redraw it. Saving the
  uncrested image alongside would fix it.
- **Checkout.** Button logs the order payload to the console. Point it at
  Stripe Checkout or a Shopify draft order.
- **Accounts.** Fields collect, nothing persists. Needs a backend.
- **Roster delivery.** Payload needs to go somewhere — email, GHL, or Blobs.

## Change these first

Everything tunable is in the `CFG` object at the top of the script in
`index.html`: minimum order, jersey price, add-ons and their prices, sizes,
and the colour card. Replace the colour card with your factory-matched
swatches — the twenty in there now are plausible placeholders, not real.

`MODEL` in the function is `openai/gpt-image-2`, confirmed present on the
gateway's public model list (`curl https://ai-gateway.vercel.sh/v1/models`, no
key needed). That list is the place to check when a slug stops working — note
Flux is owned by `bfl`, not `black-forest-labs`.

The `BLOCKED` list in the function screens obvious trademark requests. It's a
crude keyword filter, not a substitute for reviewing every proof.
