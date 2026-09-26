import type { Detection } from "../types";
import { iou, type AICandidate } from "./onnxDetector";

/** Bottle boxes and cap contours are different views of one object.
 * Match one cap to at most one body; never sum both detector counts. */
export function fuseBottles(caps: Detection[], raw: AICandidate[]) {
  const bodies: AICandidate[] = [];
  for (const d of [...raw].sort((a,b)=>b.score-a.score)) {
    if (!bodies.some(p=>iou(p.box,d.box)>.55)) bodies.push(d);
  }
  const edges = bodies.map(b => caps.map((cap,i)=>({i,cap})).filter(({cap}) => {
    const {x,y}=cap.center, r=Math.min(cap.box.width,cap.box.height)*.12;
    return x>=b.box.x-r&&x<=b.box.x+b.box.width+r&&y>=b.box.y-r&&y<=b.box.y+b.box.height+r;
  }).sort((a,c)=>Math.hypot(a.cap.center.x-b.center.x,a.cap.center.y-b.center.y)-Math.hypot(c.cap.center.x-b.center.x,c.cap.center.y-b.center.y)).map(e=>e.i));
  // Augmenting paths prevent one overlapping body box stealing another's cap.
  const owner=new Map<number,number>();
  function match(body:number,visited:Set<number>):boolean {
    for(const cap of edges[body]) {
      if(visited.has(cap))continue;visited.add(cap);
      const prior=owner.get(cap);
      if(prior===undefined||match(prior,visited)){owner.set(cap,body);return true;}
    }
    return false;
  }
  bodies.forEach((_,i)=>match(i,new Set()));
  const matched=new Set(owner.values());
  const additions=bodies.filter((_,i)=>!matched.has(i));
  const detections=[...caps,...additions.map(d=>({...d,source:"ai" as const,flags:[...d.flags,"eyedrop-model"]}))]
    .sort((a,b)=>a.center.y-b.center.y||a.center.x-b.center.x)
    .map((d,i)=>({...d,id:`bottle-${i+1}`}));
  return {detections,added:additions.length,matched:matched.size,bodies};
}
