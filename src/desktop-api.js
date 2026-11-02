import {invoke} from "@tauri-apps/api/core";
import {setStoredRecordBytes} from "./storage-usage.js";

const requestChunkSize=64*1024,responseChunkSize=256*1024;
const databaseCollections=["degrees","semesters","subjects","syllabus","notes"];
const pendingRecordLoads=new Map();
export const isDesktopApp=()=>typeof window!=="undefined"&&"__TAURI_INTERNALS__" in window;

export async function openExternalUrl(url){
 if(typeof url!=="string"||!/^https?:\/\//i.test(url)||/[\u0000-\u0020]/.test(url))throw new Error("This PDF link is not a valid web address.");
 if(isDesktopApp()){
  await invoke("open_external_url",{url});
  return
 }
 window.open(url,"_blank","noopener,noreferrer")
}

export async function loadDesktopDatabase(){
 if(!isDesktopApp())throw new Error("Native SQLite access is only available in the desktop app.");
 const index=await invoke("desktop_database_index"),database=index?.database,recordBytes=index?.recordBytes;
 if(!database||typeof database!=="object"||!recordBytes||typeof recordBytes!=="object")throw new Error("The local database returned an invalid index.");
 for(const collection of databaseCollections){
  if(!Array.isArray(database[collection])||database[collection].some(record=>!record||typeof record.id!=="string"||!record.id)){
   throw new Error(`The local ${collection} database index is invalid.`)
  }
  for(const record of database[collection]){
   const bytes=recordBytes[collection]?.[record.id];
   if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error(`The local ${collection} database returned an invalid record size.`);
   setStoredRecordBytes(record,bytes)
  }
 }
 return database
}

export async function loadDesktopRecord(collection,id){
 if(!isDesktopApp())throw new Error("Native SQLite access is only available in the desktop app.");
 if(!databaseCollections.includes(collection)||typeof id!=="string"||!id)throw new Error("The requested local database record is invalid.");
 const cacheKey=`${collection}:${id}`;
 if(pendingRecordLoads.has(cacheKey))return pendingRecordLoads.get(cacheKey);
 const load=invoke("desktop_database_record",{collection,id}).then(record=>{
  if(!record||record.id!==id)throw new Error(`The requested ${collection} record is invalid.`);
  return record
 });
 pendingRecordLoads.set(cacheKey,load);
 try{return await load}finally{pendingRecordLoads.delete(cacheKey)}
}

export async function apiFetch(path,options={}){
 if(!isDesktopApp())return fetch(path,options);

 let body=null,bodyText=null;
 if(options.body!==undefined){
  bodyText=typeof options.body==="string"?options.body:JSON.stringify(options.body);
  if(bodyText.length<=requestChunkSize)try{body=JSON.parse(bodyText)}
  catch{throw new Error("The desktop app received an invalid local request.")}
 }

 const method=options.method||"GET";
 let result;
 if(bodyText!==null&&bodyText.length>requestChunkSize){
  const uploadId=crypto.randomUUID();
  for(let offset=0;offset<bodyText.length;){
   let end=Math.min(offset+requestChunkSize,bodyText.length);
   if(end<bodyText.length&&bodyText.charCodeAt(end-1)>=0xd800&&bodyText.charCodeAt(end-1)<=0xdbff)end--;
   const chunk=bodyText.slice(offset,end);
   result=await invoke("desktop_api_request_chunk",{
    uploadId,
    method,
    path,
    chunk,
    finalChunk:end===bodyText.length
   });
   offset=end;
  }
 }else{
  result=await invoke("desktop_api_request",{method,path,body});
 }
 if(typeof result!=="object"||result===null||typeof result.status!=="number"){
  if(typeof result?.chunkedResponseId==="string"){
   let responseText="",offset=0;
   while(true){
    const part=await invoke("desktop_api_response_chunk",{
     responseId:result.chunkedResponseId,
     offset,
     maxBytes:responseChunkSize
    });
    if(typeof part.chunk!=="string"||typeof part.nextOffset!=="number"||typeof part.complete!=="boolean"){
     throw new Error("The desktop storage service returned an invalid response chunk.")
    }
    responseText+=part.chunk;
    offset=part.nextOffset;
    if(part.complete)break;
   }
   try{result=JSON.parse(responseText)}
   catch{throw new Error("The desktop storage service returned an invalid response.")}
  }
 }
 if(typeof result!=="object"||result===null||typeof result.status!=="number"){
  throw new Error("The desktop storage service returned an invalid response.")
 }

 let responseBody;
 if(typeof result.bodyBase64==="string"){
  const binary=atob(result.bodyBase64);
  responseBody=Uint8Array.from(binary,character=>character.charCodeAt(0));
 }else{
  responseBody=new TextEncoder().encode(typeof result.body==="string"?result.body:"");
 }

 const status=result.status;
 return new Response(status===204||status===205||status===304?null:responseBody,{
  status,
  statusText:typeof result.statusText==="string"?result.statusText:undefined,
  headers:result.headers||{}
 });
}
