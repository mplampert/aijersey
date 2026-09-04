# Jersey order page

One-page mobile-first flow: design → colours → roster → order.

## Deploy

```
npm i -g netlify-cli      # if you don't have it
netlify deploy --prod
```

Set the env vars, then redeploy — Netlify env changes don't reach functions
until a new deploy:

```
netlify env:set AI_GATEWAY_API_KEY <key>    # image generation and the checker
netlify env:set BLOB_READ_WRITE_TOKEN <key> # concept images
netlify env:set AIRTABLE_TOKEN <key>        # data.records:write on the base
netlify env:set AIRTABLE_BASE_ID <id>
netlify env:set AIRTABLE_TABLE_ID <id>
netlify env:set RESEND_API_KEY <key>        # the customer's copy of their design
netlify env:set SITE_URL https://…          # optional; where the reopen link points
netlify deploy --prod
```

Local: `netlify dev` for the order page, which needs its functions.
`npm run dev` serves the repo as static files — enough for `/mockup/`, which
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

**Saving.** "Don't lose this design" writes Email, Team and Phone, then emails
one link to that customer's gallery — not one link per design, because a gallery
collects everything they ever save and a mail full of individual links goes
stale the moment they make another one. The concept they saved is attached, so
the mail still shows something to somebody who never clicks through.

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

## Reading a failed generation

Every failure prints one line to the function log — `netlify dev` puts those in
the terminal — and the same diagnosis goes back to the browser console:

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
