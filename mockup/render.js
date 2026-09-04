/* Flat artwork onto a fixed garment.
 *
 * The garment is a real 3D render and never changes; only the artwork does.
 * That is the whole inversion this exists for — an image generator asked for
 * "a hockey jersey" returns a different garment every time, so the garment is
 * taken out of its hands and it is asked for a flat panel instead.
 *
 * Shared by the compositor at /mockup/ and by the order page, which needs the
 * same render to show a customer their concept. Everything below is measured
 * off the five files in public/mockup/front and re-verified against their
 * pixels; that directory's README carries the numbers and how they were taken.
 *
 * No build step and no dependencies: a plain ES module, imported by both.
 */

export const CANVAS = 1500;                                  // every asset is 1500 x 1500
export const GARMENT = {x0:234, y0:97, x1:1251, y1:1398};    // Base.png alpha bounding box
export const SHADE_PIVOT = 144;                              // median luminance inside the garment

/* Base.png is neutral to within 3 levels across the whole garment, so the red
   channel is the luminance and no conversion is needed.

   The mid-tone is 144, not 128. Overlay and soft-light both pivot at 128, so
   the render is remapped around that before it is used as a shading layer —
   without it every mockup comes out washed out. */

/* The neck opening: dark mesh inside the collar, deliberately in none of the
   four masks, and no artwork may reach it. The one part of the garment the
   fill has to be told to leave alone. */
export const NECK = {x0:606, y0:148, x1:893, y1:240};

/* Painted in this order; collar last because it sits over everything it
   touches. `fill` is not a mask on disk — see buildFill. */
export const ORDER = ['body','shoulders','sleeves','collar'];
export const PAINT = ['fill', ...ORDER];

export const NAMES = {body:'Body', shoulders:'Shoulder yoke', sleeves:'Sleeves', collar:'Collar'};

export const ASSETS = {
  dir:'/public/mockup/front/',
  base:'Base.png',
  masks:{
    body:'mask-body-front.png',
    shoulders:'mask-shoulders.png',
    sleeves:'mask-sleeves.png',
    collar:'mask-collar.png',
  },
};

/* Where a crest goes on this garment, in canvas pixels. The artwork panel
   carries no emblem of its own — it is background treatment only — so anything
   that reads as a crest is a separate layer, laid on after the render.
   Two fifths of the way from shoulder to hem, sized off the garment's height. */
export const CHEST = {
  x: (GARMENT.x0 + GARMENT.x1) / 2,
  y: GARMENT.y0 + 0.40 * (GARMENT.y1 - GARMENT.y0),
  size: 0.32 * (GARMENT.y1 - GARMENT.y0),
};

/* A transform is per artwork source: the master, and one each per region.
   scale 1 means "cover the garment", not "cover the canvas". */
export const newTransform = () => ({scale:1, x:0, y:0, rot:0, tile:false});

export const DEFAULTS = {
  body:      {src:'art',   color:'#c8102e'},
  shoulders: {src:'art',   color:'#141619'},
  sleeves:   {src:'art',   color:'#141619'},
  /* Pattern across the rib almost always looks wrong, so the collar starts
     solid in both modes. It can still be switched to artwork. */
  collar:    {src:'color', color:'#141619'},
};

/** The shape render() takes. Both callers start from this and change what they need. */
export function newSpec(){
  return {
    mode:'unified',      // 'unified' | 'region'
    art:null,            // the master artwork image
    xf:newTransform(),
    contrast:1,          // 0.6 - 1.6
    blend:'overlay',     // 'overlay' | 'soft-light'
    regions:Object.fromEntries(ORDER.map(k=>
      [k,{src:DEFAULTS[k].src, color:DEFAULTS[k].color, img:null, xf:newTransform()}])),
  };
}

export function loadImage(src){
  return new Promise((ok,fail)=>{
    const im = new Image();
    im.onload = ()=>ok(im);
    im.onerror = ()=>fail(new Error(src+' did not load'));
    im.src = src;
  });
}

function offscreen(){
  const cv = document.createElement('canvas');
  cv.width = cv.height = CANVAS;
  return cv;
}
function pixels(img){
  const cv = offscreen();
  const c = cv.getContext('2d',{willReadFrequently:true});
  c.drawImage(img,0,0);
  return c.getImageData(0,0,CANVAS,CANVAS);
}
const clamp = (v,a,b) => v<a?a:v>b?b:v;

