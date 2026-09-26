import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseBottles } from "../src/ai/bottleFusion";
import type { Detection } from "../src/types";
import type { AICandidate } from "../src/ai/onnxDetector";
const cap=(x:number,y:number):Detection=>({id:`${x}`,center:{x,y},box:{x:x-5,y:y-5,width:10,height:10},area:100,contour:[],source:"cv",flags:[]});
const body=(x:number,y:number,width:number,height:number,score=.9):AICandidate=>({id:`${x}-${y}`,center:{x:x+width/2,y:y+height/2},box:{x,y,width,height},area:width*height,contour:[],source:"ai",flags:[],score,view:"full"});
test("cap and body count once; an unmatched lying bottle is added",()=>{
 const caps=[cap(20,20),cap(65,20)];
 const result=fuseBottles(caps,[body(10,10,25,70),body(55,10,25,70),body(10,100,90,25)]);
 assert.equal(result.detections.length,3);assert.equal(result.added,1);
 assert.equal(result.detections.filter(d=>d.source==='ai').length,1);
 assert.deepEqual(caps.map(d=>d.id),['20','65']);
});
test("overlapping bodies can each match a different cap",()=>{
 const r=fuseBottles([cap(40,20),cap(70,20)],[body(20,10,60,70),body(28,10,23,80)]);
 assert.equal(r.matched,2);assert.equal(r.added,0);assert.equal(r.detections.length,2);
});
test("duplicate tiled boxes do not add the same lying bottle twice",()=>{
 const r=fuseBottles([],[body(10,100,90,25),body(12,101,89,25,.8)]);
 assert.equal(r.added,1);assert.equal(r.detections[0].score,.9);
});
test("no AI candidates preserves all image-processing detections",()=>{
 const r=fuseBottles([cap(20,20),cap(60,20)],[]);
 assert.equal(r.detections.length,2);assert.equal(r.added,0);
});
