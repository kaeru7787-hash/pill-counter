// Local-only prototype data. Full photographs never enter public/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
const root='work/bottle-ai';
fs.mkdirSync(root,{recursive:true});
const names=['33-red-bottles','34-green-bottles','35-blue-bottles','37-square-52'];
const manifest=[];
for(const name of names){
 const original=`work/originals/${name}.jpeg`;
 const source=await sharp(original).rotate().png().toBuffer();
 const meta=await sharp(source).metadata(), W=meta.width,H=meta.height;
 const cv=JSON.parse(fs.readFileSync(`work/v08/${name}.json`));
 // Seed positions are reviewed against the original photograph. Boxes include
 // visible body where separable; occluded portions are not invented.
 const items=cv.detections.filter(d=>name!=='35-blue-bottles'||d.center.y<1200).map((d,i)=>{
  const x=d.center.x,y=d.center.y,r=d.box.width/2;
  const dx=(W*.5-x)*.13,dy=(H*.47-y)*.16;
  const square=name==='37-square-52';
  const x1=Math.max(0,x-r*1.04+Math.min(0,dx)),y1=Math.max(0,y-r*(square?1.45:1.04)+Math.min(0,dy));
  const x2=Math.min(W,x+r*1.04+Math.max(0,dx)),y2=Math.min(H,y+r*(square?1.65:1.05)+Math.max(0,dy));
  return {id:`b${i+1}`,pose:'upright-or-tilted',anchor:d.center,box:{x:x1,y:y1,width:x2-x1,height:y2-y1}};
 });
 if(name==='35-blue-bottles'){
  // Six separately visible horizontal bottles, manually bounded on 756px preview.
  for(const [x1,y1,x2,y2,ax,ay] of [[148,585,288,694,180,652],[158,655,342,754,315,691],[289,695,432,813,397,782],[288,600,496,766,465,742],[390,548,603,728,566,692],[464,542,623,746,594,574]])
   items.push({id:`b${items.length+1}`,pose:'lying',anchor:{x:ax*2,y:ay*2},box:{x:x1*2,y:y1*2,width:(x2-x1)*2,height:(y2-y1)*2}});
 }
 const split=name==='37-square-52'?'val':'train';
 const row={name,width:W,height:H,split,sha256:crypto.createHash('sha256').update(source).digest('hex'),reference:'assistant-reviewed prototype boxes; not user-confirmed ground truth',items};
 manifest.push(row);
 fs.writeFileSync(`${root}/${name}-labels.json`,JSON.stringify(row,null,2));
 const svg=`<svg width="${W}" height="${H}">${items.map((d,i)=>`<rect x="${d.box.x}" y="${d.box.y}" width="${d.box.width}" height="${d.box.height}" fill="none" stroke="${d.pose==='lying'?'blue':'lime'}" stroke-width="3"/><text x="${d.anchor.x}" y="${d.anchor.y}" fill="white" stroke="black" stroke-width=".6" font-size="30">${i+1}</text>`).join('')}</svg>`;
 const overlay=await sharp(source).composite([{input:Buffer.from(svg)}]).png().toBuffer();
 await sharp(overlay).resize(756).png().toFile(`${root}/${name}-labels.png`);
 const images=`${root}/dataset/images/${split}`,labels=`${root}/dataset/labels/${split}`;
 fs.mkdirSync(images,{recursive:true});fs.mkdirSync(labels,{recursive:true});
 const crops=[{x:0,y:0,width:W,height:H}];
 if(split==='train')for(const y of [0,Math.round(H*.35)])for(const x of [0,Math.round(W*.35)])crops.push({x,y,width:Math.round(W*.65),height:Math.round(H*.65)});
 if(split==='train'&&process.argv.includes('--lying-crops')){
  // Rebalance the scarce lying poses without pretending these are new photos.
  crops.push({x:0,y:Math.round(H*.52),width:W,height:H-Math.round(H*.52)});
  if(name==='35-blue-bottles')crops.push({x:250,y:1080,width:1050,height:650});
 }
 for(const [i,crop] of crops.entries()){
  const boxes=[];
  for(const item of items){const b=item.box;const x1=Math.max(crop.x,b.x),y1=Math.max(crop.y,b.y),x2=Math.min(crop.x+crop.width,b.x+b.width),y2=Math.min(crop.y+crop.height,b.y+b.height);if(x2>x1&&y2>y1&&(x2-x1)*(y2-y1)/(b.width*b.height)>.35)boxes.push(`0 ${((x1+x2)/2-crop.x)/crop.width} ${((y1+y2)/2-crop.y)/crop.height} ${(x2-x1)/crop.width} ${(y2-y1)/crop.height}`);}
  await sharp(source).extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).resize({width:960,height:960,fit:'inside'}).jpeg({quality:94}).toFile(`${images}/${name}-${i}.jpg`);
  fs.writeFileSync(`${labels}/${name}-${i}.txt`,boxes.join('\n')+'\n');
 }
}
fs.writeFileSync(`${root}/manifest.json`,JSON.stringify({notes:'Split by source photograph. Crops and augmentations are NOT independent photos. Lying examples occur in one training photograph only.',images:manifest},null,2));
fs.writeFileSync(`${root}/dataset/data.yaml`,`path: ${path.resolve(root,'dataset').replaceAll('\\','/')}\ntrain: images/train\nval: images/val\nnames:\n  0: eyedrop_bottle\n`);
console.log(manifest.map(r=>({name:r.name,split:r.split,count:r.items.length})));