/* The four masks do not quite tile the garment. Along the right armhole seam
 * they leave a wedge — the shaded crease between body and sleeve, in neither
 * mask — up to 27px across and 13 at the median, plus around 600 sub-pixel
 * slivers on the other shared edges. Left alone every one of them shows through
 * as bare grey, and the armhole one is wide enough to read as a hairline down
 * the finished mockup.
 *
 * Dilating the body cannot reach across 27px without smearing it past its real
 * edge and under the collar and shoulder seams. So nothing is dilated and
 * nothing is guessed at: the whole silhouette is painted with the body's own
 * source and drawn underneath all four regions. Every one of them covers it, so
 * it can only ever show where none of them reach — which is exactly the gap,
 * and it takes the slivers with it in the same step.
 *
 * Underpainting the whole silhouette rather than only the gap is also what puts
 * the finished alpha exactly on Base.png's: a colour layer that is opaque right
 * to the edge survives the shading pass at full strength, and the one clip at
 * the end sets the rim. Subtract the masks from it instead and the rim is
 * assembled from two partial coverages, which lands up to 93 levels off.
 *
 * The neck opening is bare on purpose — the dark mesh inside the collar. Every
 * pixel of its rectangle is either that opening or already under the collar and
 * shoulder masks, so the rectangle comes straight back out. */
function buildFill(baseAlpha){
  const N = CANVAS*CANVAS;
  const img = new ImageData(CANVAS,CANVAS);
  for(let p=0;p<N;p++){
    img.data[p*4] = img.data[p*4+1] = img.data[p*4+2] = 255;
    img.data[p*4+3] = baseAlpha[p] ? 255 : 0;
  }
  for(let y=NECK.y0;y<=NECK.y1;y++)
    for(let x=NECK.x0;x<=NECK.x1;x++) img.data[(y*CANVAS+x)*4+3] = 0;

  const cv = offscreen();
  cv.getContext('2d').putImageData(img,0,0);
  return cv;
}

/**
 * Loads the five files and prepares everything that does not depend on the
 * artwork. Slow enough to be worth doing once — five 1500² decodes and as many
 * getImageData calls — and everything after it is per-frame cheap.
 */
export async function loadGarment(dir = ASSETS.dir){
  const base = await loadImage(dir + ASSETS.base);
  if(base.naturalWidth !== CANVAS || base.naturalHeight !== CANVAS)
    throw new Error(ASSETS.base+' is '+base.naturalWidth+'×'+base.naturalHeight+
                    ', and every measured constant in here assumes '+CANVAS+'×'+CANVAS+'.');

  const basePixels = pixels(base).data;
  const maskImgs = await Promise.all(ORDER.map(k=>loadImage(dir + ASSETS.masks[k])));
  const maskData = maskImgs.map(pixels);

  // Only the alpha channel of a mask means anything; the RGB is ignored.
  const N = CANVAS*CANVAS;
  const baseAlpha = new Uint8Array(N);
  for(let p=0;p<N;p++) baseAlpha[p] = basePixels[p*4+3];

  const MASK = {fill:buildFill(baseAlpha)};
  ORDER.forEach((k,r)=>{
    const img = maskData[r];
    for(let p=0;p<N;p++){
      const a = img.data[p*4+3];
      img.data[p*4] = img.data[p*4+1] = img.data[p*4+2] = 255;
      img.data[p*4+3] = a;
    }
    const cv = offscreen();
    cv.getContext('2d').putImageData(img,0,0);
    MASK[k] = cv;
  });

  return new Garment(base, basePixels, MASK);
}

class Garment {
  constructor(base, basePixels, masks){
    this.base = base;                  // also the final clip: it defines the silhouette
    this.basePixels = basePixels;
    this.masks = masks;

    this.canvas = offscreen();
    this.ctx = this.canvas.getContext('2d');

    // One scratch canvas per region, reused every frame.
    this.layers = Object.fromEntries(PAINT.map(k=>{
      const cv = offscreen();
      return [k,{cv, ctx:cv.getContext('2d')}];
    }));

    this.shade = offscreen();
    this.shadeCtx = this.shade.getContext('2d');
    this.shadeImg = this.shadeCtx.createImageData(CANVAS,CANVAS);
    this.contrast = null;
    this.setContrast(1);
  }

