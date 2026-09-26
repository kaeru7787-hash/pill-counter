import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
function files(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? files(join(dir, d.name), `${prefix}${d.name}/`)
      : [`${prefix}${d.name}`],
  );
}
const all = files("dist").filter((f) => f !== "sw.js"),
  hash = createHash("sha256");
for (const f of all) hash.update(readFileSync(join("dist", f)));
const core = all.filter(
  (f) => !f.startsWith("vendor/") && !f.startsWith("models/"),
);
writeFileSync(
  "dist/sw.js",
  `const ROOT=new URL('./',self.location.href);const PREFIX='pill-counter:'+ROOT.pathname+':';const CACHE=PREFIX+'${hash.digest("hex").slice(0, 12)}';
const CORE=${JSON.stringify(core)}.map(p=>new URL(p,ROOT).href);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(url.pathname.endsWith('.onnx')||url.pathname.endsWith('.pt'))return;if(request.method!=='GET'||url.origin!==ROOT.origin||!url.pathname.startsWith(ROOT.pathname))return;
event.respondWith(caches.open(CACHE).then(async cache=>{if(request.mode==='navigate'){const page=await cache.match(request,{ignoreSearch:true,ignoreVary:true});if(page)return page;if(url.pathname===ROOT.pathname){const shell=await cache.match(new URL('index.html',ROOT).href,{ignoreVary:true});if(shell)return shell;}}const cached=await cache.match(request,{ignoreVary:true});if(cached)return cached;try{const response=await fetch(request);if(response.ok&&response.type==='basic'&&!response.headers.get('content-type')?.includes('text/html'))await cache.put(request,response.clone());return response;}catch(error){if(url.pathname.endsWith('/models/pill-counter.onnx'))return new Response('',{status:404});throw error;}}));});`,
);
