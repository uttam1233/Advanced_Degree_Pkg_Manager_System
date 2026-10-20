import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {Code2,Download,Eye,FileUp,Pencil,Play,Plus,Save,Trash2,X} from "lucide-react";
import "./jupyter-notebook.css";

const newCell=(cellType="code")=>({id:crypto.randomUUID(),cell_type:cellType,source:"",outputs:[],execution_count:null});

function NotebookOutput({output}){
 if(output.type==="stream")return <pre className="jupyter-stream">{output.text}</pre>;
 if(output.type==="input")return <pre className="jupyter-input-echo">{output.text}</pre>;
 if(output.type==="error")return <pre className="jupyter-error">{[output.ename,output.evalue,...(output.traceback||[])].filter(Boolean).join("\n")}</pre>;
 const data=output.data||{},imageType=["image/png","image/jpeg","image/gif","image/webp"].find(type=>typeof data[type]==="string");
 if(imageType)return <img className="jupyter-output-image" src={`data:${imageType};base64,${data[imageType]}`} alt="Notebook output"/>;
 const plain=data["text/plain"];
 return plain?<pre className="jupyter-result">{Array.isArray(plain)?plain.join(""):plain}</pre>:null
}

function MarkdownCell({source}){
 return <div className="jupyter-markdown">{source.split(/\r?\n/).map((line,index)=>{
  const heading=line.match(/^(#{1,6})\s+(.+)$/);
  if(heading){const Tag=`h${heading[1].length}`;return <Tag key={index}>{heading[2]}</Tag>}
  if(/^\s*[-*+]\s+/.test(line))return <div className="jupyter-markdown-list" key={index}>• {line.replace(/^\s*[-*+]\s+/,"")}</div>;
  return <p key={index}>{line||"\u00a0"}</p>
 })}</div>
}

export default function JupyterNotebook({sessionId,subjectId,notebookId,notebook,onSave,close}){
 const[cells,setCells]=useState(()=>Array.isArray(notebook?.cells)&&notebook.cells.length?notebook.cells.map(cell=>({...cell,outputs:cell.outputs||[]})):[newCell()]);
 const[fileName,setFileName]=useState(notebook?.fileName||"Untitled.ipynb");
 const[kernels,setKernels]=useState([]);
 const[kernelName,setKernelName]=useState(notebook?.kernelName||"");
 const[kernelState,setKernelState]=useState("loading");
 const[kernelError,setKernelError]=useState("");
 const[activeCellId,setActiveCellId]=useState(null);
 const[activeInput,setActiveInput]=useState(null);
 const[inputValue,setInputValue]=useState("");
 const[kernelErrorMessage,setKernelErrorMessage]=useState("");
 const[fileNotice,setFileNotice]=useState("");
 const[uploadedFiles,setUploadedFiles]=useState([]);
 const[selectedFileName,setSelectedFileName]=useState("");
 const[uploadingFiles,setUploadingFiles]=useState(false);
 const[theme,setTheme]=useState("light");
 const[ownerId]=useState(()=>crypto.randomUUID());
 const generation=useRef(0);
 const activeInputRef=useRef(null);
 const cellTextareas=useRef(new Map());
 const fileInput=useRef(null);
 activeInputRef.current=activeInput;
 const cellSources=cells.map(cell=>`${cell.id}\u0000${cell.source}\u0000${cell.rendered}`).join("\u0000");

 useLayoutEffect(()=>{
  cells.forEach(cell=>{
   const textarea=cellTextareas.current.get(cell.id);
   if(textarea){textarea.style.height="auto";textarea.style.height=`${textarea.scrollHeight}px`}
  })
 },[cellSources]);

 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   try{
    const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"kernels"})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to list Jupyter kernels.");
    if(result.notebookApiVersion!==3)throw new Error("The notebook service is out of date. Close all Degree Study Manager windows and restart the app.");
    if(cancelled)return;
    setKernels(result.kernels);
    if(notebook?.kernelName&&result.kernels.some(kernel=>kernel.name===notebook.kernelName))setKernelName(notebook.kernelName);
    else{setKernelState("idle");if(notebook?.kernelName)setKernelError(`The saved kernel "${notebook.kernelName}" is not currently installed. Select another kernel.`)}
   }catch(error){if(!cancelled){setKernelState("unavailable");setKernelError(error instanceof Error?error.message:"Unable to discover Jupyter kernels.")}}
  })();
  return()=>{cancelled=true}
 },[]);

 async function refreshUploadedFiles(){
  const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Unable to list notebook files.");
  setUploadedFiles(result.files);
  setSelectedFileName(current=>result.files.some(file=>file.fileName===current)?current:(result.files[0]?.fileName||""));
 }

 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   try{
    const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to list notebook files.");
    if(!cancelled){setUploadedFiles(result.files);setSelectedFileName(result.files[0]?.fileName||"")}
   }catch(error){if(!cancelled)setKernelErrorMessage(error instanceof Error?error.message:"Unable to list notebook files.")}
  })();
  return()=>{cancelled=true}
 },[sessionId,notebookId]);

 useEffect(()=>{
  if(!kernelName||!kernels.length)return;
  let cancelled=false;
  const currentGeneration=++generation.current;
  setKernelState("starting");setKernelError("");
  (async()=>{
   try{
    const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"start",sessionId,notebookId,kernelName,ownerId})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to start the selected kernel.");
    if(cancelled)return;
    setKernelState("ready");setKernelErrorMessage("");
   }catch(error){if(!cancelled){setKernelState("error");setKernelError(error instanceof Error?error.message:"Unable to start the selected kernel.")}}
  })();
  return()=>{
   cancelled=true;
   if(generation.current===currentGeneration)generation.current++;
   fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"stop",sessionId,notebookId,ownerId})}).catch(()=>{});
  }
 },[kernelName,kernels,sessionId,notebookId,ownerId]);

 async function pollExecution(jobId,cellId){
  let cursor=0;
  try{
   while(true){
    await new Promise(resolve=>setTimeout(resolve,250));
    const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"poll",sessionId,notebookId,jobId,cursor})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to read notebook output.");
    cursor=result.nextCursor;
    if(result.outputs.length)setCells(current=>current.map(cell=>cell.id===cellId?{...cell,outputs:[...cell.outputs,...result.outputs]}:cell));
    if(result.inputRequest!==null&&result.inputRequest!==undefined)setActiveInput({jobId,cellId,prompt:result.inputRequest});
    if(result.done){
     setCells(current=>current.map(cell=>cell.id===cellId?{...cell,execution_count:result.executionCount}:cell));
     setCells(current=>{
      const index=current.findIndex(cell=>cell.id===cellId);
      if(index<0)return current;
      const next=current[index+1];
      if(next?.cell_type==="code"&&!next.source.trim())return current;
      return [...current.slice(0,index+1),newCell(),...current.slice(index+1)]
     });
     if(!result.success)setKernelErrorMessage(result.error||"The cell finished with an error.");
     setActiveInput(current=>current?.jobId===jobId?null:current);
     setActiveCellId(null);return
    }
   }
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Notebook execution failed.");setActiveCellId(null);setActiveInput(current=>current?.jobId===jobId?null:current)}
 }

 async function runCell(cell){
  if(kernelState!=="ready"||activeCellId)return;
  setActiveCellId(cell.id);setKernelErrorMessage("");setActiveInput(null);
  setCells(current=>current.map(item=>item.id===cell.id?{...item,outputs:[],execution_count:null}:item));
  try{
   const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"execute",sessionId,notebookId,code:cell.source})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to run notebook cell.");
   await pollExecution(result.jobId,cell.id);
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Notebook execution failed.");setActiveCellId(null)}
 }

 async function sendInput(event){
  event.preventDefault();
  const current=activeInputRef.current;
  if(!current)return;
  try{
   const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"input",sessionId,notebookId,jobId:current.jobId,value:inputValue})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to send input to the running kernel.");
   setInputValue("");setActiveInput(null);
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Unable to send input.")}
 }

 async function uploadFiles(event){
  const files=Array.from(event.target.files||[]);
  event.target.value="";
  if(!files.length)return;
  if(kernelState!=="ready"){setKernelErrorMessage("Start a Jupyter kernel before uploading files.");return}
  setUploadingFiles(true);setKernelErrorMessage("");setFileNotice("");
  try{
   const uploaded=[];
   for(const file of files){
    if(file.size>25*1024*1024)throw new Error(`${file.name} exceeds the 25 MB per-file upload limit.`);
    const dataUrl=await new Promise((resolve,reject)=>{
     const reader=new FileReader();
     reader.onload=()=>typeof reader.result==="string"?resolve(reader.result):reject(new Error(`Unable to read ${file.name}.`));
     reader.onerror=()=>reject(new Error(`Unable to read ${file.name}.`));
     reader.readAsDataURL(file)
    });
    const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"upload-file",sessionId,notebookId,fileName:file.name,dataUrl})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||`Unable to upload ${file.name}.`);
    uploaded.push(result.fileName)
   }
   const result=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
   const listing=await result.json();
   if(!result.ok)throw new Error(listing.error||"Files were uploaded, but the uploaded file list could not be refreshed.");
   setUploadedFiles(listing.files);
   setSelectedFileName(uploaded[uploaded.length-1]||"");
   setFileNotice(`Saved to notebook workspace: ${uploaded.join(", ")}`)
  }catch(error){
   let refreshError="";
   try{await refreshUploadedFiles()}catch(listError){refreshError=listError instanceof Error?` ${listError.message}`:" The file list could not be refreshed."}
   setKernelErrorMessage(`${error instanceof Error?error.message:"File upload failed."}${refreshError}`)
  }
  finally{setUploadingFiles(false)}
 }

 async function deleteUploadedFile(){
  if(!selectedFileName)return;
  if(!window.confirm(`Delete ${selectedFileName} from this notebook workspace?`))return;
  setKernelErrorMessage("");setFileNotice("");
  try{
   const response=await fetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete-file",sessionId,notebookId,fileName:selectedFileName})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||`Unable to delete ${selectedFileName}.`);
   setUploadedFiles(result.files);
   setSelectedFileName(result.files[0]?.fileName||"");
   setFileNotice(`Deleted ${selectedFileName} from the notebook workspace.`)
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Unable to delete uploaded file.")}
 }

 function saveNotebook(){
  const name=fileName.trim();
  if(!name||!name.toLowerCase().endsWith(".ipynb")){setKernelErrorMessage("Enter a notebook filename ending in .ipynb.");return}
  onSave({notebookId,sessionId,subjectId,title:name,fileName:name,cells,kernelName});
  setKernelErrorMessage("");
 }

 function downloadNotebook(){
  const output=(cell,executionCount)=>{
   if(cell.type==="stream")return{output_type:"stream",name:cell.name,text:cell.text};
   if(cell.type==="input")return{output_type:"stream",name:"stdin",text:cell.text};
   if(cell.type==="error")return{output_type:"error",ename:cell.ename,evalue:cell.evalue,traceback:cell.traceback||[]};
   if(cell.type==="execute_result")return{output_type:"execute_result",execution_count:cell.executionCount??executionCount??null,data:cell.data||{},metadata:cell.metadata||{}};
   if(cell.type==="display_data")return{output_type:"display_data",data:cell.data||{},metadata:cell.metadata||{}};
   return null
  };
  const notebookData={nbformat:4,nbformat_minor:5,metadata:{kernelspec:{name:kernelName||"",display_name:kernels.find(kernel=>kernel.name===kernelName)?.displayName||kernelName||"No kernel selected",language:kernels.find(kernel=>kernel.name===kernelName)?.language||"python"}},cells:cells.map(cell=>cell.cell_type==="code"?{id:cell.id,cell_type:"code",metadata:{},execution_count:cell.execution_count??null,source:cell.source,outputs:(cell.outputs||[]).map(item=>output(item,cell.execution_count)).filter(Boolean)}:{id:cell.id,cell_type:"markdown",metadata:{},source:cell.source})};
  const link=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(notebookData,null,2)],{type:"application/x-ipynb+json"}));
  link.href=url;link.download=fileName.trim().toLowerCase().endsWith(".ipynb")?fileName.trim():"Untitled.ipynb";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
 }

 function updateCell(cellId,updates){setCells(current=>current.map(cell=>cell.id===cellId?{...cell,...(updates.source===undefined?{}:{rendered:false}),...updates}:cell))}
 function renderMarkdown(cellId){setCells(current=>current.map(cell=>cell.id===cellId?{...cell,rendered:true}:cell))}
 function addCell(cellType="code",index=cells.length){setCells(current=>[...current.slice(0,index),newCell(cellType),...current.slice(index)]);}

 return <div className="jupyter-overlay"><section className="jupyter-window" data-theme={theme} role="dialog" aria-label="Jupyter notebook">
  <header className="jupyter-header"><div className="jupyter-heading"><div><h2>Jupyter notebook</h2><span>Stateful execution in a local installed kernel</span></div>{fileNotice&&<span className="jupyter-upload-status" role="status" aria-live="polite" title={`${fileNotice}. Uploaded files are available to the selected kernel; they are not embedded in the .ipynb file.`}>{fileNotice}</span>}</div><div className="jupyter-header-actions"><label className="jupyter-files-label">Workspace files <select aria-label="Uploaded notebook files" value={selectedFileName} onChange={event=>setSelectedFileName(event.target.value)} disabled={!uploadedFiles.length}><option value="">{uploadedFiles.length?"Select a file…":"No uploaded files"}</option>{uploadedFiles.map(file=><option key={file.fileName} value={file.fileName}>{file.fileName} ({(file.size/1024).toFixed(1)} KB)</option>)}</select></label><button type="button" className="jupyter-delete-file" onClick={deleteUploadedFile} disabled={!selectedFileName||uploadingFiles}><Trash2/>Delete</button><button type="button" className="jupyter-close" onClick={close}><X/>Close</button></div></header>
  <div className="jupyter-toolbar">
   <label className="jupyter-name">Notebook <input aria-label="Notebook filename" value={fileName} onChange={event=>setFileName(event.target.value)}/></label>
   <label className="jupyter-kernel">Kernel <select aria-label="Select Jupyter kernel" value={kernelName} onChange={event=>setKernelName(event.target.value)} disabled={kernelState==="loading"||!!activeCellId}><option value="">Select installed kernel…</option>{kernels.map(kernel=><option key={kernel.name} value={kernel.name}>{kernel.displayName} · {kernel.language}</option>)}</select></label>
   <label className="jupyter-theme">Theme <select aria-label="Notebook theme" value={theme} onChange={event=>setTheme(event.target.value)}><option value="light">Jupyter Light</option><option value="dark">Jupyter Dark</option><option value="solarized">Solarized Light</option><option value="monokai">Monokai</option></select></label>
   <span className={`jupyter-kernel-status ${kernelState}`}>{kernelState==="ready"?`Connected: ${kernels.find(kernel=>kernel.name===kernelName)?.displayName||kernelName}`:kernelState==="starting"?"Starting kernel…":kernelState==="loading"?"Finding kernels…":kernelState}</span>
   <button type="button" onClick={()=>fileInput.current?.click()} disabled={uploadingFiles||kernelState!=="ready"}><FileUp/>{uploadingFiles?"Uploading…":"Upload files"}</button><input ref={fileInput} className="jupyter-file-input" type="file" multiple onChange={uploadFiles} aria-label="Upload files"/>
   <button type="button" onClick={saveNotebook}><Save/>Save notebook</button><button type="button" onClick={downloadNotebook}><Download/>Download .ipynb</button>
  </div>
  <main className="jupyter-cells">
   {kernels.length===0&&kernelState!=="loading"&&<div className="jupyter-message error">{kernelError||"No Jupyter kernels were found. Register a Python environment with ipykernel and restart the app."}</div>}
   {kernelError&&<div className="jupyter-message error">{kernelError}</div>}
   {kernelErrorMessage&&<div className="jupyter-message error">{kernelErrorMessage}</div>}
   {cells.map((cell,index)=><section className={`jupyter-cell ${activeCellId===cell.id?"running":""}`} key={cell.id}>
    <div className="jupyter-cell-toolbar"><span>{cell.cell_type==="code"?`In [${cell.execution_count??(activeCellId===cell.id?"*":" ")}]`:"Markdown"}</span><select aria-label={`Cell ${index+1} type`} value={cell.cell_type} onChange={event=>updateCell(cell.id,{cell_type:event.target.value,outputs:[]})}><option value="code">Code</option><option value="markdown">Markdown</option></select>{cell.cell_type==="code"?<button type="button" disabled={kernelState!=="ready"||!!activeCellId} onClick={()=>runCell(cell)}><Play/>Run cell</button>:<button type="button" onClick={()=>cell.rendered?updateCell(cell.id,{rendered:false}):renderMarkdown(cell.id)}>{cell.rendered?<><Pencil/>Edit Markdown</>:<><Eye/>Render Markdown</>}</button>}<button type="button" aria-label={`Delete cell ${index+1}`} onClick={()=>setCells(current=>current.filter(item=>item.id!==cell.id))}><Trash2/></button></div>
    {cell.cell_type!=="markdown"||!cell.rendered?<textarea ref={element=>{if(element)cellTextareas.current.set(cell.id,element);else cellTextareas.current.delete(cell.id)}} aria-label={`${cell.cell_type} cell ${index+1}`} value={cell.source} placeholder={cell.cell_type==="code"?"Enter code; Shift+Enter runs this cell":"Write Markdown; select Render Markdown to preview"} onChange={event=>updateCell(cell.id,{source:event.target.value})} onKeyDown={event=>{if(event.key==="Enter"&&event.shiftKey){event.preventDefault();if(cell.cell_type==="code")runCell(cell);else renderMarkdown(cell.id)}}}/>:<MarkdownCell source={cell.source}/>}
    {!!cell.outputs?.length&&<div className="jupyter-cell-outputs">{cell.outputs.map((output,outputIndex)=><NotebookOutput key={outputIndex} output={output}/>)}</div>}
    <div className="jupyter-add-cell"><button type="button" onClick={()=>addCell("code",index+1)}><Plus/><Code2/>Code</button><button type="button" onClick={()=>addCell("markdown",index+1)}><Plus/>Markdown</button></div>
   </section>)}
  </main>
  {activeInput&&<form className="jupyter-input-form" onSubmit={sendInput}><label>{activeInput.prompt||"Input"}<input autoFocus aria-label="Jupyter program input" value={inputValue} onChange={event=>setInputValue(event.target.value)}/></label><button type="submit">Send input</button></form>}
  <footer className="jupyter-footer">Kernels use the packages and hardware available in their own environment. Load CSV files with <code>pd.read_csv("filename.csv")</code>. If you see a UTF-8 decode error, try <code>pd.read_csv("filename.csv", encoding="cp1252")</code> for a Windows/Excel CSV. Use <code>%pip install package-name</code> to install into the selected kernel. Kernel code runs with your Windows account’s permissions.</footer>
 </section></div>
}