  /* The shading layer: the render recentred on 128 so overlay and soft-light,
     which both pivot there, land where the garment's own mid-tone is. */
  setContrast(k){
    if(k === this.contrast) return;
    this.contrast = k;
    const src = this.basePixels, dst = this.shadeImg.data;
    for(let i=0;i<src.length;i+=4){
      const v = clamp(128 + (src[i]-SHADE_PIVOT)*k, 0, 255);
      dst[i] = dst[i+1] = dst[i+2] = v;
      dst[i+3] = src[i+3];
    }
    this.shadeCtx.putImageData(this.shadeImg,0,0);
  }

  /* Scale 1 covers the garment's bounding box, not the 1500 canvas: fit to the
     canvas and a third of the artwork lands outside the silhouette and is never
     seen. Rotation and offset work from the centre of that same box. */
  paintArt(ctx,img,xf){
    const gw = GARMENT.x1-GARMENT.x0, gh = GARMENT.y1-GARMENT.y0;
    const cover = Math.max(gw/img.naturalWidth, gh/img.naturalHeight);
    const s = cover*xf.scale;
    const w = img.naturalWidth*s, h = img.naturalHeight*s;

    ctx.save();
    ctx.translate((GARMENT.x0+GARMENT.x1)/2 + xf.x, (GARMENT.y0+GARMENT.y1)/2 + xf.y);
    ctx.rotate(xf.rot*Math.PI/180);
    if(xf.tile){
      const pat = ctx.createPattern(img,'repeat');
      pat.setTransform(new DOMMatrix([s,0,0,s,-w/2,-h/2]));
      ctx.fillStyle = pat;
      const r = CANVAS*1.6;          // covers the canvas at any rotation
      ctx.fillRect(-r,-r,r*2,r*2);
    }else{
      ctx.drawImage(img,-w/2,-h/2,w,h);
    }
    ctx.restore();
  }

  /* What a region draws: the master artwork in unified mode, its own picture or
     flat colour in per-region mode. A region set to artwork with nothing of its
     own falls back to the master, so switching modes never empties the canvas. */
  sourceFor(spec,k){
    // The gap under the seams takes whatever the body is showing.
    const r = spec.regions[k==='fill' ? 'body' : k];
    if(spec.mode==='unified'){
      // The collar is the one region unified mode still lets go solid.
      if(k==='collar' && r.src==='color') return {color:r.color};
      return spec.art ? {img:spec.art, xf:spec.xf} : {color:r.color};
    }
    if(r.src==='color') return {color:r.color};
    const img = r.img || spec.art;
    return img ? {img, xf:r.img?r.xf:spec.xf} : {color:r.color};
  }

  paintRegion(spec,k){
    const {cv,ctx} = this.layers[k];
    ctx.setTransform(1,0,0,1,0,0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0,0,CANVAS,CANVAS);

    const src = this.sourceFor(spec,k);
    if(src.img) this.paintArt(ctx,src.img,src.xf);
    else { ctx.fillStyle = src.color; ctx.fillRect(0,0,CANVAS,CANVAS); }

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.masks[k],0,0);
    ctx.globalCompositeOperation = 'source-over';
    return cv;
  }

  /**
   * Flat colour first, then the render multiplied through it. Without that
   * second pass the output is a sticker cut to the shape of a jersey.
   *
   * Returns the garment's own canvas, redrawn in place — copy it if you need to
   * keep it past the next render.
   */
  render(spec){
    this.setContrast(spec.contrast ?? 1);
    const c = this.ctx;
    c.setTransform(1,0,0,1,0,0);
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0,0,CANVAS,CANVAS);

    for(const k of PAINT) c.drawImage(this.paintRegion(spec,k),0,0);

    c.globalCompositeOperation = spec.blend ?? 'overlay';
    c.drawImage(this.shade,0,0);

    /* The blend carries the shading layer's own alpha past the artwork's edge,
       so the silhouette is cut again from the render that defined it. The colour
       underneath is opaque to that edge, so this one clip is what sets the rim. */
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(this.base,0,0);
    c.globalCompositeOperation = 'source-over';
    return this.canvas;
  }
}
