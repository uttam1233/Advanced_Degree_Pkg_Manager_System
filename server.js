import {createServer} from "node:http";
import {spawn, spawnSync} from "node:child_process";
import {createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {delimiter, dirname, extname, join, normalize, resolve, sep} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import Database from "better-sqlite3";

const root=dirname(fileURLToPath(import.meta.url));
const dataDirectory=process.env.LOCALAPPDATA||process.env.XDG_DATA_HOME||join(process.env.HOME||root,".local","share");
const databasePath=resolve(process.env.DEGREE_STUDY_DB_PATH||join(dataDirectory,"DegreeStudyManager","degree-study-manager.sqlite"));
const port=Number(process.env.API_PORT||3001);
const collections=["degrees","semesters","subjects","syllabus","notes"];
const maxRequestBytes=150*1024*1024;
const practiceDirectory=join(dataDirectory,"DegreeStudyManager","practice");
const practiceSessions=new Map();
const practiceJobs=new Map();
const notebookKernels=new Map();
const maxPracticeOutput=1024*1024;
const maxNotebookUploadBytes=25*1024*1024;
const jupyterBridgePath=resolve(root,"jupyter-bridge.py");
let jupyterRuntimeCache=null;

mkdirSync(dirname(databasePath),{recursive:true});
const database=new Database(databasePath);
database.pragma("journal_mode = WAL");
database.pragma("synchronous = FULL");
database.exec("CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (collection, id)) WITHOUT ROWID");
const getRecords=database.prepare("SELECT collection, payload FROM records ORDER BY collection, id");
const upsertRecord=database.prepare("INSERT INTO records (collection, id, payload) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET payload = excluded.payload");
const deleteRecord=database.prepare("DELETE FROM records WHERE collection = ? AND id = ?");
const clearRecords=database.prepare("DELETE FROM records");
const replaceAll=database.transaction(data=>{
 clearRecords.run();
 for(const collection of collections)for(const record of data[collection])upsertRecord.run(collection,record.id,JSON.stringify(record));
});
const applyChanges=database.transaction(changes=>{
 for(const collection of collections){
  for(const id of changes.delete[collection])deleteRecord.run(collection,id);
  for(const record of changes.upsert[collection])upsertRecord.run(collection,record.id,JSON.stringify(record));
 }
});

function sendJson(response,status,data){response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});response.end(JSON.stringify(data))}
function readJson(request){return new Promise((resolveBody,reject)=>{
 let size=0,body="";
 request.on("data",chunk=>{size+=chunk.length;if(size>maxRequestBytes){reject(Object.assign(new Error("Request is too large."),{status:413}));request.destroy();return}body+=chunk.toString("utf8")});
 request.on("end",()=>{try{resolveBody(JSON.parse(body||"{}"))}catch{reject(Object.assign(new Error("Request body must contain valid JSON."),{status:400}))}});
 request.on("error",reject);
})}
function validateDatabase(data){return data&&typeof data==="object"&&collections.every(collection=>Array.isArray(data[collection])&&data[collection].every(record=>record&&typeof record==="object"&&typeof record.id==="string"&&record.id.length>0))}
function validateChanges(changes){return changes&&typeof changes==="object"&&changes.upsert&&changes.delete&&collections.every(collection=>Array.isArray(changes.upsert[collection])&&changes.upsert[collection].every(record=>record&&typeof record==="object"&&typeof record.id==="string"&&record.id.length>0)&&Array.isArray(changes.delete[collection])&&changes.delete[collection].every(id=>typeof id==="string"&&id.length>0))}
function readDatabase(){const data=Object.fromEntries(collections.map(collection=>[collection,[]]));for(const row of getRecords.all())data[row.collection].push(JSON.parse(row.payload));return data}
function isLocalOrigin(request){const origin=request.headers.origin;if(!origin)return true;try{return["localhost","127.0.0.1","[::1]"].includes(new URL(origin).hostname)}catch{return false}}
function getPracticeSession(id){if(typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw Object.assign(new Error("The practice session id is invalid."),{status:400});let session=practiceSessions.get(id);if(!session){const directory=join(practiceDirectory,id);mkdirSync(directory,{recursive:true});session={directory,cwd:directory};practiceSessions.set(id,session)}return session}
function quotePowerShell(value){return`'${value.replace(/'/g,"''")}'`}
function isValidPracticeFileName(fileName){return typeof fileName==="string"&&fileName.length>0&&fileName.length<=255&&!/[<>:"/\\|?*\u0000-\u001f]/.test(fileName)&&fileName!=="."&&fileName!==".."&&!!extname(fileName)}
function isValidNotebookUploadName(fileName){return typeof fileName==="string"&&fileName.length>0&&fileName.length<=180&&!/[<>:"/\\|?*\u0000-\u001f]/.test(fileName)&&fileName!=="."&&fileName!==".."&&!/[. ]$/.test(fileName)&&!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)}
function notebookUploadsPath(session){return join(session.directory,".notebook-uploads.json")}
function readNotebookUploadManifest(session){
 const manifestPath=notebookUploadsPath(session);
 let manifest=[];
 if(existsSync(manifestPath)){
  try{manifest=JSON.parse(readFileSync(manifestPath,"utf8"))}catch{throw Object.assign(new Error("The notebook upload list is unreadable. Check the notebook workspace before uploading or deleting files."),{status:500})}
  if(!Array.isArray(manifest)||manifest.some(file=>!file||!isValidNotebookUploadName(file.fileName)))throw Object.assign(new Error("The notebook upload list is invalid. Check the notebook workspace before uploading or deleting files."),{status:500})
 }
 return manifest
}
function readNotebookUploads(session){
 const manifest=readNotebookUploadManifest(session);
 const files=new Map(manifest.filter(file=>existsSync(join(session.directory,file.fileName))).map(file=>[file.fileName.toLowerCase(),{fileName:file.fileName,size:statSync(join(session.directory,file.fileName)).size}]));
 for(const name of readdirSync(session.directory)){
  if(name.toLowerCase().endsWith(".csv")&&!files.has(name.toLowerCase())){
   const filePath=join(session.directory,name);
   if(statSync(filePath).isFile())files.set(name.toLowerCase(),{fileName:name,size:statSync(filePath).size})
  }
 }
 return [...files.values()].sort((left,right)=>left.fileName.localeCompare(right.fileName,undefined,{sensitivity:"base"}))
}
function writeNotebookUploads(session,files){writeFileSync(notebookUploadsPath(session),JSON.stringify(files,null,2),{encoding:"utf8"})}
function savePracticeFile(session,fileName,code,previousFileName){
 const filePath=join(session.directory,fileName);
 try{writeFileSync(filePath,code,{encoding:"utf8"})}catch{return"Unable to save the practice file to the workspace."}
 if(previousFileName&&previousFileName!==fileName&&isValidPracticeFileName(previousFileName)){
  const previousPath=join(session.directory,previousFileName);
  try{if(existsSync(previousPath))unlinkSync(previousPath)}catch{return"Unable to remove the old renamed practice file from the workspace."}
 }
 return null
}
function discoverJupyterRuntime(){
 if(jupyterRuntimeCache)return jupyterRuntimeCache;
 const candidates=(process.env.PATH||"").split(delimiter).filter(Boolean).map(directory=>join(directory.replace(/^"|"$/g,""),"jupyter.exe"));
 const where=spawnSync("where.exe",["jupyter.exe"],{encoding:"utf8",windowsHide:true});
 if(!where.error&&where.status===0)candidates.push(...where.stdout.split(/\r?\n/).filter(Boolean));
 const jupyterPath=candidates.find(existsSync);
 if(!jupyterPath)throw Object.assign(new Error("Jupyter is not installed or not available on PATH. Install Jupyter in an environment that can discover your kernels."),{status:503});
 const directories=[resolve(dirname(jupyterPath),".."),dirname(jupyterPath)];
 const pythonPath=directories.map(directory=>join(directory,"python.exe")).find(existsSync);
 if(!pythonPath)throw Object.assign(new Error(`Could not locate the Python environment that runs Jupyter next to ${jupyterPath}.`),{status:503});
 const result=spawnSync(pythonPath,[jupyterBridgePath,"--list"],{encoding:"utf8",windowsHide:true,timeout:30000});
 if(result.error||result.status!==0)throw Object.assign(new Error(`Unable to query installed Jupyter kernels: ${(result.stderr||result.error?.message||"Jupyter kernel discovery failed.").trim()}`),{status:503});
 let response;
 try{response=JSON.parse(result.stdout)}catch{throw Object.assign(new Error("Jupyter returned an invalid kernel list."),{status:503})}
 if(!Array.isArray(response.kernels))throw Object.assign(new Error("Jupyter did not return a kernel list."),{status:503});
 jupyterRuntimeCache={pythonPath,kernels:response.kernels};
 return jupyterRuntimeCache
}
function notebookKey(sessionId,notebookId){return`${sessionId}:${notebookId}`}
function validateNotebookIds(body){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
 if(typeof body.sessionId!=="string"||!uuid.test(body.sessionId)||typeof body.notebookId!=="string"||!uuid.test(body.notebookId))throw Object.assign(new Error("The notebook session id is invalid."),{status:400})
}
function stopNotebookKernel(key,expectedOwnerId){
 const bridge=notebookKernels.get(key);
 if(!bridge||(expectedOwnerId&&bridge.ownerId!==expectedOwnerId))return;
 notebookKernels.delete(key);
 if(bridge.child.stdin.writable)bridge.child.stdin.write(`${JSON.stringify({action:"shutdown"})}\n`);
 setTimeout(()=>{if(!bridge.child.killed)bridge.child.kill()},3000).unref()
}
function startNotebookKernel(sessionId,notebookId,kernelName,ownerId){
 const key=notebookKey(sessionId,notebookId),runtime=discoverJupyterRuntime();
 if(!runtime.kernels.some(kernel=>kernel.name===kernelName))throw Object.assign(new Error("That Jupyter kernel is not installed or is no longer available."),{status:400});
 const existing=notebookKernels.get(key);
 if(existing?.kernelName===kernelName&&existing.ownerId===ownerId&&existing.ready)return Promise.resolve(existing);
 if(existing)stopNotebookKernel(key);
 const workspace=getPracticeSession(sessionId),child=spawn(runtime.pythonPath,["-u",jupyterBridgePath,kernelName,workspace.directory],{cwd:workspace.directory,windowsHide:true,stdio:["pipe","pipe","pipe"]});
 const bridge={child,kernelName,ownerId,ready:false,buffer:"",stderr:"",jobs:new Map()};
 notebookKernels.set(key,bridge);
 return new Promise((resolveReady,rejectReady)=>{
  const startupTimer=setTimeout(()=>{stopNotebookKernel(key,ownerId);rejectReady(Object.assign(new Error(`The selected Jupyter kernel did not start within 90 seconds.${bridge.stderr?`\n${bridge.stderr.trim()}`:""}`),{status:504}))},90000);
  const fail=message=>{clearTimeout(startupTimer);if(notebookKernels.get(key)===bridge)notebookKernels.delete(key);child.kill();rejectReady(Object.assign(new Error(`${message}${bridge.stderr?`\n${bridge.stderr.trim()}`:""}`),{status:503}))};
  child.stdout.setEncoding("utf8");
  child.stdout.on("data",chunk=>{
   bridge.buffer+=chunk;
   let newline;
   while((newline=bridge.buffer.indexOf("\n"))>=0){
    const line=bridge.buffer.slice(0,newline);bridge.buffer=bridge.buffer.slice(newline+1);
    let event;try{event=JSON.parse(line)}catch{fail(`The Jupyter bridge returned invalid output: ${line.slice(0,300)}`);return}
    if(event.event==="ready"&&!bridge.ready){bridge.ready=true;clearTimeout(startupTimer);resolveReady(bridge);continue}
    if(event.event==="error"&&!bridge.ready){fail(event.message||"The selected Jupyter kernel could not start.");continue}
    const job=bridge.jobs.get(event.requestId);
    if(!job)continue;
    if(event.event==="output")job.outputs.push(event.output);
    else if(event.event==="input_request")job.inputRequest=event.prompt;
    else if(event.event==="input_sent")job.inputRequest=null;
    else if(event.event==="execution_finished"){job.done=true;job.ok=event.ok;job.executionCount=event.executionCount}
    else if(event.event==="request_error"){job.error=event.message;job.done=true;job.ok=false}
   }
  });
  child.stderr.on("data",chunk=>{bridge.stderr=(bridge.stderr+chunk.toString("utf8")).slice(-5000)});
  child.once("error",error=>{if(!bridge.ready)fail(`Unable to start the Jupyter bridge: ${error.message}`)});
  child.once("close",code=>{if(!bridge.ready)fail(`The Jupyter bridge exited before the kernel was ready (exit ${code??"unknown"}).`);else{bridge.ready=false;if(notebookKernels.get(key)===bridge)notebookKernels.delete(key);for(const job of bridge.jobs.values()){if(!job.done){job.done=true;job.ok=false;job.error="The Jupyter kernel stopped unexpectedly."}}}});
 })
}
function buildProgramCommand(filePath,extension){const file=quotePowerShell(filePath),getRunner=(names,label)=>`$runner=Get-Command -Name @(${names.map(quotePowerShell).join(",")}) -ErrorAction SilentlyContinue | Select-Object -First 1; if(-not $runner){throw ${quotePowerShell(`No ${label} runtime was found on PATH.`)}}; `,run=(names,label,args=[])=>`${getRunner(names,label)}& $runner.Source ${args.map(quotePowerShell).join(" ")} ${file}`,ext=extension.toLowerCase();
 if([".py",".pyw"].includes(ext))return`${getRunner(["python","python3","py"],"Python")}if($runner.Name -ieq 'py'){& $runner.Source -3 ${file}}else{& $runner.Source ${file}}`;
 if([".js",".cjs",".mjs"].includes(ext))return run(["node"],"Node.js");
 if([".ts",".tsx",".mts",".cts"].includes(ext))return run(["tsx","ts-node"],"TypeScript (install tsx or ts-node)");
 if(ext===".java")return run(["java"],"Java");
 if([".go"].includes(ext))return run(["go"],"Go",["run"]);
 if(ext===".rb")return run(["ruby"],"Ruby");
 if(ext===".php")return run(["php"],"PHP");
 if(ext===".r")return run(["Rscript"],"R");
 if(ext===".lua")return run(["lua"],"Lua");
 if(ext===".dart")return run(["dart"],"Dart",["run"]);
 if(ext===".swift")return run(["swift"],"Swift");
 if(ext===".scala")return run(["scala"],"Scala");
 if(ext===".pl")return run(["perl"],"Perl");
 if([".ex",".exs"].includes(ext))return run(["elixir"],"Elixir");
 if([".hs",".lhs"].includes(ext))return run(["runghc","runhaskell"],"Haskell");
 if([".ps1",".psm1"].includes(ext))return`& ${file}`;
 if([".bat",".cmd"].includes(ext))return`& $env:ComSpec /d /c ${file}`;
 if([".sh",".bash"].includes(ext))return run(["bash"],"Bash");
 if([".c",".cpp",".cc",".cxx"].includes(ext)){const output=quotePowerShell(join(dirname(filePath),`${randomUUID()}.exe`));return`${getRunner(["gcc","clang","cl"],"a C/C++ compiler (gcc, clang, or Visual C++)")}if($runner.Name -ieq 'cl'){& $runner.Source /nologo ${file} ('/Fe:'+${output})}else{& $runner.Source ${file} '-o' ${output}}; if($LASTEXITCODE -eq 0){& ${output}}`}
 if(ext===".rs"){const output=quotePowerShell(join(dirname(filePath),`${randomUUID()}.exe`));return`${getRunner(["rustc"],"Rust compiler (rustc)")} & $runner.Source ${file} '-o' ${output}; if($LASTEXITCODE -eq 0){& ${output}}`}
 if(ext===".kt"){const output=quotePowerShell(join(dirname(filePath),`${randomUUID()}.jar`));return`${getRunner(["kotlinc"],"Kotlin compiler (kotlinc)")} & $runner.Source ${file} '-include-runtime' '-d' ${output}; if($LASTEXITCODE -eq 0){$runner=Get-Command -Name 'java' -ErrorAction SilentlyContinue; if(-not $runner){throw 'Java runtime was not found on PATH.'}; & $runner.Source '-jar' ${output}}`}
 if(ext===".cs")return run(["dotnet-script"],"dotnet-script (.NET script runner)");
 return null
}
function runPracticeProcess(command,session){return new Promise((resolveRun,rejectRun)=>{
 const executable=join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
 let output="",overflow=false,timedOut=false,settled=false;
 const cwd=session.cwd;
 const child=spawn(executable,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",`Set-Location -LiteralPath '${cwd.replace(/'/g,"''")}'; $ErrorActionPreference = 'Continue'; $Error.Clear(); ${command}\n$__practiceCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($Error.Count -gt 0) { 1 } else { 0 }; Write-Output ('__PRACTICE_CWD__' + (Get-Location).Path); exit $__practiceCode`],{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});
 const append=chunk=>{if(output.length<maxPracticeOutput)output+=chunk.toString("utf8").slice(0,maxPracticeOutput-output.length);else overflow=true};
 child.stdout.on("data",append);child.stderr.on("data",append);
 const timer=setTimeout(()=>{if(settled)return;timedOut=true;child.kill();},30000);
 child.once("error",error=>{if(settled)return;settled=true;clearTimeout(timer);rejectRun(Object.assign(new Error(`Unable to start PowerShell: ${error.message}`),{status:500}))});
 child.once("close",(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);const marker=/__PRACTICE_CWD__(.*)\r?\n?$/.exec(output),nextCwd=marker?.[1]?.trim();if(marker)output=output.slice(0,marker.index);if(nextCwd)session.cwd=resolve(nextCwd);resolveRun({output:output.trimEnd(),exitCode:code??(signal?1:0),timedOut,truncated:overflow})});
 })}
function startPracticeProcess(command,session,sessionId){
 const executable=join(process.env.SystemRoot||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
 const cwd=session.cwd,id=randomUUID();
 const child=spawn(executable,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",`Set-Location -LiteralPath '${cwd.replace(/'/g,"''")}'; $ErrorActionPreference = 'Continue'; $Error.Clear(); ${command}\n$__practiceCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($Error.Count -gt 0) { 1 } else { 0 }; Write-Output ('__PRACTICE_CWD__' + (Get-Location).Path); exit $__practiceCode`],{cwd,windowsHide:true,stdio:["pipe","pipe","pipe"]});
 const job={id,sessionId,child,output:"",cursor:0,done:false,exitCode:null,timedOut:false,truncated:false};
 practiceJobs.set(id,job);session.activeJobId=id;
 const append=chunk=>{const text=chunk.toString("utf8");if(job.output.length<maxPracticeOutput)job.output+=text.slice(0,maxPracticeOutput-job.output.length);else job.truncated=true};
 child.stdout.on("data",append);child.stderr.on("data",append);
 const timer=setTimeout(()=>{if(job.done)return;job.timedOut=true;child.kill()},30000);
 child.once("error",error=>{clearTimeout(timer);job.done=true;job.exitCode=1;job.output+=`\nUnable to start PowerShell: ${error.message}`;session.activeJobId=null});
 child.once("close",(code,signal)=>{clearTimeout(timer);const marker=/__PRACTICE_CWD__(.*)\r?\n?$/.exec(job.output),nextCwd=marker?.[1]?.trim();if(marker)job.output=job.output.slice(0,marker.index);if(nextCwd)session.cwd=resolve(nextCwd);job.exitCode=code??(signal?1:0);job.done=true;if(session.activeJobId===id)session.activeJobId=null;setTimeout(()=>practiceJobs.delete(id),60000).unref()});
 return job
}
function readPracticeJob(job){const output=job.output.slice(job.cursor);job.cursor=job.output.length;return{ok:job.done&&job.exitCode===0,output,done:job.done,exitCode:job.exitCode,timedOut:job.timedOut,truncated:job.truncated}}
function serveStatic(pathname,response){
 const distPath=resolve(root,"dist");
 const relativePath=decodeURIComponent(pathname).replace(/^\/+/,"")||"index.html";
 const filePath=normalize(resolve(distPath,relativePath));
 if(filePath!==distPath&&!filePath.startsWith(distPath+sep)){response.writeHead(403);response.end("Forbidden");return}
 let file=filePath;
 try{if(statSync(file).isDirectory())file=join(file,"index.html");statSync(file)}catch{file=join(distPath,"index.html")}
 const types={".css":"text/css; charset=utf-8",".html":"text/html; charset=utf-8",".ico":"image/x-icon",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".png":"image/png",".svg":"image/svg+xml",".webp":"image/webp"};
 response.writeHead(200,{"Content-Type":types[extname(file)]||"application/octet-stream"});
 createReadStream(file).pipe(response);
}

createServer(async(request,response)=>{
 try{
  const url=new URL(request.url,"http://localhost");
  if(url.pathname==="/api/health"&&request.method==="GET")return sendJson(response,200,{ok:true});
  if(url.pathname==="/api/database"&&request.method==="GET")return sendJson(response,200,readDatabase());
  if(url.pathname==="/api/database"&&request.method==="PUT"){
   const data=await readJson(request);
   if(!validateDatabase(data))return sendJson(response,400,{error:"The database backup has an invalid format."});
   replaceAll(data);
   return sendJson(response,200,{ok:true});
  }
  if(url.pathname==="/api/changes"&&request.method==="POST"){
   const changes=await readJson(request);
   if(!validateChanges(changes))return sendJson(response,400,{error:"Database changes have an invalid format."});
   applyChanges(changes);
   return sendJson(response,200,{ok:true});
  }
  if(url.pathname==="/api/open-with"&&request.method==="POST"){
   if(process.platform!=="win32")return sendJson(response,501,{error:"Open with is available when running the app on Windows."});
   const {fileName,dataUrl}=await readJson(request);
   if(typeof fileName!=="string"||!fileName.trim()||fileName.length>255||typeof dataUrl!=="string")return sendJson(response,400,{error:"The file details are invalid."});
   const match=dataUrl.match(/^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/);
   if(!match||match[1].length%4!==0||match[1].length>Math.ceil(100*1024*1024/3)*4)return sendJson(response,400,{error:"The file data is invalid or exceeds 100 MB."});
   const content=Buffer.from(match[1],"base64");
   if(content.length>100*1024*1024)return sendJson(response,400,{error:"The file exceeds 100 MB."});
   const safeName=fileName.replace(/[<>:"/\\|?*\u0000-\u001f]/g,"_").replace(/[. ]+$/,"").slice(0,180)||"uploaded-file";
   const directory=join(tmpdir(),"DegreeStudyManager","open-with",randomUUID());
   const filePath=join(directory,safeName);
   try{mkdirSync(directory,{recursive:true});writeFileSync(filePath,content,{flag:"wx"})}
   catch{return sendJson(response,500,{error:"Unable to prepare a temporary copy of this file."})}
   await new Promise((resolveSpawn,rejectSpawn)=>{
    const rundll32Path=join(process.env.SystemRoot||"C:\\Windows","System32","rundll32.exe");
    const child=spawn(rundll32Path,["shell32.dll,OpenAs_RunDLL",filePath],{detached:true,stdio:"ignore",windowsHide:false});
    child.once("error",()=>rejectSpawn(Object.assign(new Error("Windows could not start the Open with dialog."),{status:500})));
    child.once("spawn",resolveSpawn);
    child.unref();
   });
   return sendJson(response,202,{ok:true});
  }
  if(url.pathname==="/api/notebook"&&request.method==="POST"){
   if(process.platform!=="win32")return sendJson(response,501,{error:"Local Jupyter notebooks are available when running the app on Windows."});
   if(!isLocalOrigin(request))return sendJson(response,403,{error:"Notebook kernels can only be controlled from a local app page."});
   const body=await readJson(request);
   if(body.action==="kernels"){
    const runtime=discoverJupyterRuntime();
    return sendJson(response,200,{ok:true,notebookApiVersion:3,kernels:runtime.kernels});
   }
   validateNotebookIds(body);
   const key=notebookKey(body.sessionId,body.notebookId);
   if(body.action==="list-files"){
    const session=getPracticeSession(body.sessionId);
    return sendJson(response,200,{ok:true,files:readNotebookUploads(session)});
   }
   if(body.action==="start"){
    if(typeof body.kernelName!=="string"||!body.kernelName)return sendJson(response,400,{error:"Select an installed Jupyter kernel."});
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if(typeof body.ownerId!=="string"||!uuid.test(body.ownerId))return sendJson(response,400,{error:"The notebook kernel owner id is invalid."});
    const bridge=await startNotebookKernel(body.sessionId,body.notebookId,body.kernelName,body.ownerId);
    return sendJson(response,200,{ok:true,kernelName:bridge.kernelName,cwd:getPracticeSession(body.sessionId).cwd});
   }
   if(body.action==="delete-file"){
    if(!isValidNotebookUploadName(body.fileName))return sendJson(response,400,{error:"Choose a valid uploaded filename."});
    const session=getPracticeSession(body.sessionId),manifest=readNotebookUploadManifest(session),files=readNotebookUploads(session);
    const file=files.find(item=>item.fileName===body.fileName);
    if(!file)return sendJson(response,404,{error:"That uploaded file is no longer available."});
    const filePath=join(session.directory,file.fileName);
    try{unlinkSync(filePath)}
    catch{return sendJson(response,500,{error:`Unable to delete ${file.fileName} from the notebook workspace.`})}
    try{writeNotebookUploads(session,manifest.filter(item=>item.fileName!==file.fileName))}
    catch{return sendJson(response,500,{error:`Deleted ${file.fileName}, but could not update the notebook upload list.`})}
    return sendJson(response,200,{ok:true,files:readNotebookUploads(session)});
   }
   if(body.action==="stop"){
    stopNotebookKernel(key,body.ownerId);
    return sendJson(response,200,{ok:true});
   }
   const bridge=notebookKernels.get(key);
   if(!bridge?.ready)return sendJson(response,409,{error:"Start a Jupyter kernel before running notebook cells."});
   if(body.action==="upload-file"){
    if(!isValidNotebookUploadName(body.fileName)||body.fileName!==body.fileName.trim())return sendJson(response,400,{error:"Choose a valid filename."});
    if(typeof body.dataUrl!=="string")return sendJson(response,400,{error:"File data is missing."});
    const match=body.dataUrl.match(/^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/);
    if(!match||match[1].length%4!==0||match[1].length>Math.ceil(maxNotebookUploadBytes/3)*4)return sendJson(response,400,{error:"File data is invalid or exceeds 25 MB."});
    const content=Buffer.from(match[1],"base64");
    if(content.length>maxNotebookUploadBytes)return sendJson(response,400,{error:"Files must be 25 MB or smaller."});
    const session=getPracticeSession(body.sessionId);
    if(readdirSync(session.directory).some(name=>name.toLowerCase()===body.fileName.toLowerCase()))return sendJson(response,409,{error:`A file named "${body.fileName}" already exists in this notebook workspace. Duplicate upload rejected.`});
    const files=readNotebookUploads(session),filePath=join(session.directory,body.fileName),nextFiles=[...files,{fileName:body.fileName,size:content.length}];
    try{writeFileSync(filePath,content,{flag:"wx"})}
    catch{return sendJson(response,500,{error:`Unable to save ${body.fileName} to the notebook workspace.`})}
    try{writeNotebookUploads(session,nextFiles)}
    catch{
     try{unlinkSync(filePath)}
     catch{return sendJson(response,500,{error:`Unable to register ${body.fileName} or remove the unregistered file from the workspace.`})}
     return sendJson(response,500,{error:`Unable to register ${body.fileName}; the saved file was removed.`})
    }
    return sendJson(response,201,{ok:true,fileName:body.fileName,files:readNotebookUploads(session)});
   }
   if(body.action==="execute"){
    if(typeof body.code!=="string"||body.code.length>2*1024*1024)return sendJson(response,400,{error:"Notebook cells must be 2 MB or smaller."});
    if([...bridge.jobs.values()].some(job=>!job.done))return sendJson(response,409,{error:"A notebook cell is already running in this kernel."});
    const job={id:randomUUID(),outputs:[],done:false,ok:false,executionCount:null,inputRequest:null,error:null};
    bridge.jobs.set(job.id,job);
    bridge.child.stdin.write(`${JSON.stringify({action:"execute",requestId:job.id,code:body.code})}\n`);
    return sendJson(response,202,{ok:true,jobId:job.id});
   }
   if(body.action==="poll"||body.action==="input"){
    const job=bridge.jobs.get(body.jobId);
    if(!job)return sendJson(response,404,{error:"This notebook execution is no longer available."});
    if(body.action==="input"){
     if(job.done||!job.inputRequest)return sendJson(response,409,{error:"The running cell is not waiting for input."});
     if(typeof body.value!=="string"||body.value.length>10000)return sendJson(response,400,{error:"Notebook input must be 10,000 characters or less."});
     bridge.child.stdin.write(`${JSON.stringify({action:"input",requestId:job.id,value:body.value})}\n`);
     job.outputs.push({type:"input",text:body.value});
     job.inputRequest=null;
     return sendJson(response,200,{ok:true});
    }
    const cursor=Number.isInteger(body.cursor)&&body.cursor>=0?body.cursor:0;
    const outputs=job.outputs.slice(cursor);
    return sendJson(response,200,{ok:true,outputs,nextCursor:cursor+outputs.length,done:job.done,success:job.ok,executionCount:job.executionCount,inputRequest:job.inputRequest,error:job.error});
   }
   return sendJson(response,400,{error:"Choose a valid notebook action."});
  }
  if(url.pathname==="/api/practice"&&request.method==="POST"){
   if(process.platform!=="win32")return sendJson(response,501,{error:"The local PowerShell practice terminal is available only on Windows."});
   if(!isLocalOrigin(request))return sendJson(response,403,{error:"Practice commands can only be run from a local app page."});
   const body=await readJson(request),session=getPracticeSession(body.sessionId);
   if(body.action==="init")return sendJson(response,200,{ok:true,cwd:session.cwd,practiceApiVersion:4});
   if(body.action==="save"){
    if(!isValidPracticeFileName(body.fileName))return sendJson(response,400,{error:"Enter a valid program filename with an extension."});
    if(typeof body.code!=="string"||body.code.length>2*1024*1024)return sendJson(response,400,{error:"Practice code must be 2 MB or smaller."});
    if(body.previousFileName!==undefined&&!isValidPracticeFileName(body.previousFileName))return sendJson(response,400,{error:"The previous practice filename is invalid."});
    const error=savePracticeFile(session,body.fileName,body.code,body.previousFileName);
    if(error)return sendJson(response,500,{error});
    return sendJson(response,200,{ok:true,cwd:session.cwd,fileName:body.fileName});
   }
   if(body.action==="poll"||body.action==="input"){
    const job=practiceJobs.get(body.jobId);
    if(!job||job.sessionId!==body.sessionId)return sendJson(response,404,{error:"The running program is no longer available."});
    if(body.action==="input"){
     if(job.done)return sendJson(response,409,{error:"The program has already finished."});
     if(typeof body.input!=="string"||body.input.length>10000)return sendJson(response,400,{error:"Program input must be 10,000 characters or less."});
     try{job.child.stdin.write(`${body.input}\n`)}catch{return sendJson(response,409,{error:"The program is no longer accepting input."})}
     return sendJson(response,200,{ok:true});
    }
    const result=readPracticeJob(job);
    if(result.done&&result.timedOut)result.output+="\n[Program timed out after 30 seconds.]";
    if(result.done&&result.truncated)result.output+="\n[Output truncated after 1 MB.]";
    return sendJson(response,200,{...result,cwd:session.cwd});
   }
   let command;
   if(body.action==="run"){
    if(typeof body.code!=="string"||body.code.length>2*1024*1024)return sendJson(response,400,{error:"Practice code must be 2 MB or smaller."});
    if(!isValidPracticeFileName(body.fileName))return sendJson(response,400,{error:"Enter a valid program filename with an extension."});
    const scriptPath=join(session.directory,body.fileName),saveError=savePracticeFile(session,body.fileName,body.code,body.previousFileName),commandForFile=buildProgramCommand(scriptPath,extname(body.fileName));
    if(saveError)return sendJson(response,500,{error:saveError});
    if(!commandForFile)return sendJson(response,400,{error:`No run configuration is available for ${extname(body.fileName)} files.`});
    if(session.activeJobId&&practiceJobs.get(session.activeJobId)&&!practiceJobs.get(session.activeJobId).done)return sendJson(response,409,{error:"A program is already running in this syllabus workspace."});
    const job=startPracticeProcess(commandForFile,session,body.sessionId);
    return sendJson(response,202,{ok:true,jobId:job.id,cwd:session.cwd});
   }else if(body.action==="command"){
    if(typeof body.command!=="string"||!body.command.trim()||body.command.length>10000)return sendJson(response,400,{error:"Enter a command of 1 to 10,000 characters."});
    command=body.command;
   }else return sendJson(response,400,{error:"Choose a valid practice action."});
   const result=await runPracticeProcess(command,session);
   if(result.timedOut)result.output+="\n[Command timed out after 30 seconds.]";
   if(result.truncated)result.output+="\n[Output truncated after 1 MB.]";
   return sendJson(response,200,{ok:result.exitCode===0,output:result.output,cwd:session.cwd,exitCode:result.exitCode});
  }
  if(url.pathname.startsWith("/api/"))return sendJson(response,404,{error:"API endpoint not found."});
  if(request.method!=="GET"&&request.method!=="HEAD"){response.writeHead(405);response.end("Method not allowed");return}
  serveStatic(url.pathname,response);
 }catch(error){
  if(!response.headersSent)sendJson(response,error.status||500,{error:error.status?error.message:"Unable to save or read the local SQLite database."});
  else response.destroy(error);
 }
}).listen(port,"127.0.0.1",()=>console.log(`Degree Study Manager is available at http://127.0.0.1:${port}\nSQLite database: ${databasePath}`));
