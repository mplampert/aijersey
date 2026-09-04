# Jersey order page

One-page mobile-first flow: design → colours → roster → order.

## Deploy

```
npm i -g netlify-cli      # if you don't have it
netlify deploy --prod
```

Set the env var, then redeploy — Netlify env changes don't reach functions
until a new deploy:

```
netlify env:set GEMINI_API_KEY <key>
netlify deploy --prod
```

Local: `netlify dev` for the order page, which needs its functions.
`npm run dev` serves the repo as static files — enough for `/mockup/`, which
has no backend at all.

## The two halves

**`/` — the order page.** The customer flow: design, colours, roster, order.

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

`MODEL` in the function is `gemini-2.5-flash-image`. Check for a newer image
model before launch; also confirm your Gemini API tier allows image output.

The `BLOCKED` list in the function screens obvious trademark requests. It's a
crude keyword filter, not a substitute for reviewing every proof.
