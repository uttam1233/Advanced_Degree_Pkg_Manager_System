import {lazy,memo,Suspense,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {BookOpen,Code2,Download,Eye,FileUp,Pencil,Play,Plus,RefreshCw,Save,Terminal,Trash2,X} from "lucide-react";
import "./jupyter-notebook.css";
import {apiFetch,isDesktopApp} from "./desktop-api.js";
import {importIpynbNotebook} from "./notebook-import.js";
import {renderNotebookMarkdown} from "./notebook-render.js";
import {CellHeightIndex} from "./notebook-virtualization.js";

const newCell=(cellType="code")=>({id:crypto.randomUUID(),cell_type:cellType,source:"",outputs:[],execution_count:null});
const cellGap=22,cellOverscan=2,largeOutputLimit=250_000,outputPreviewLength=20_000;
const NotebookCodeEditor=lazy(()=>import("./NotebookCodeEditor.jsx"));

function estimateCellHeight(cell){
 const source=typeof cell.source==="string"?cell.source:"";
 let sourceLines=1,lineBreak=source.indexOf("\n");
 while(lineBreak!==-1){sourceLines++;lineBreak=source.indexOf("\n",lineBreak+1)}
 const inputHeight=cell.cell_type==="markdown"&&cell.rendered?Math.min(520,Math.max(90,sourceLines*24)):Math.min(1800,Math.max(cell.cell_type==="code"?29:42,sourceLines*21));
 const outputHeight=cell.outputs?.length?Math.min(460,80*cell.outputs.length):0;
 return 96+inputHeight+outputHeight+cellGap
}

function sanitizeNotebookHtml(value){
 const template=document.createElement("template");
 template.innerHTML=Array.isArray(value)?value.join(""):value;
 template.content.querySelectorAll("script,style,iframe,object,embed,form,link,meta,base").forEach(element=>element.remove());
 template.content.querySelectorAll("*").forEach(element=>{
  [...element.attributes].forEach(attribute=>{
   const name=attribute.name.toLowerCase(),value=attribute.value.trim();
   if(name.startsWith("on"))element.removeAttribute(attribute.name);
   if(name==="style"&&/(?:expression|javascript:|url\s*\()/i.test(value))element.removeAttribute(attribute.name);
   if(name==="src"||name==="href"||name==="action"){
    const allowed=name==="src"
     ?/^(?:https?:|blob:|\/|#|\.{1,2}\/)/i.test(value)||/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)||/^data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,/i.test(value)||value.startsWith("dsm-notebook-file:")
     :/^(?:https?:|mailto:|tel:|\/|#|\.{1,2}\/)/i.test(value);
    if(!allowed)element.removeAttribute(attribute.name);
   }
  });
  if(element.tagName==="IMG"){
   element.setAttribute("loading","lazy");
   element.setAttribute("decoding","async");
   element.setAttribute("referrerpolicy","no-referrer");
  }
  if(element.tagName==="A"&&/^https?:/i.test(element.getAttribute("href")||"")){
   element.setAttribute("target","_blank");
   element.setAttribute("rel","noopener noreferrer");
  }
 });
 return template.innerHTML;
}

function resolveNotebookAssetUrls(value,sessionId,notebookId){
 const template=document.createElement("template");
 template.innerHTML=Array.isArray(value)?value.join(""):value;
 template.content.querySelectorAll("img[src],source[src]").forEach(element=>{
  const source=element.getAttribute("src")?.trim();
  if(!source||/^(?:data:|blob:|https?:|#|\/)/i.test(source))return;
  const query=new URLSearchParams({sessionId,notebookId,fileName:source.split(/[?#]/)[0]});
  element.setAttribute("src",isDesktopApp()?`dsm-notebook-file:${query}`:`/api/notebook-file?${query}`);
 });
 return template.innerHTML;
}

function NotebookOutput({output,sessionId,notebookId}){
 const[expandedContent,setExpandedContent]=useState(null);
 useEffect(()=>setExpandedContent(null),[output]);
 if(output.type==="stream")return <LargeOutputText text={output.text} className="jupyter-stream"/>;
 if(output.type==="input")return <LargeOutputText text={output.text} className="jupyter-input-echo"/>;
 if(output.type==="error")return <LargeOutputText text={[output.ename,output.evalue,...(output.traceback||[])].filter(Boolean).join("\n")} className="jupyter-error"/>;
 const data=output.data||{},imageType=["image/png","image/jpeg","image/gif","image/webp"].find(type=>typeof data[type]==="string");
 if(imageType)return <img className="jupyter-output-image" loading="lazy" decoding="async" src={`data:${imageType};base64,${data[imageType]}`} alt="Notebook output"/>;
 if(typeof data["image/svg+xml"]==="string")return <img className="jupyter-output-image" loading="lazy" decoding="async" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data["image/svg+xml"])}`} alt="Notebook SVG output"/>;
 const html=data["text/html"];
 if(html){
  const markup=Array.isArray(html)?html.join(""):html;
  if(markup.length>largeOutputLimit&&expandedContent!==markup)return <div className="jupyter-large-output"><span>Large HTML output deferred ({(markup.length/1024).toFixed(0)} KB).</span><button type="button" onClick={()=>setExpandedContent(markup)}>Render output</button></div>;
  return <div className="jupyter-result jupyter-html-result" dangerouslySetInnerHTML={{__html:sanitizeNotebookHtml(markup)}}/>
 }
 const markdown=data["text/markdown"];
 if(markdown){
  const source=Array.isArray(markdown)?markdown.join(""):markdown;
  if(source.length>largeOutputLimit&&expandedContent!==source)return <div className="jupyter-large-output"><span>Large Markdown output deferred ({(source.length/1024).toFixed(0)} KB).</span><button type="button" onClick={()=>setExpandedContent(source)}>Render output</button></div>;
  return <MemoizedRichMarkupCell source={source} markdown sessionId={sessionId} notebookId={notebookId}/>
 }
 const plain=data["text/plain"];
 if(!plain)return null;
 const text=Array.isArray(plain)?plain.join(""):plain;
 return text.length>largeOutputLimit?<LargeOutputText text={text}/>:<pre className="jupyter-result">{text}</pre>
}
const MemoizedNotebookOutput=memo(NotebookOutput);

function LargeOutputText({text,className="jupyter-result"}){
 if(text.length<=outputPreviewLength)return <pre className={className}>{text}</pre>;
 return <ExpandableOutputText text={text} className={className}/>
}

function ExpandableOutputText({text,className}){
 const[state,setState]=useState({text,visibleLength:outputPreviewLength});
 const visibleLength=state.text===text?state.visibleLength:outputPreviewLength;
 const visibleText=text.slice(0,visibleLength);
 return <div className="jupyter-large-output"><pre className={className}>{visibleText}</pre>{visibleLength<text.length&&<button type="button" onClick={()=>setState(current=>({text,visibleLength:Math.min(text.length,(current.text===text?current.visibleLength:outputPreviewLength)+outputPreviewLength)}))}>Show more ({Math.min(outputPreviewLength,text.length-visibleLength).toLocaleString()} characters) · {visibleLength.toLocaleString()} of {text.length.toLocaleString()}</button>}</div>
}

function RichMarkupCell({source,markdown=false,sessionId,notebookId}){
 const rootRef=useRef(null);
 const markup=markdown?renderNotebookMarkdown(source):source;
 const html=sanitizeNotebookHtml(resolveNotebookAssetUrls(markup,sessionId,notebookId));
 useEffect(()=>{
  if(!isDesktopApp()||!rootRef.current)return;
  let cancelled=false;
  const objectUrls=[];
  rootRef.current.querySelectorAll("[src^='dsm-notebook-file:']").forEach(async element=>{
   const query=element.getAttribute("src").slice("dsm-notebook-file:".length);
   try{
    const response=await apiFetch(`/api/notebook-file?${query}`);
    if(!response.ok)throw new Error("Unable to load the notebook workspace image.");
    const objectUrl=URL.createObjectURL(await response.blob());
    if(cancelled){URL.revokeObjectURL(objectUrl);return}
    objectUrls.push(objectUrl);
    element.src=objectUrl;
   }catch{
    if(!cancelled){
     element.removeAttribute("src");
     element.setAttribute("alt",`${element.getAttribute("alt")||"Notebook image"} (workspace file unavailable)`);
    }
   }
  });
  return()=>{cancelled=true;objectUrls.forEach(url=>URL.revokeObjectURL(url))}
 },[html]);
 return <div ref={rootRef} className={`jupyter-markup ${markdown?"jupyter-markdown":""}`} dangerouslySetInnerHTML={{__html:html}}/>
}
const MemoizedRichMarkupCell=memo(RichMarkupCell);

function setTextareaEdit(textarea,value,start,end,onChange){
 textarea.value=value;
 textarea.style.height="auto";
 textarea.style.height=`${textarea.scrollHeight}px`;
 onChange(value);
 requestAnimationFrame(()=>{
  textarea.selectionStart=start;
  textarea.selectionEnd=end;
 });
}

export default function JupyterNotebook({sessionId,subjectId,notebookId,notebook,onSave,close}){
 const[cells,setCells]=useState(()=>Array.isArray(notebook?.cells)&&notebook.cells.length?notebook.cells.map(cell=>{const cellType=cell.cell_type==="raw"||cell.cell_type==="html"?"markdown":cell.cell_type;return{...cell,cell_type:cellType,outputs:cell.outputs||[],rendered:cellType==="markdown"}}):[newCell()]);
 const[fileName,setFileName]=useState(notebook?.fileName||"Untitled.ipynb");
 const[notebookMetadata,setNotebookMetadata]=useState(notebook?.metadata||{});
 const[kernels,setKernels]=useState([]);
 const[kernelName,setKernelName]=useState(notebook?.kernelName||"");
 const[kernelState,setKernelState]=useState("loading");
 const[kernelError,setKernelError]=useState("");
 const[activeCellId,setActiveCellId]=useState(null);
 const[focusCellId,setFocusCellId]=useState(null);
 const[activeInput,setActiveInput]=useState(null);
 const[inputValue,setInputValue]=useState("");
 const[kernelErrorMessage,setKernelErrorMessage]=useState("");
 const[fileNotice,setFileNotice]=useState("");
 const[uploadedFiles,setUploadedFiles]=useState([]);
 const[selectedFileName,setSelectedFileName]=useState("");
 const[uploadingFiles,setUploadingFiles]=useState(false);
 const[documentation,setDocumentation]=useState(null);
 const[theme,setTheme]=useState("light");
 const[terminalOpen,setTerminalOpen]=useState(false),[terminalReady,setTerminalReady]=useState(false),[terminalCwd,setTerminalCwd]=useState(""),[terminalEntries,setTerminalEntries]=useState([]),[terminalCommand,setTerminalCommand]=useState(""),[terminalJobId,setTerminalJobId]=useState(null);
 const[ownerId]=useState(()=>crypto.randomUUID());
 const generation=useRef(0),pendingEditorFocus=useRef(null),documentationRequest=useRef(0);
 const activeInputRef=useRef(null);
 const cellTextareas=useRef(new Map()),cellEditors=useRef(new Map()),cellElements=useRef(new Map()),cellElementCallbacks=useRef(new Map()),textareaCallbacks=useRef(new Map()),editorCallbacks=useRef(new Map());
 const notebookScroll=useRef(null),cellList=useRef(null),measuredCellHeights=useRef(new Map()),estimatedCellHeights=useRef(new Map());
 const cellLayoutRef=useRef(null),updateVisibleRangeRef=useRef(null),cellResizeObserver=useRef(null),cellDrafts=useRef(new Map());
 const fileInput=useRef(null);
 const[visibleRange,setVisibleRange]=useState({start:0,end:12}),[heightVersion,setHeightVersion]=useState(0),[workspaceRevision,setWorkspaceRevision]=useState(0);
 activeInputRef.current=activeInput;
 const cellLayout=useMemo(()=>{
  const entries=cells.map((cell,index)=>{
   let estimate=estimatedCellHeights.current.get(cell.id);
   if(estimate===undefined){estimate=estimateCellHeight(cell);estimatedCellHeights.current.set(cell.id,estimate)}
   const height=measuredCellHeights.current.get(cell.id)||estimate;
   return{cell,index,height}
  });
  return{entries,heightIndex:new CellHeightIndex(entries.map(entry=>entry.height)),indexById:new Map(entries.map(entry=>[entry.cell.id,entry.index]))}
 },[cells]);
 cellLayoutRef.current=cellLayout;
 const visibleCells=useMemo(()=>cellLayout.entries.slice(visibleRange.start,Math.min(visibleRange.end,cellLayout.entries.length)).map(entry=>({...entry,top:cellLayout.heightIndex.prefix(entry.index)})),[cellLayout,visibleRange,heightVersion]);

 useLayoutEffect(()=>{
  if(!focusCellId)return;
  const index=cellLayout.indexById.get(focusCellId),scroll=notebookScroll.current,list=cellList.current;
  const focus=()=>{const editor=cellEditors.current.get(focusCellId);if(editor){editor.focus();pendingEditorFocus.current=null}else if(cellTextareas.current.has(focusCellId))cellTextareas.current.get(focusCellId)?.focus();else pendingEditorFocus.current=focusCellId};
  if(index!==undefined&&scroll&&list&&!cellElements.current.has(focusCellId))scroll.scrollTop=Math.max(0,list.offsetTop+cellLayout.heightIndex.prefix(index)-scroll.clientHeight/3);
  const cell=cellElements.current.get(focusCellId);
  if(cell)cell.scrollIntoView({behavior:"smooth",block:"center"});
  requestAnimationFrame(()=>requestAnimationFrame(focus));
  setFocusCellId(null);
 },[cellLayout,focusCellId]);

 useEffect(()=>{
  const scroll=notebookScroll.current,list=cellList.current;
  if(!scroll||!list)return;
  let frame=0;
  const updateRange=()=>{
   frame=0;
   const{entries,heightIndex}=cellLayoutRef.current;
   if(!entries.length)return;
   const startOffset=Math.max(0,scroll.scrollTop-list.offsetTop),endOffset=startOffset+scroll.clientHeight;
   const firstVisible=heightIndex.indexAt(startOffset),lastVisible=heightIndex.indexAt(endOffset);
   const start=Math.max(0,firstVisible-cellOverscan);
   const end=Math.min(entries.length,Math.max(start+1,lastVisible+cellOverscan+1));
   setVisibleRange(current=>current.start===start&&current.end===end?current:{start,end})
  };
  const onScroll=()=>{if(!frame)frame=requestAnimationFrame(updateRange)};
  scroll.addEventListener("scroll",onScroll,{passive:true});
  const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(onScroll);
  observer?.observe(scroll);
  updateVisibleRangeRef.current=updateRange;
  updateRange();
  return()=>{scroll.removeEventListener("scroll",onScroll);observer?.disconnect();cancelAnimationFrame(frame);updateVisibleRangeRef.current=null}
 },[]);
 useLayoutEffect(()=>{updateVisibleRangeRef.current?.()},[cellLayout,heightVersion]);

 useEffect(()=>{
  if(typeof ResizeObserver==="undefined")return;
  const observer=new ResizeObserver(entries=>{
   let changed=false;
   entries.forEach(entry=>{
    const element=entry.target,id=element.dataset.cellId;
    if(!id)return;
    const height=Math.ceil(element.getBoundingClientRect().height+cellGap),previous=measuredCellHeights.current.get(id);
    if(!previous||Math.abs(previous-height)>2){
     measuredCellHeights.current.set(id,height);
     const index=cellLayoutRef.current?.indexById.get(id);
     if(index!==undefined)cellLayoutRef.current.heightIndex.update(index,height);
     changed=true
    }
   });
   if(changed)setHeightVersion(version=>version+1)
  });
  cellResizeObserver.current=observer;
  cellElements.current.forEach(element=>observer.observe(element));
  return()=>{observer.disconnect();cellResizeObserver.current=null}
 },[]);

 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   try{
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"kernels"})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to list Jupyter kernels.");
    if(result.notebookApiVersion!==8)throw new Error("The notebook service is out of date. Close all Degree Study Manager windows and restart the app.");
    if(cancelled)return;
    setKernels(result.kernels);
    if(notebook?.kernelName&&result.kernels.some(kernel=>kernel.name===notebook.kernelName))setKernelName(notebook.kernelName);
    else{setKernelState("idle");if(notebook?.kernelName)setKernelError(`The saved kernel "${notebook.kernelName}" is not currently installed. Select another kernel.`)}
   }catch(error){if(!cancelled){setKernelState("unavailable");setKernelError(error instanceof Error?error.message:"Unable to discover Jupyter kernels.")}}
  })();
  return()=>{cancelled=true}
 },[]);

 async function refreshUploadedFiles(){
  const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Unable to list notebook files.");
  setUploadedFiles(result.files);
  setSelectedFileName(current=>result.files.some(file=>file.fileName===current)?current:(result.files[0]?.fileName||""));
 }

 useEffect(()=>{
  let cancelled=false;
  (async()=>{
   try{
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to list notebook files.");
    if(!cancelled){setUploadedFiles(result.files);setSelectedFileName(result.files[0]?.fileName||"")}
   }catch(error){if(!cancelled)setKernelErrorMessage(error instanceof Error?error.message:"Unable to list notebook files.")}
  })();
  return()=>{cancelled=true}
 },[sessionId,notebookId]);

 useEffect(()=>{
  let cancelled=false;
  reloadWorkspaceNotebook(false,{silent:true,isCancelled:()=>cancelled}).catch(error=>{
   if(!cancelled)setKernelErrorMessage(error instanceof Error?error.message:"Unable to check for changes saved from Alacritty.")
  });
  return()=>{cancelled=true}
 },[sessionId,notebookId]);

 useEffect(()=>{
  if(!kernelName||!kernels.length)return;
  let cancelled=false;
  const currentGeneration=++generation.current;
  setKernelState("starting");setKernelError("");
  (async()=>{
   try{
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"start",sessionId,notebookId,kernelName,ownerId})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to start the selected kernel.");
    if(cancelled)return;
    setKernelState("ready");setKernelErrorMessage("");
   }catch(error){if(!cancelled){setKernelState("error");setKernelError(error instanceof Error?error.message:"Unable to start the selected kernel.")}}
  })();
  return()=>{
   cancelled=true;
   if(generation.current===currentGeneration)generation.current++;
   apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"stop",sessionId,notebookId,ownerId})}).catch(()=>{});
  }
 },[kernelName,kernels,sessionId,notebookId,ownerId]);

 async function pollExecution(jobId,cellId,advanceFocus=true){
  let cursor=0;
  try{
   while(true){
    await new Promise(resolve=>setTimeout(resolve,250));
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"poll",sessionId,notebookId,jobId,cursor})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to read notebook output.");
    cursor=result.nextCursor;
    if(result.outputs.length)setCells(current=>current.map(cell=>cell.id===cellId?{...cell,outputs:[...cell.outputs,...result.outputs]}:cell));
    if(result.inputRequest!==null&&result.inputRequest!==undefined)setActiveInput({jobId,cellId,prompt:result.inputRequest});
    if(result.done){
     setCells(current=>current.map(cell=>cell.id===cellId?{...cell,execution_count:result.executionCount}:cell));
     if(advanceFocus)setCells(current=>{
       const index=current.findIndex(cell=>cell.id===cellId);
       if(index<0)return current;
       const next=current[index+1];
       if(next){setFocusCellId(next.id);return current}
       const created=newCell();
       setFocusCellId(created.id);
       return [...current.slice(0,index+1),created,...current.slice(index+1)]
      });
     if(!result.success)setKernelErrorMessage(result.error||"The cell finished with an error.");
     setActiveInput(current=>current?.jobId===jobId?null:current);
     setActiveCellId(null);return
    }
   }
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Notebook execution failed.");setActiveCellId(null);setActiveInput(current=>current?.jobId===jobId?null:current)}
 }

 async function runCell(cell,advanceFocus=true){
  if(kernelState!=="ready"||activeCellId)return;
  const source=cellDrafts.current.get(cell.id)??cell.source;
  cellDrafts.current.delete(cell.id);
  const updatedCell={...cell,source};
  estimatedCellHeights.current.set(cell.id,estimateCellHeight(updatedCell));
  setActiveCellId(cell.id);setKernelErrorMessage("");setActiveInput(null);
  setCells(current=>current.map(item=>item.id===cell.id?{...item,source,outputs:[],execution_count:null}:item));
  try{
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"execute",sessionId,notebookId,code:source})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to run notebook cell.");
   await pollExecution(result.jobId,cell.id,advanceFocus);
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Notebook execution failed.");setActiveCellId(null)}
 }

 async function inspectCodeAtCursor(code,cursorPosition){
  const cursorPos=Array.from(code.slice(0,cursorPosition)).length;
  const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"inspect",sessionId,notebookId,code,cursorPos})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Unable to inspect this Python object.");
  let cursor=0;
  for(let attempt=0;attempt<100;attempt++){
   await new Promise(resolve=>setTimeout(resolve,100));
   const pollResponse=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"poll",sessionId,notebookId,jobId:result.jobId,cursor})});
   const poll=await pollResponse.json();
   if(!pollResponse.ok)throw new Error(poll.error||"Unable to read Python documentation.");
   cursor=poll.nextCursor;
   if(poll.done){
    if(!poll.success)throw new Error(poll.error||"The kernel could not inspect this object.");
    return poll.inspection
   }
  }
  throw new Error("The kernel did not return documentation in time.")
 }

 async function completePython(code,cursorPosition,isCancelled=()=>false){
  if(kernelState!=="ready"||activeCellId||isCancelled())return null;
  const cursorPos=Array.from(code.slice(0,cursorPosition)).length;
  const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"complete",sessionId,notebookId,code,cursorPos})});
  const result=await response.json();
  if(response.status===409)return null;
  if(!response.ok)throw new Error(result.error||"Unable to request Python completions.");
  let cursor=0;
  for(let attempt=0;attempt<30;attempt++){
   if(isCancelled())return null;
   await new Promise(resolve=>setTimeout(resolve,60));
   const pollResponse=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"poll",sessionId,notebookId,jobId:result.jobId,cursor})});
   const poll=await pollResponse.json();
   if(!pollResponse.ok)throw new Error(poll.error||"Unable to read Python completions.");
   cursor=poll.nextCursor;
   if(poll.done){
    if(!poll.success)throw new Error(poll.error||"The kernel could not complete this Python expression.");
    return poll.completion
   }
  }
  throw new Error("The kernel did not return Python completions in time.")
 }

 async function validatePython(code){
  if(kernelState!=="ready")return[];
  const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"validate",sessionId,notebookId,code})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Unable to check Python syntax.");
  let cursor=0;
  for(let attempt=0;attempt<100;attempt++){
   await new Promise(resolve=>setTimeout(resolve,100));
   const pollResponse=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"poll",sessionId,notebookId,jobId:result.jobId,cursor})});
   const poll=await pollResponse.json();
   if(!pollResponse.ok)throw new Error(poll.error||"Unable to read Python syntax diagnostics.");
   cursor=poll.nextCursor;
   if(poll.done){
    if(!poll.success)throw new Error(poll.error||"Python syntax checking failed.");
    return(poll.validation||[]).map(diagnostic=>{
     const lines=code.split("\n");
     const line=Math.min(Math.max(0,diagnostic.line||0),lines.length-1);
     const start=lines.slice(0,line).reduce((total,item)=>total+item.length+1,0);
     const from=Math.min(code.length,start+Array.from(lines[line]||"").slice(0,Math.max(0,diagnostic.column||0)).join("").length);
     return{from,to:Math.min(code.length,from+1),severity:"error",source:"Python syntax",message:diagnostic.message}
    })
   }
  }
  throw new Error("Python syntax checking did not finish in time.")
 }

 async function showDocumentation(cellId){
  const editor=cellEditors.current.get(cellId);
  if(!editor)return;
  const requestId=++documentationRequest.current;
  if(kernelState!=="ready"){
   setDocumentation({cellId,error:"Connect to a Jupyter kernel to inspect documentation."});
   return
  }
  const code=editor.state.doc.toString(),cursorPos=editor.state.selection.main.head;
  if(!code.slice(0,cursorPos).trim()){
   setDocumentation({cellId,error:"Place the cursor on a function, class, or object to inspect it."});
   return
  }
  setDocumentation({cellId,loading:true});
  try{
   const inspection=await inspectCodeAtCursor(code,cursorPos);
   if(documentationRequest.current===requestId)setDocumentation({cellId,text:inspection.text||"",found:inspection.found});
  }catch(error){if(documentationRequest.current===requestId)setDocumentation({cellId,error:error instanceof Error?error.message:"Unable to inspect this Python object."})}
 }

 async function inspectOnHover(code,cursorPos){
  if(kernelState!=="ready"||activeCellId)return null;
  return inspectCodeAtCursor(code,cursorPos)
 }

 function reportCompletionError(error){
  setKernelErrorMessage(error instanceof Error?`Python completion failed: ${error.message}`:"Python completion failed.")
 }

 function addTerminalEntries(...entries){
  setTerminalEntries(current=>[...current,...entries].slice(-200))
 }

 async function initializeNotebookTerminal(){
  try{
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"terminal-init",sessionId,notebookId})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to open the notebook PowerShell terminal.");
   if(result.terminalApiVersion!==1)throw new Error("The notebook terminal service is out of date. Close all Degree Study Manager windows and restart the app.");
   setTerminalCwd(result.cwd);
   setTerminalReady(true);
   if(!terminalEntries.length)addTerminalEntries({id:crypto.randomUUID(),kind:"system",text:`PowerShell · ${result.cwd}\nCommands run locally as your Windows account. Commands time out after 30 seconds; output is limited to 1 MB.`})
  }catch(error){addTerminalEntries({id:crypto.randomUUID(),kind:"error",text:error instanceof Error?error.message:"Unable to open the notebook PowerShell terminal."})}
 }

 async function pollNotebookTerminal(jobId){
  try{
   while(true){
    await new Promise(resolve=>setTimeout(resolve,200));
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"terminal-poll",sessionId,notebookId,jobId})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||"Unable to read PowerShell output.");
    if(result.output)addTerminalEntries({id:crypto.randomUUID(),kind:"output",text:result.output});
    if(result.done){
     setTerminalCwd(result.cwd||"");
     addTerminalEntries({id:crypto.randomUUID(),kind:result.ok?"system":"error",text:`[exit code ${result.exitCode}]`});
     setTerminalJobId(null);
     return
    }
   }
  }catch(error){addTerminalEntries({id:crypto.randomUUID(),kind:"error",text:error instanceof Error?error.message:"PowerShell command failed."});setTerminalJobId(null)}
 }

 async function submitTerminalCommand(event){
  event.preventDefault();
  const command=terminalCommand;
  if(!terminalReady||(!terminalJobId&&!command.trim()))return;
  setTerminalCommand("");
  const activeJob=terminalJobId;
  addTerminalEntries({id:crypto.randomUUID(),kind:"command",text:activeJob?command:`PS> ${command}`});
  try{
   const action=activeJob?"terminal-input":"terminal-command";
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,sessionId,notebookId,...(activeJob?{jobId:activeJob,input:command}:{command})})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to send the PowerShell command.");
   if(!activeJob){setTerminalJobId(result.jobId);void pollNotebookTerminal(result.jobId)}
  }catch(error){addTerminalEntries({id:crypto.randomUUID(),kind:"error",text:error instanceof Error?error.message:"Unable to send the PowerShell command."})}
 }

 async function sendInput(event){
  event.preventDefault();
  const current=activeInputRef.current;
  if(!current)return;
  try{
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"input",sessionId,notebookId,jobId:current.jobId,value:inputValue})});
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
    const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"upload-file",sessionId,notebookId,fileName:file.name,dataUrl})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||`Unable to upload ${file.name}.`);
    uploaded.push(result.fileName)
   }
   const result=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list-files",sessionId,notebookId})});
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
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"delete-file",sessionId,notebookId,fileName:selectedFileName})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||`Unable to delete ${selectedFileName}.`);
   setUploadedFiles(result.files);
   setSelectedFileName(result.files[0]?.fileName||"");
   setFileNotice(`Deleted ${selectedFileName} from the notebook workspace.`)
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Unable to delete uploaded file.")}
 }

 async function saveNotebook(){
  const name=fileName.trim();
  if(!name||!name.toLowerCase().endsWith(".ipynb")){setKernelErrorMessage("Enter a notebook filename ending in .ipynb.");return}
  try{
   const document=buildNotebookDocument();
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"save-workspace",sessionId,notebookId,fileName:name,notebook:document})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to save the notebook workspace file.");
   onSave({notebookId,sessionId,subjectId,title:name,fileName:name,cells:cellsWithDrafts(),kernelName,metadata:notebookMetadata});
   setKernelErrorMessage("");
   setFileNotice(`Saved ${name} to the app and shared notebook file.`);
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Unable to save the notebook.")}
 }

 async function reloadWorkspaceNotebook(force=false,{silent=false,isCancelled=()=>false}={}){
  if(activeCellId)throw new Error("Wait for the running cell to finish before reloading the notebook.");
  if(force&&!window.confirm("Reloading will replace the current notebook contents. Any changes not saved to the app will be lost. Continue?"))return;
  const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"load-workspace",sessionId,notebookId,fileName,notebookUpdatedAt:notebook?.updatedAt||null,force})});
  if(isCancelled())return;
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||"Unable to read the notebook saved from Alacritty.");
  if(!result.found){
   if(!silent)setFileNotice(`No shared ${fileName} file exists yet. Open it in Alacritty first.`);
   return
  }
  if(!result.changed){
   if(!silent)setFileNotice("The shared notebook has no changes newer than the saved app copy.");
   return
  }
  if(cellDrafts.current.size){
   setFileNotice("Alacritty has newer changes. Save or discard current edits before reloading.");
   return
  }
  const imported=importIpynbNotebook(JSON.stringify(result.notebook));
  const name=result.fileName;
  setCells(imported.cells);
  setNotebookMetadata(imported.metadata);
  setFileName(name);
  if(imported.kernelName!==kernelName)setKernelName(imported.kernelName);
  cellDrafts.current.clear();
  measuredCellHeights.current.clear();
  estimatedCellHeights.current.clear();
  setWorkspaceRevision(revision=>revision+1);
  setFileNotice(`Loaded changes saved in Alacritty from ${name}.`);
  onSave({notebookId,sessionId,subjectId,title:name,fileName:name,cells:imported.cells,kernelName:imported.kernelName,metadata:imported.metadata});
 }

 function buildNotebookDocument(){
  const currentCells=cellsWithDrafts();
  const output=(cell,executionCount)=>{
   if(cell.type==="stream")return{output_type:"stream",name:cell.name,text:cell.text};
   if(cell.type==="input")return{output_type:"stream",name:"stdin",text:cell.text};
   if(cell.type==="error")return{output_type:"error",ename:cell.ename,evalue:cell.evalue,traceback:cell.traceback||[]};
   if(cell.type==="execute_result")return{output_type:"execute_result",execution_count:cell.executionCount??executionCount??null,data:cell.data||{},metadata:cell.metadata||{}};
   if(cell.type==="display_data")return{output_type:"display_data",data:cell.data||{},metadata:cell.metadata||{}};
   return null
  };
  return{nbformat:4,nbformat_minor:5,metadata:{...notebookMetadata,kernelspec:{...(notebookMetadata?.kernelspec||{}),name:kernelName||"",display_name:kernels.find(kernel=>kernel.name===kernelName)?.displayName||kernelName||"No kernel selected",language:kernels.find(kernel=>kernel.name===kernelName)?.language||notebookMetadata?.kernelspec?.language||"python"}},cells:currentCells.map(cell=>cell.cell_type==="code"?{id:cell.id,cell_type:"code",metadata:cell.metadata||{},execution_count:cell.execution_count??null,source:cell.source,outputs:(cell.outputs||[]).map(item=>output(item,cell.execution_count)).filter(Boolean)}:{id:cell.id,cell_type:cell.cell_type==="html"?"raw":"markdown",metadata:cell.metadata||{},source:cell.source})}
 }

 function downloadNotebook(){
  const notebookData=buildNotebookDocument();
  const link=document.createElement("a"),url=URL.createObjectURL(new Blob([JSON.stringify(notebookData,null,2)],{type:"application/x-ipynb+json"}));
  link.href=url;link.download=fileName.trim().toLowerCase().endsWith(".ipynb")?fileName.trim():"Untitled.ipynb";link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
 }

 async function openNotebookTerminal(){
  const name=fileName.trim();
  if(!name||!name.toLowerCase().endsWith(".ipynb")){setKernelErrorMessage("Enter a notebook filename ending in .ipynb.");return}
  setKernelErrorMessage("");
  try{
   const response=await apiFetch("/api/notebook",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"open-terminal",sessionId,notebookId,fileName:name,notebook:buildNotebookDocument()})});
   const result=await response.json();
   if(!response.ok)throw new Error(result.error||"Unable to open the notebook in Alacritty.");
   setFileNotice(`Opened shared notebook ${result.notebookPath||name} with ${result.alacrittyPath||"Alacritty"}.`);
  }catch(error){setKernelErrorMessage(error instanceof Error?error.message:"Unable to open Alacritty.")}
 }

 function cellsWithDrafts(){return cellDrafts.current.size?cells.map(cell=>{const source=cellDrafts.current.get(cell.id);return source===undefined?cell:{...cell,source}}):cells}
 function updateCell(cellId,updates){
  const pendingSource=cellDrafts.current.get(cellId);
  if(updates.source===undefined&&pendingSource!==undefined){updates={...updates,source:pendingSource};cellDrafts.current.delete(cellId)}
  setCells(current=>current.map(cell=>{if(cell.id!==cellId)return cell;const next={...cell,...(updates.source===undefined?{}:{rendered:false}),...updates};if(updates.source!==undefined)estimatedCellHeights.current.set(cellId,estimateCellHeight(next));return next}))
 }
 function renderMarkup(cellId){updateCell(cellId,{rendered:true})}
 function recordCellDraft(cellId,source){cellDrafts.current.set(cellId,source)}
 function handleCellKeyDown(event,cell){
  const textarea=event.currentTarget;
  const{value,selectionStart:start,selectionEnd:end}=textarea;
  const selected=value.slice(start,end);
  const indentation=" ".repeat(4);
  const paired={"(":")","[":"]","{":"}","\"":"\"","'":"'","`":"`"};
  if(event.key==="Tab"){
   event.preventDefault();
   if(event.shiftKey){
    const lineStart=value.lastIndexOf("\n",start-1)+1;
    const lineEnd=value.indexOf("\n",end);
    const blockEnd=lineEnd<0?value.length:lineEnd;
    const block=value.slice(lineStart,blockEnd);
    let removed=0;
    const unindented=block.split("\n").map(line=>{
     const removeCount=Math.min(4,(line.match(/^ */)||[""])[0].length);
     removed+=removeCount;
     return line.slice(removeCount);
    }).join("\n");
    setTextareaEdit(textarea,value.slice(0,lineStart)+unindented+value.slice(blockEnd),Math.max(lineStart,start-(Math.min(4,(value.slice(lineStart,start).match(/^ */)||[""])[0].length))),Math.max(start,end-removed),next=>recordCellDraft(cell.id,next));
    return;
   }
   if(start!==end&&selected.includes("\n")){
    const lineStart=value.lastIndexOf("\n",start-1)+1;
    const lineEnd=value.indexOf("\n",end);
    const blockEnd=lineEnd<0?value.length:lineEnd;
    const block=value.slice(lineStart,blockEnd).split("\n").map(line=>indentation+line).join("\n");
    const added=indentation.length*block.split("\n").length;
    setTextareaEdit(textarea,value.slice(0,lineStart)+block+value.slice(blockEnd),start+4,end+added,next=>recordCellDraft(cell.id,next));
    return;
   }
   setTextareaEdit(textarea,value.slice(0,start)+indentation+value.slice(end),start+4,start+4,next=>recordCellDraft(cell.id,next));
   return;
  }
  if(paired[event.key]){
   event.preventDefault();
   if(start===end&&value[start]===paired[event.key]){
    textarea.selectionStart=start+1;
    textarea.selectionEnd=start+1;
    return;
   }
   setTextareaEdit(textarea,value.slice(0,start)+event.key+selected+paired[event.key]+value.slice(end),start+1,start+1+selected.length,next=>recordCellDraft(cell.id,next));
   return;
  }
  if(event.key==="Enter"&&!event.shiftKey){
   event.preventDefault();
   const lineStart=value.lastIndexOf("\n",start-1)+1;
   const currentLine=value.slice(lineStart,start);
   const baseIndent=(currentLine.match(/^\s*/)||[""])[0];
   const extraIndent=/[([{:]$/.test(currentLine.trimEnd())?indentation:"";
   const inserted=`\n${baseIndent}${extraIndent}`;
   setTextareaEdit(textarea,value.slice(0,start)+inserted+value.slice(end),start+inserted.length,start+inserted.length,next=>recordCellDraft(cell.id,next));
   return;
  }
  if(event.key==="Enter"&&event.shiftKey){
   event.preventDefault();
   if(cell.cell_type==="code")runCell(cell);else renderMarkup(cell.id);
  }
 }
 function addCell(cellType="code",index=cells.length){
  const created=newCell(cellType);
  estimatedCellHeights.current.set(created.id,estimateCellHeight(created));
  setCells(current=>[...current.slice(0,index),created,...current.slice(index)]);
  setFocusCellId(created.id);
 }
 function registerCellElement(cellId,element){
  const previous=cellElements.current.get(cellId);
  if(previous)cellResizeObserver.current?.unobserve(previous);
  if(element){element.dataset.cellId=cellId;cellElements.current.set(cellId,element);cellResizeObserver.current?.observe(element)}
  else{cellElements.current.delete(cellId);cellTextareas.current.delete(cellId);cellElementCallbacks.current.delete(cellId);textareaCallbacks.current.delete(cellId)}
 }
 function registerTextarea(cellId,element){
  if(!element){cellTextareas.current.delete(cellId);textareaCallbacks.current.delete(cellId);return}
  cellTextareas.current.set(cellId,element);
  element.style.height="auto";
  element.style.height=`${element.scrollHeight}px`
 }
 function registerEditor(cellId,view){
  if(view){cellEditors.current.set(cellId,view);if(pendingEditorFocus.current===cellId){view.focus();pendingEditorFocus.current=null}}
  else cellEditors.current.delete(cellId)
 }
 function getCellElementRef(cellId){
  if(!cellElementCallbacks.current.has(cellId))cellElementCallbacks.current.set(cellId,element=>registerCellElement(cellId,element));
  return cellElementCallbacks.current.get(cellId)
 }
 function getTextareaRef(cellId){
  if(!textareaCallbacks.current.has(cellId))textareaCallbacks.current.set(cellId,element=>registerTextarea(cellId,element));
  return textareaCallbacks.current.get(cellId)
 }
 function getEditorRef(cellId){
  if(!editorCallbacks.current.has(cellId))editorCallbacks.current.set(cellId,view=>registerEditor(cellId,view));
  return editorCallbacks.current.get(cellId)
 }

 return <div className="jupyter-overlay"><section className="jupyter-window" data-theme={theme} role="dialog" aria-modal="true" aria-label="Jupyter notebook">
  <header className="jupyter-header"><div className="jupyter-heading"><div><h2>Jupyter notebook</h2><span>Stateful execution in a local installed kernel</span></div>{fileNotice&&<span className="jupyter-upload-status" role="status" aria-live="polite" title={fileNotice}>{fileNotice}</span>}</div><div className="jupyter-header-actions"><button type="button" onClick={openNotebookTerminal} title="Open the shared notebook file in Alacritty"><Terminal/>Open in Alacritty</button><label className="jupyter-files-label">Workspace files <select aria-label="Uploaded notebook files" value={selectedFileName} onChange={event=>setSelectedFileName(event.target.value)} disabled={!uploadedFiles.length}><option value="">{uploadedFiles.length?"Select a file…":"No uploaded files"}</option>{uploadedFiles.map(file=><option key={file.fileName} value={file.fileName}>{file.fileName} ({(file.size/1024).toFixed(1)} KB)</option>)}</select></label><button type="button" className="jupyter-delete-file" onClick={deleteUploadedFile} disabled={!selectedFileName||uploadingFiles}><Trash2/>Delete</button><button type="button" className="jupyter-close" onClick={close}><X/></button></div></header>
  <div className="jupyter-toolbar">
   <label className="jupyter-name">Notebook <input aria-label="Notebook filename" value={fileName} onChange={event=>setFileName(event.target.value)}/></label>
   <label className="jupyter-kernel">Kernel <select aria-label="Select Jupyter kernel" value={kernelName} onChange={event=>setKernelName(event.target.value)} disabled={kernelState==="loading"||!!activeCellId}><option value="">Select installed kernel…</option>{kernels.map(kernel=><option key={kernel.name} value={kernel.name}>{kernel.displayName} · {kernel.language}</option>)}</select></label>
   <label className="jupyter-theme">Theme <select aria-label="Notebook theme" value={theme} onChange={event=>setTheme(event.target.value)}><option value="light">Jupyter Light</option><option value="dark">Jupyter Dark</option><option value="solarized">Solarized Light</option><option value="monokai">Monokai</option><option value="github-light">GitHub Light</option><option value="github-dark">GitHub Dark</option><option value="dracula">Dracula</option><option value="nord">Nord</option><option value="one-dark">One Dark</option></select></label>
   <span className={`jupyter-kernel-status ${kernelState}`}>{kernelState==="ready"?`Connected: ${kernels.find(kernel=>kernel.name===kernelName)?.displayName||kernelName}`:kernelState==="starting"?"Starting kernel…":kernelState==="loading"?"Finding kernels…":kernelState}</span>
   <button type="button" onClick={()=>fileInput.current?.click()} disabled={uploadingFiles||kernelState!=="ready"}><FileUp/>{uploadingFiles?"Uploading…":"Upload files"}</button><input ref={fileInput} className="jupyter-file-input" type="file" multiple onChange={uploadFiles} aria-label="Upload files"/>
   <button type="button" aria-expanded={terminalOpen} onClick={()=>{const open=!terminalOpen;setTerminalOpen(open);if(open&&!terminalReady)void initializeNotebookTerminal()}}><Terminal/>PowerShell</button>
   <button type="button" onClick={()=>reloadWorkspaceNotebook(true).catch(error=>setKernelErrorMessage(error instanceof Error?error.message:"Unable to reload the Alacritty notebook."))} disabled={!!activeCellId} title="Load and save changes made in Alacritty"><RefreshCw/>Reload from Alacritty</button>
   <button type="button" onClick={saveNotebook}><Save/>Save notebook</button><button type="button" onClick={downloadNotebook}><Download/>Download .ipynb</button>
  </div>
  <main className="jupyter-cells" ref={notebookScroll}>
   {kernels.length===0&&kernelState!=="loading"&&<div className="jupyter-message error">{kernelError||"No Jupyter kernels were found. Register a Python environment with ipykernel and restart the app."}</div>}
   {kernelError&&<div className="jupyter-message error">{kernelError}</div>}
   {kernelErrorMessage&&<div className="jupyter-message error">{kernelErrorMessage}</div>}
   <div ref={cellList} className="jupyter-cell-list" style={{height:cellLayout.heightIndex.total}}>
    {visibleCells.map(({cell,index,top})=><section ref={getCellElementRef(cell.id)} className={`jupyter-cell jupyter-virtual-cell ${activeCellId===cell.id?"running":""}`} style={{top}} key={`${workspaceRevision}:${cell.id}`}>
     <div className="jupyter-cell-toolbar"><span>{cell.cell_type==="code"?`In [${cell.execution_count??(activeCellId===cell.id?"*":" ")}]`:"Markdown"}</span><select aria-label={`Cell ${index+1} type`} value={cell.cell_type} onChange={event=>updateCell(cell.id,{cell_type:event.target.value,outputs:[]})}><option value="code">Code</option><option value="markdown">Markdown</option></select>{cell.cell_type==="code"?<><button type="button" disabled={kernelState!=="ready"||!!activeCellId} onClick={()=>runCell(cell)}><Play/>Run cell</button><button type="button" className="jupyter-docs-button" disabled={kernelState!=="ready"||!!activeCellId} title="Inspect function or object documentation in the active kernel (Ctrl+Shift+Space)" onClick={()=>showDocumentation(cell.id)}><BookOpen/>Docs</button></>:<button type="button" onClick={()=>cell.rendered?updateCell(cell.id,{rendered:false}):renderMarkup(cell.id)}>{cell.rendered?<><Pencil/>Edit Markdown / HTML</>:<><Eye/>Render Markdown / HTML</>}</button>}<button type="button" aria-label={`Delete cell ${index+1}`} onClick={()=>{measuredCellHeights.current.delete(cell.id);estimatedCellHeights.current.delete(cell.id);cellDrafts.current.delete(cell.id);cellElementCallbacks.current.delete(cell.id);textareaCallbacks.current.delete(cell.id);editorCallbacks.current.delete(cell.id);if(pendingEditorFocus.current===cell.id)pendingEditorFocus.current=null;setCells(current=>current.length===1?[newCell()]:current.filter(item=>item.id!==cell.id))}}><Trash2/></button></div>
     {cell.cell_type==="code"?<Suspense fallback={<div className="jupyter-editor-loading">Loading code editor…</div>}><NotebookCodeEditor key={`${workspaceRevision}:${kernelName}:${cell.id}`} value={cellDrafts.current.get(cell.id)??cell.source} language={kernels.find(kernel=>kernel.name===kernelName)?.language||"python"} kernelReady={kernelState==="ready"} onChange={source=>recordCellDraft(cell.id,source)} onRun={advance=>runCell(cell,advance)} onInspect={()=>showDocumentation(cell.id)} onHoverInspect={inspectOnHover} onComplete={completePython} onCompletionError={reportCompletionError} onValidate={validatePython} onEditorView={getEditorRef(cell.id)}/></Suspense>:!cell.rendered?<textarea ref={getTextareaRef(cell.id)} aria-label={`${cell.cell_type} cell ${index+1}`} defaultValue={cellDrafts.current.get(cell.id)??cell.source} onChange={event=>{event.currentTarget.style.height="auto";event.currentTarget.style.height=`${event.currentTarget.scrollHeight}px`;recordCellDraft(cell.id,event.target.value)}} onKeyDown={event=>handleCellKeyDown(event,cell)}/>:<MemoizedRichMarkupCell source={cell.source} markdown sessionId={sessionId} notebookId={notebookId}/>}
     {documentation?.cellId===cell.id&&<aside className="jupyter-documentation" aria-live="polite"><div className="jupyter-documentation-heading"><strong>Kernel documentation</strong><button type="button" aria-label="Close documentation" onClick={()=>{documentationRequest.current++;setDocumentation(null)}}><X/></button></div>{documentation.loading?<p>Inspecting the active Jupyter kernel…</p>:documentation.error?<p className="jupyter-documentation-error">{documentation.error}</p>:documentation.found&&documentation.text?<pre>{documentation.text}</pre>:<p>No documentation was found for this object.</p>}</aside>}
     {!!cell.outputs?.length&&<div className="jupyter-cell-outputs">{cell.outputs.map((output,outputIndex)=><MemoizedNotebookOutput key={outputIndex} output={output} sessionId={sessionId} notebookId={notebookId}/>)}</div>}
     <div className="jupyter-add-cell"><button type="button" onClick={()=>addCell("code",index+1)}><Plus/><Code2/>Code</button><button type="button" onClick={()=>addCell("markdown",index+1)}><Plus/>Markdown</button></div>
    </section>)}
   </div>
  </main>
  {terminalOpen&&  <section className="jupyter-terminal" aria-label="Notebook PowerShell terminal"><div className="jupyter-terminal-heading"><strong>PowerShell</strong><span title={terminalCwd}>{terminalCwd||"Connecting to notebook workspace…"}</span><button type="button" onClick={()=>setTerminalOpen(false)} aria-label="Close PowerShell terminal"><X/></button></div><div className="jupyter-terminal-output" aria-live="polite">{terminalEntries.map(entry=><pre key={entry.id} className={`jupyter-terminal-${entry.kind}`}>{entry.text}</pre>)}</div><form className="jupyter-terminal-form" onSubmit={submitTerminalCommand}><label aria-label="PowerShell command prompt">{terminalJobId?"Input":`PS ${terminalCwd}>`}<input autoFocus aria-label={terminalJobId?"PowerShell program input":"PowerShell command"} value={terminalCommand} onChange={event=>setTerminalCommand(event.target.value)} disabled={!terminalReady} placeholder={terminalReady?terminalJobId?"Send input to the running program…":"Enter a PowerShell command…":"Starting terminal…"}/></label><button type="submit" disabled={!terminalReady||(!terminalJobId&&!terminalCommand.trim())}>{terminalJobId?"Send input":"Run"}</button></form></section>}
  {activeInput&&<form className="jupyter-input-form" onSubmit={sendInput}><label>{activeInput.prompt||"Input"}<input autoFocus aria-label="Jupyter program input" value={inputValue} onChange={event=>setInputValue(event.target.value)}/></label><button type="submit">Send input</button></form>}
  <footer className="jupyter-footer">Kernels use the packages and hardware available in their own environment. Markdown cells also support HTML, such as <code># Heading</code>, <code>&lt;h1 style="color: #4f46e5"&gt;Heading&lt;/h1&gt;</code>, and <code>&lt;img src="..."&gt;</code>. HTML is sanitized before display. Load CSV files with <code>pd.read_csv("filename.csv")</code>. If you see a UTF-8 decode error, try <code>pd.read_csv("filename.csv", encoding="cp1252")</code> for a Windows/Excel CSV. Use <code>%pip install package-name</code> to install into the selected kernel. Kernel code runs with your Windows account’s permissions.</footer>
 </section></div>
}
