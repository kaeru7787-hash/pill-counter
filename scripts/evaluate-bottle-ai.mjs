import fs from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-web/wasm';
import {inferViews} from '../.runtime/src/ai/onnxDetector.js';
import {fuseBottles} from '../.runtime/src/ai/bottleFusion.js';
import {analyzeBottles} from '../.runtime/src/vision/bottlePipeline.js';
ort.env.wasm.numThreads=1;
const root='work/bottle-ai';
const model=JSON.parse(fs.readFileSync(`${root}/${process.argv[2]||'prototype'}-training.json`));
const session=await ort.InferenceSession.create(fs.readFileSync(model.onnx),{executionProviders:['wasm']});
const config={format:'yolov8-detect',inputSize:640,classes:1,allowedClasses:[0],scoreThreshold:.45,iouThreshold:.55};
const manifest=JSON.parse(fs.readFileSync(`${root}/manifest.json`));
// Bipartite matching uses CV cap anchors or AI visible-body IoU, never totals alone.
function metrics(ds,refs){
 const iou=(a,b)=>{const n=Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));return n/(a.width*a.height+b.width*b.height-n)};
 const edges=ds.map(d=>refs.map((r,j)=>({j,s:d.source==='cv'?1-Math.hypot(d.center.x-r.anchor.x,d.center.y-r.anchor.y)/70:iou(d.box,r.box)})).filter(e=>e.s>(d.source==='cv'?0:.3)).sort((a,b)=>b.s-a.s).map(e=>e.j));
 const owners=new Map();function match(i,seen){for(const j of edges[i]){if(seen.has(j))continue;seen.add(j);if(!owners.has(j)||match(owners.get(j),seen)){owners.set(j,i);return true}}return false}ds.forEach((_,i)=>match(i,new Set()));
 return {tp:owners.size,fp:ds.length-owners.size,fn:refs.length-owners.size,missing:refs.filter((_,i)=>!owners.has(i)).map(r=>r.id)};
}
const rows=[];
try{for(const sample of manifest.images){
 const {data,info}=await sharp(`work/originals/${sample.name}.jpeg`).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const image={data:new Uint8ClampedArray(data),width:info.width,height:info.height};
 const start=performance.now();
 const cv=await analyzeBottles(image,{target:'bottle',scene:'tray',autoROI:false,debug:false,parameters:{}});
 const raw=await inferViews(image,cv.roi,config,session,ort,[],false);
 const fused=fuseBottles(cv.detections,[...raw.detections,...raw.tiles]);
 const row={name:sample.name,split:sample.split,reference:sample.items.length,cv:cv.detections.length,ai:fused.bodies.length,hybrid:fused.detections.length,baseline:metrics(cv.detections,sample.items),candidate:metrics(fused.detections,sample.items),elapsed:Math.round(performance.now()-start)};
 rows.push(row);console.log(JSON.stringify(row));
 fs.writeFileSync(`${root}/${sample.name}-result.json`,JSON.stringify({row,cv,raw,fused}));
 const svg=`<svg width="${info.width}" height="${info.height}">${fused.detections.map((d,i)=>`<rect x="${d.box.x}" y="${d.box.y}" width="${d.box.width}" height="${d.box.height}" fill="none" stroke="${d.source==='ai'?'blue':'lime'}" stroke-width="3"/><text x="${d.center.x}" y="${d.center.y}" fill="white" stroke="black" stroke-width=".6" font-size="32">${i+1}</text>`).join('')}</svg>`;
 const overlay=await sharp(data,{raw:{width:info.width,height:info.height,channels:4}}).composite([{input:Buffer.from(svg)}]).png().toBuffer();
 await sharp(overlay).resize(756).png().toFile(`${root}/${sample.name}-result.png`);
}}finally{await session.release()}
fs.writeFileSync(`${root}/evaluation.json`,JSON.stringify({config,model,rows},null,2));
