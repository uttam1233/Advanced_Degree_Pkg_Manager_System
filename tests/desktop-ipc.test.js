import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import Database from "better-sqlite3";
import test from "node:test";

const serverPath=fileURLToPath(new URL("../server.js",import.meta.url));

test("desktop storage worker reads and writes SQLite over stdio IPC",async context=>{
 const directory=mkdtempSync(join(tmpdir(),"degree-study-manager-ipc-"));
 const databasePath=join(directory,"test.sqlite");
 const child=spawn(process.execPath,[serverPath,"--desktop-ipc"],{
  env:{...process.env,DEGREE_STUDY_DB_PATH:databasePath},
  stdio:["pipe","pipe","pipe"]
 });
 const pending=new Map();
 let output="";
 let nextId=1;

 child.stdout.setEncoding("utf8");
 child.stdout.on("data",chunk=>{
  output+=chunk;
  let newline;
  while((newline=output.indexOf("\n"))>=0){
   const line=output.slice(0,newline);
   output=output.slice(newline+1);
   const response=JSON.parse(line);
   pending.get(response.requestId)?.(response);
   pending.delete(response.requestId);
  }
 });

 context.after(async()=>{
  if(child.exitCode===null){
   child.kill();
   await new Promise(resolve=>child.once("close",resolve));
  }
  rmSync(directory,{recursive:true,force:true});
 });

 function request(method,path,body){
  const requestId=nextId++;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{
    pending.delete(requestId);
    reject(new Error(`Desktop IPC request timed out: ${path}`));
   },5000);
   pending.set(requestId,response=>{clearTimeout(timeout);resolve(response)});
   child.stdin.write(`${JSON.stringify({requestId,method,path,body})}\n`);
  });
 }

 const empty=await request("GET","/api/database");
 assert.equal(empty.status,200);
 assert.deepEqual(JSON.parse(empty.body),{
  degrees:[],
  semesters:[],
  subjects:[],
  syllabus:[],
  notes:[]
 });

 const backup={
  degrees:[{id:"degree-1",name:"Local degree"}],
  semesters:[],
  subjects:[],
  syllabus:[],
  notes:[]
 };
 assert.equal((await request("PUT","/api/database",backup)).status,200);
 assert.equal((await request("POST","/api/changes",{
  upsert:{degrees:[{id:"degree-2",name:"IPC degree"}],semesters:[],subjects:[],syllabus:[],notes:[{id:"note-1",type:"image",title:"Large image",dataUrl:"data:image/png;base64,abc"}]},
  delete:{degrees:[],semesters:[],subjects:[],syllabus:[],notes:[]}
 })).status,200);

 const saved=await request("GET","/api/database");
 assert.deepEqual(JSON.parse(saved.body).degrees,[
  {id:"degree-1",name:"Local degree"},
  {id:"degree-2",name:"IPC degree"}
 ]);
 assert.equal(JSON.parse(saved.body).notes[0].dataUrl,"data:image/png;base64,abc");

 const reader=new Database(databasePath,{readonly:true});
 try{
  const summary=reader.prepare("SELECT payload, payload_bytes FROM record_summaries WHERE collection = ? AND id = ?").get("notes","note-1");
  assert.deepEqual(JSON.parse(summary.payload),{id:"note-1",type:"image",title:"Large image"});
  assert.equal(summary.payload_bytes,Buffer.byteLength(JSON.stringify(JSON.parse(saved.body).notes[0])));
 }finally{
  reader.close();
 }
});
