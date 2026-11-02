import assert from "node:assert/strict";
import test from "node:test";
import {CellHeightIndex} from "../src/notebook-virtualization.js";

test("indexes variable-height cells and maps scroll offsets to visible cells",()=>{
 const heights=[100,200,50,150];
 const index=new CellHeightIndex(heights);
 assert.equal(index.total,500);
 assert.equal(index.prefix(0),0);
 assert.equal(index.prefix(2),300);
 assert.equal(index.indexAt(0),0);
 assert.equal(index.indexAt(99),0);
 assert.equal(index.indexAt(100),1);
 assert.equal(index.indexAt(299),1);
 assert.equal(index.indexAt(300),2);
 assert.equal(index.indexAt(499),3);
 assert.equal(index.indexAt(500),3);
});

test("updates measured cell heights without rebuilding the index",()=>{
 const index=new CellHeightIndex([100,100,100]);
 assert.equal(index.update(1,250),true);
 assert.equal(index.total,450);
 assert.equal(index.prefix(2),350);
 assert.equal(index.indexAt(200),1);
 assert.equal(index.update(1,250),false);
 assert.equal(index.update(9,120),false);
});

test("handles empty notebooks and invalid measurements",()=>{
 const index=new CellHeightIndex([]);
 assert.equal(index.total,0);
 assert.equal(index.indexAt(0),-1);
 assert.equal(index.update(0,100),false);
 assert.equal(index.update(undefined,100),false);
});

test("keeps offset lookup efficient and correct for a very large notebook",()=>{
 const heights=Array.from({length:50_000},(_,index)=>40+index%7);
 const index=new CellHeightIndex(heights);
 for(let cellIndex=0;cellIndex<heights.length;cellIndex+=997){
  const top=index.prefix(cellIndex);
  assert.equal(index.indexAt(top),cellIndex);
 }
 assert.equal(index.total,heights.reduce((total,height)=>total+height,0));
});
