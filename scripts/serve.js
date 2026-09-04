/* Static server for local preview: `npm run dev`.
 *
 * The order page needs its functions, so it still wants `vercel dev` — this
 * serves the repo as files and nothing else. It exists for /mockup/, which is
 * pure static and only needs the five PNGs served over http rather than file://,
 * where the absolute asset paths would resolve against the filesystem root.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.PORT) || 3000;

const TYPES = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.svg':'image/svg+xml', '.webp':'image/webp', '.ico':'image/x-icon',
};

createServer(async (req,res)=>{
  try{
    // Keeps a request from climbing out of the repo with ../
    const rel = normalize(decodeURIComponent(new URL(req.url,'http://x').pathname)).replace(/^(\.\.[/\\])+/,'');
    let file = join(ROOT, rel);
    if((await stat(file).catch(()=>null))?.isDirectory()) file = join(file,'index.html');

    const body = await readFile(file);
    res.writeHead(200,{
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  }catch{
    res.writeHead(404,{'content-type':'text/plain'});
    res.end('Not found');
  }
}).listen(PORT,()=>{
  console.log(`  order page   http://localhost:${PORT}/          (no /api — use vercel dev for that)`);
  console.log(`  compositor   http://localhost:${PORT}/mockup/`);
});
