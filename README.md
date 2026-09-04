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
real fabric drape, soft studio light, neutral background.

## What's wired

- **Design** — prompt + idea chips + logo upload. Posts to `/api/generate-concept`
  and shows what comes back.
- **Crest** — its own layer, composited onto the returned photograph: the
  uploaded logo untouched, or the team name set as a wordmark, outlined against
  whatever it lands on. Never drawn by the model. Where it goes is found in the
  pixels, since the model reframes on every generation.
- **Colours** — factory colour card, multi-select. Passed into the prompt as the
  panel's palette, capped at five: past that a model treats the list as a
  suggestion.
- **Image checks** — every concept is read before anyone sees it. A real-world
  mark or any lettering is a hard reject: one redraw, and if it comes back
  carrying either, the take is dropped rather than shown. `api/check-panel.ts`
  does the pixel side with no dependencies; the lettering verdict comes from the
  vision call `api/check-image.ts` was already making.
- **Names never reach the model.** The team name travels in its own field, is
  never interpolated into a prompt, and is scrubbed back out of the brief if a
  customer typed it there. The roster is not sent at all. No image model sets
  type legibly, and every one it draws has to be thrown away.
- **Roster** — type, paste, or CSV. Parses `12 Sullivan L` and `31 Tremblay L G`.
  Validates duplicate numbers, missing number/name/size, and the minimum.
- **Order** — live total, kit add-ons priced per player, account fields.

## What isn't

- **The wordmark is a placeholder.** A customer without a logo gets their team
  name set in bold italic, fitted to the chest and outlined for contrast. It is
  legible on any artwork and it is not a crest. Real ones are drawn, arced,
  layered — this is one line of canvas text standing in for that.
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
