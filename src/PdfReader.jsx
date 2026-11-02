import React,{useCallback,useEffect,useMemo,useRef,useState}from"react";
import{BookOpen,ChevronLeft,ChevronRight,FileText,Hand,List,Maximize,MousePointer2,Printer,RotateCw,Search,X,ZoomIn,ZoomOut}from"lucide-react";
import{openExternalUrl}from"./desktop-api.js";
import{loadPdfJs}from"./pdf-runtime.js";

const minimumZoom=.35,maximumZoom=3,zoomStep=.05,maxCachedTextPages=6,maxCanvasPixels=3_000_000;
const noSearchMatches=[];
const zoomPresets=[.5,.75,1,1.25,1.5,2,2.5,3];

function getWebUrl(value){
 try{
  const url=new URL(value);
  return url.protocol==="http:"||url.protocol==="https:"?url.href:""
 }catch{return ""}
}

function PdfPageThumbnail({pdfDocument,pageNumber,active,root,onSelect}){
 const wrapperRef=useRef(null),canvasRef=useRef(null);
 const[visible,setVisible]=useState(false);
 useEffect(()=>{
  const wrapper=wrapperRef.current;
  if(!wrapper)return;
  if(typeof IntersectionObserver==="undefined"){setVisible(true);return}
  const observer=new IntersectionObserver(entries=>setVisible(entries.some(entry=>entry.isIntersecting)),{root,rootMargin:"120px"});
  observer.observe(wrapper);
  return()=>observer.disconnect()
 },[root]);
 useEffect(()=>{
  let cancelled=false,renderTask=null;
  const canvas=canvasRef.current;
  if(!visible||!canvas)return;
  pdfDocument.getPage(pageNumber).then(page=>{
   if(cancelled)return;
   const base=page.getViewport({scale:1}),scale=Math.min(128/base.width,150/base.height),viewport=page.getViewport({scale}),pixelRatio=Math.min(window.devicePixelRatio||1,1.5),context=canvas.getContext("2d",{alpha:false});
   if(!context)throw new Error("The PDF page preview could not be created.");
   canvas.width=Math.ceil(viewport.width*pixelRatio);
   canvas.height=Math.ceil(viewport.height*pixelRatio);
   canvas.style.width=`${viewport.width}px`;
   canvas.style.height=`${viewport.height}px`;
   renderTask=page.render({canvasContext:context,viewport,transform:pixelRatio===1?null:[pixelRatio,0,0,pixelRatio,0,0],background:"rgb(255,255,255)"});
   return renderTask.promise
  }).catch(()=>{});
  return()=>{cancelled=true;renderTask?.cancel();if(canvas){canvas.width=0;canvas.height=0}}
 },[pdfDocument,pageNumber,visible]);
 return <button ref={wrapperRef} type="button" className={`pdf-thumbnail ${active?"active":""}`} aria-current={active?"page":undefined} onClick={onSelect}>
  <span className="pdf-thumbnail-paper"><canvas ref={canvasRef}/>{!visible&&<FileText aria-hidden="true"/>}</span>
  <span>Page {pageNumber}</span>
 </button>
}

function PdfOutlineItem({item,pdfDocument,onSelect,depth=0}){
 const[expanded,setExpanded]=useState(true);
 return <li className="pdf-outline-item">
  <div className="pdf-outline-row" style={{paddingLeft:8+depth*14}}>
   {item.items?.length>0&&<button type="button" className="pdf-outline-expand" aria-label={`${expanded?"Collapse":"Expand"} ${item.title}`} onClick={()=>setExpanded(value=>!value)}>{expanded?"−":"+"}</button>}
   <button type="button" className="pdf-outline-link" onClick={()=>onSelect(item)}>{item.title||"Untitled section"}</button>
  </div>
  {expanded&&item.items?.length>0&&<ul>{item.items.map((child,index)=><PdfOutlineItem key={`${child.title}:${index}`} item={child} pdfDocument={pdfDocument} onSelect={onSelect} depth={depth+1}/>)}</ul>}
 </li>
}

function PdfDocumentPage({pdfjs,pdfDocument,pageNumber,container,width,zoom,rotation,searchMatches,activeSearchMatch,registerPage,onTextContent,onError,onOpenExternalLink,onNavigateToDestination,forceRender=false,onRenderComplete}){
 const pageRef=useRef(null),canvasRef=useRef(null),textLayerRef=useRef(null);
 const[links,setLinks]=useState([]);
 const[nearViewport,setNearViewport]=useState(false),[aspectRatio,setAspectRatio]=useState(612/792);
 useEffect(()=>{
  const page=pageRef.current;
  if(!page)return;
  if(typeof IntersectionObserver==="undefined"){setNearViewport(true);return}
  const observer=new IntersectionObserver(entries=>setNearViewport(entries.some(entry=>entry.isIntersecting)),{root:container,rootMargin:"480px 0px"});
  observer.observe(page);
  return()=>observer.disconnect()
 },[container,pageNumber]);
 useEffect(()=>{
  let cancelled=false,renderTask=null,textTask=null;
  const canvas=canvasRef.current,textLayer=textLayerRef.current;
  if((!nearViewport&&!forceRender)||!canvas||!textLayer||width<=0)return;
  textLayer.replaceChildren();setLinks([]);
  pdfDocument.getPage(pageNumber).then(async page=>{
   if(cancelled)return;
   const initialViewport=page.getViewport({scale:1,rotation}),pageWidth=Math.max(240,forceRender?Math.min(width*zoom,816):width*zoom),viewport=page.getViewport({scale:pageWidth/initialViewport.width,rotation}),pixelRatio=forceRender?1:Math.min(window.devicePixelRatio||1,1.5,Math.sqrt(maxCanvasPixels/Math.max(1,viewport.width*viewport.height))),context=canvas.getContext("2d",{alpha:false});
   if(!context)throw new Error("The PDF page could not be rendered.");
   setAspectRatio(initialViewport.width/initialViewport.height);
   canvas.width=Math.ceil(viewport.width*pixelRatio);
   canvas.height=Math.ceil(viewport.height*pixelRatio);
   canvas.style.width=`${viewport.width}px`;
   canvas.style.height=`${viewport.height}px`;
   textLayer.style.width=`${viewport.width}px`;
   textLayer.style.height=`${viewport.height}px`;
   context.fillStyle="#ffffff";
   context.fillRect(0,0,canvas.width,canvas.height);
   renderTask=page.render({canvasContext:context,viewport,transform:pixelRatio===1?null:[pixelRatio,0,0,pixelRatio,0,0],background:"rgb(255,255,255)"});
   const[textContent,annotations]=await Promise.all([page.getTextContent(),page.getAnnotations()]);
   if(cancelled)return;
   onTextContent(pageNumber,textContent);
   setLinks(annotations.filter(annotation=>annotation.subtype==="Link"&&Array.isArray(annotation.rect)).map((annotation,index)=>{
    const[x1,y1,x2,y2]=viewport.convertToViewportRectangle(annotation.rect);
    return{id:`${pageNumber}:${annotation.id||index}`,url:getWebUrl(annotation.url||""),dest:annotation.dest,title:annotation.title||annotation.contents||"",left:Math.min(x1,x2),top:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)}
   }).filter(annotation=>annotation.url||annotation.dest));
   const textDivs=[];
   textTask=pdfjs.renderTextLayer({textContent,container:textLayer,viewport,textDivs});
   await Promise.all([renderTask.promise,textTask.promise]);
   if(cancelled)return;
   onRenderComplete(pageNumber);
   const matches=new Set(searchMatches);
   textDivs.forEach((element,index)=>{
    if(matches.has(index))element.classList.add("pdf-search-match");
    if(activeSearchMatch===index)element.classList.add("pdf-search-active")
   })
  }).catch(error=>{
   if(!cancelled&&error?.name!=="RenderingCancelledException")onError(error instanceof Error?error.message:"Unable to render a PDF page.")
  });
  return()=>{
   cancelled=true;
   renderTask?.cancel();
   textTask?.cancel?.();
   if(canvas){canvas.width=0;canvas.height=0}
   textLayer.replaceChildren()
  }
 },[pdfjs,pdfDocument,pageNumber,nearViewport,width,zoom,rotation,searchMatches,activeSearchMatch,onTextContent,onError,onOpenExternalLink,onNavigateToDestination,forceRender,onRenderComplete]);
 return <div ref={element=>{pageRef.current=element;registerPage(pageNumber-1,element)}} className="pdf-document-page" style={{aspectRatio,width:Math.max(240,forceRender?Math.min(width*zoom,816):width*zoom)}} aria-label={`Page ${pageNumber}`}>
  <canvas ref={canvasRef}/>
  <div ref={textLayerRef} className="pdf-text-layer" aria-label={`Selectable text on page ${pageNumber}`}/>
  <div className="pdf-link-layer">{links.map(link=><a key={link.id} href={link.url||"#"} target={link.url?"_blank":undefined} rel={link.url?"noopener noreferrer":undefined} aria-label={link.title||"Open PDF link"} title={link.title||link.url||"Go to linked page"} style={{left:link.left,top:link.top,width:link.width,height:link.height}} onClick={event=>{event.preventDefault();if(link.url)void onOpenExternalLink(link.url);else void onNavigateToDestination(link.dest)}}/>)}</div>
 </div>
}

export default function PdfReader({url}){
 const readerRef=useRef(null),containerRef=useRef(null),sidebarRef=useRef(null),pageRefs=useRef([]),loadingTaskRef=useRef(null),textCacheRef=useRef(new Map()),panRef=useRef(null),searchInputRef=useRef(null),printPendingRef=useRef(false),printPageRef=useRef(0),printedPagesRef=useRef(new Set()),printTimeoutRef=useRef(null);
 const[pdfjs,setPdfjs]=useState(null),[pdfDocument,setPdfDocument]=useState(null),[outline,setOutline]=useState([]),[pageCount,setPageCount]=useState(0),[currentPage,setCurrentPage]=useState(1),[pageInput,setPageInput]=useState("1"),[pageWidth,setPageWidth]=useState(0),[zoom,setZoom]=useState(1),[fitMode,setFitMode]=useState("width"),[viewMode,setViewMode]=useState("single"),[rotation,setRotation]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(""),[sidebarOpen,setSidebarOpen]=useState(false),[sidebarTab,setSidebarTab]=useState("pages"),[searchOpen,setSearchOpen]=useState(false),[query,setQuery]=useState(""),[matches,setMatches]=useState([]),[activeMatch,setActiveMatch]=useState(-1),[searching,setSearching]=useState(false),[searchError,setSearchError]=useState(""),[panMode,setPanMode]=useState(false),[isFullscreen,setIsFullscreen]=useState(false);
 const[printPage,setPrintPage]=useState(0),[printedPages,setPrintedPages]=useState(()=>new Set());
 const stepZoom=useCallback(direction=>{
  setFitMode("custom");
  setZoom(value=>Math.max(minimumZoom,Math.min(maximumZoom,Math.round((value+direction*zoomStep)*100)/100)))
 },[]);
 const reportExternalLinkError=useCallback(message=>setSearchError(message),[]);
 const handleExternalLink=useCallback(async link=>{
  try{await openExternalUrl(link)}catch(linkError){reportExternalLinkError(linkError instanceof Error?linkError.message:"Unable to open the PDF link.")}
 },[reportExternalLinkError]);
 const pageStep=viewMode==="two"?2:1;
 const jumpToPage=useCallback((page,behavior="smooth")=>{
  const next=Math.max(1,Math.min(pageCount,Number(page)||1));
  setCurrentPage(next);setPageInput(String(next));
  pageRefs.current[next-1]?.scrollIntoView({behavior,block:"start"})
 },[pageCount]);
 const reportPageError=useCallback(message=>{
  setError(message);
  if(printPendingRef.current){
   printPendingRef.current=false;
   printPageRef.current=0;
   printedPagesRef.current=new Set();
   clearTimeout(printTimeoutRef.current);
   setPrintPage(0);
   setPrintedPages(new Set());
   setSearchError(`Printing stopped because a page could not be rendered: ${message}`)
  }
 },[]);
 const reportTextContent=useCallback((page,textContent)=>{
  const cache=textCacheRef.current;
  cache.delete(page);
  cache.set(page,textContent);
  while(cache.size>maxCachedTextPages)cache.delete(cache.keys().next().value)
 },[]);
 const getTextContent=useCallback(async pageNumber=>{
  const cache=textCacheRef.current,cached=cache.get(pageNumber);
  if(cached){cache.delete(pageNumber);cache.set(pageNumber,cached);return cached}
  const content=await pdfDocument.getPage(pageNumber).then(page=>page.getTextContent());
  reportTextContent(pageNumber,content);
  return content
 },[pdfDocument,reportTextContent]);
 const reportPrintedPage=useCallback(page=>{
  if(!printPendingRef.current||page!==printPageRef.current)return;
  const next=new Set(printedPagesRef.current);
  next.add(page);
  printedPagesRef.current=next;
  setPrintedPages(next);
  if(next.size>=pageCount){
   printPendingRef.current=false;
   clearTimeout(printTimeoutRef.current);
   requestAnimationFrame(()=>window.print())
  }else{
   printPageRef.current=page+1;
   setPrintPage(page+1)
  }
 },[pageCount]);
 const searchMatchesByPage=useMemo(()=>{const byPage=new Map();for(const match of matches){const items=byPage.get(match.page)||[];items.push(match.item);byPage.set(match.page,items)}return byPage},[matches]);
 const activeMatchForPage=activeMatch>=0?matches[activeMatch]:null;
 useEffect(()=>setPageInput(String(currentPage)),[currentPage]);
 useEffect(()=>{
  let cancelled=false;
  textCacheRef.current.clear();
  pageRefs.current=[];
  setPdfDocument(null);setPdfjs(null);setOutline([]);setPageCount(0);setCurrentPage(1);setLoading(true);setError("");setRotation(0);setQuery("");setMatches([]);setActiveMatch(-1);setSearchError("");
  (async()=>{
   try{
    const runtime=await loadPdfJs();
    if(cancelled)return;
    const task=runtime.getDocument({url,cMapUrl:"/dflip/js/libs/cmaps/",cMapPacked:true});
    loadingTaskRef.current=task;
    const loaded=await task.promise;
    if(cancelled){await loaded.destroy();return}
    setPdfjs(runtime);setPdfDocument(loaded);setPageCount(loaded.numPages);
    try{setOutline(await loaded.getOutline()||[])}catch{setOutline([])}
   }catch(loadError){
    if(!cancelled)setError(loadError instanceof Error?loadError.message:"The PDF could not be opened.")
   }finally{if(!cancelled)setLoading(false)}
  })();
  return()=>{
   cancelled=true;
   if(loadingTaskRef.current){const task=loadingTaskRef.current;loadingTaskRef.current=null;void task.destroy().catch(()=>{})}
  }
 },[url]);
 useEffect(()=>{
  const container=containerRef.current;
  if(!container)return;
  const updateWidth=()=>setPageWidth(Math.max(240,viewMode==="two"?(container.clientWidth-54)/2:container.clientWidth-48));
  updateWidth();
  if(typeof ResizeObserver==="undefined"){window.addEventListener("resize",updateWidth);return()=>window.removeEventListener("resize",updateWidth)}
  const observer=new ResizeObserver(updateWidth);observer.observe(container);return()=>observer.disconnect()
 },[sidebarOpen,viewMode]);
 useEffect(()=>{
  const container=containerRef.current;
  if(!container||!pdfDocument)return;
  let frame=0;
  const updateCurrentPage=()=>{
   const marker=container.getBoundingClientRect().top+Math.min(96,container.clientHeight*.2);
   let nearestPage=1,nearestDistance=Infinity;
   for(let index=0;index<pageCount;index++){
    const page=pageRefs.current[index];
    if(!page)continue;
    const bounds=page.getBoundingClientRect(),distance=marker<bounds.top?bounds.top-marker:marker>bounds.bottom?marker-bounds.bottom:0;
    if(distance<nearestDistance){nearestPage=index+1;nearestDistance=distance}
   }
   setCurrentPage(nearestPage)
  };
  const handleScroll=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(updateCurrentPage)};
  container.addEventListener("scroll",handleScroll,{passive:true});updateCurrentPage();
  return()=>{container.removeEventListener("scroll",handleScroll);cancelAnimationFrame(frame)}
 },[pdfDocument,pageCount]);
 useEffect(()=>{
  const handleFullscreen=()=>setIsFullscreen(document.fullscreenElement===readerRef.current);
  document.addEventListener("fullscreenchange",handleFullscreen);
  return()=>document.removeEventListener("fullscreenchange",handleFullscreen)
 },[]);
 useEffect(()=>{
  const resetPrint=()=>{
   printPendingRef.current=false;
   printPageRef.current=0;
   printedPagesRef.current=new Set();
   clearTimeout(printTimeoutRef.current);
   setPrintPage(0);
   setPrintedPages(new Set())
  };
  window.addEventListener("afterprint",resetPrint);
  return()=>{window.removeEventListener("afterprint",resetPrint);clearTimeout(printTimeoutRef.current)}
 },[]);
 useEffect(()=>{
  const handleKeyDown=event=>{
   if(event.altKey)return;
   if(event.key==="Escape"&&searchOpen){setSearchOpen(false);setSearchError("");return}
   if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="f"){event.preventDefault();setSearchOpen(true);requestAnimationFrame(()=>searchInputRef.current?.focus());return}
   const target=event.target;
   if(target instanceof HTMLElement&&target.closest("input,textarea,select,[contenteditable='true'],.pdf-reader-search"))return;
   if((event.ctrlKey||event.metaKey)&&(event.key==="+"||event.key==="=")){event.preventDefault();stepZoom(1)}
   if((event.ctrlKey||event.metaKey)&&event.key==="-"){event.preventDefault();stepZoom(-1)}
   if(!event.ctrlKey&&!event.metaKey&&event.key==="ArrowLeft"){event.preventDefault();jumpToPage(currentPage-pageStep)}
   if(!event.ctrlKey&&!event.metaKey&&event.key==="ArrowRight"){event.preventDefault();jumpToPage(currentPage+pageStep)}
  };
  window.addEventListener("keydown",handleKeyDown);
  return()=>window.removeEventListener("keydown",handleKeyDown)
 },[searchOpen,stepZoom,currentPage,pageStep,jumpToPage]);
 const changeZoom=value=>{setZoom(Math.max(minimumZoom,Math.min(maximumZoom,Number(value))));setFitMode("custom")};
 const fitPage=async()=>{
  if(!pdfDocument||!containerRef.current)return;
  try{
   const page=await pdfDocument.getPage(currentPage),viewport=page.getViewport({scale:1,rotation});
   const availableWidth=Math.max(240,containerRef.current.clientWidth-48),availableHeight=Math.max(240,containerRef.current.clientHeight-48);
   setZoom(Math.max(minimumZoom,Math.min(maximumZoom,Math.min(availableWidth/viewport.width,availableHeight/viewport.height))));
   setFitMode("page")
  }catch(renderError){setError(renderError instanceof Error?renderError.message:"Unable to fit the PDF page to the window.")}
 };
 const searchDocument=async()=>{
  const needle=query.trim().toLocaleLowerCase();
  if(!pdfDocument||!needle)return;
  setSearching(true);setSearchError("");setMatches([]);setActiveMatch(-1);
  try{
   const found=[];
   for(let start=1;start<=pageCount;start+=8){
    const pages=Array.from({length:Math.min(8,pageCount-start+1)},(_,index)=>start+index);
    const textContents=await Promise.all(pages.map(getTextContent));
    pages.forEach((pageNumber,pageIndex)=>{
     const content=textContents[pageIndex];
     content.items.forEach((item,itemIndex)=>{
      if(typeof item.str==="string"&&item.str.toLocaleLowerCase().includes(needle))found.push({page:pageNumber,item:itemIndex})
     })
    })
   }
   setMatches(found);
   if(found.length){setActiveMatch(0);jumpToPage(found[0].page)}
   else setSearchError("No matching text was found.")
  }catch(searchFailure){setSearchError(searchFailure instanceof Error?searchFailure.message:"The PDF could not be searched.")}
  finally{setSearching(false)}
 };
 const moveSearchMatch=direction=>{
  if(!matches.length)return;
  const next=(activeMatch+direction+matches.length)%matches.length;
  setActiveMatch(next);jumpToPage(matches[next].page)
 };
 const selectOutlineItem=async item=>{
  try{
   const destination=typeof item.dest==="string"?await pdfDocument.getDestination(item.dest):item.dest;
   if(!Array.isArray(destination)||!destination[0])throw new Error("This outline item has no valid page destination.");
   const page=await pdfDocument.getPageIndex(destination[0]);
   jumpToPage(page+1)
  }catch(navigationError){setSearchError(navigationError instanceof Error?navigationError.message:"Unable to open this PDF section.")}
 };
 const selectPdfDestination=useCallback(async destination=>{
  try{
   const resolved=typeof destination==="string"?await pdfDocument.getDestination(destination):destination;
   if(!Array.isArray(resolved)||!resolved[0])throw new Error("This PDF link has no valid page destination.");
   jumpToPage((await pdfDocument.getPageIndex(resolved[0]))+1)
  }catch(navigationError){setSearchError(navigationError instanceof Error?navigationError.message:"Unable to follow this PDF link.")}
 },[pdfDocument,jumpToPage]);
 const panStart=event=>{
  if(!panMode||event.button!==0||event.target.closest("button"))return;
  panRef.current={x:event.clientX,y:event.clientY,left:containerRef.current.scrollLeft,top:containerRef.current.scrollTop};
  event.currentTarget.setPointerCapture?.(event.pointerId)
 };
 const panMove=event=>{
  const start=panRef.current,container=containerRef.current;
  if(!start||!container)return;
  container.scrollLeft=start.left-(event.clientX-start.x);
  container.scrollTop=start.top-(event.clientY-start.y)
 };
 const panEnd=()=>{panRef.current=null};
 const toggleFullscreen=async()=>{
  try{
   if(document.fullscreenElement)await document.exitFullscreen();
   else await readerRef.current?.requestFullscreen()
  }catch(fullscreenError){setSearchError(fullscreenError instanceof Error?fullscreenError.message:"Fullscreen mode is not available.")}
 };
 const printDocument=()=>{
  if(!pdfDocument||loading||error)return;
  printPendingRef.current=true;
  printPageRef.current=1;
  printedPagesRef.current=new Set();
  setPrintedPages(new Set());
  setPrintPage(1);
  setSearchError("");
  clearTimeout(printTimeoutRef.current);
  printTimeoutRef.current=setTimeout(()=>{
   if(!printPendingRef.current)return;
   printPendingRef.current=false;
   printPageRef.current=0;
   printedPagesRef.current=new Set();
   setPrintPage(0);
   setPrintedPages(new Set());
   setSearchError("Printing could not prepare every page. Please try again.")
  },30000)
 };
 return <div ref={readerRef} className={`pdf-reader-shell ${sidebarOpen?"sidebar-open":""} ${panMode?"pan-mode":""}`} onClick={event=>event.stopPropagation()}>
  <div className="pdf-reader-toolbar" role="toolbar" aria-label="PDF reader">
   <div className="pdf-reader-tool-group">
    <button type="button" className={`pdf-reader-tool ${sidebarOpen?"selected":""}`} aria-label={sidebarOpen?"Hide sidebar":"Show sidebar"} title="Thumbnails and outline" onClick={()=>setSidebarOpen(value=>!value)}><List/></button>
    <button type="button" className={`pdf-reader-tool ${searchOpen?"selected":""}`} aria-label="Find in document" title="Find in document (Ctrl+F)" onClick={()=>{setSearchOpen(value=>!value);requestAnimationFrame(()=>searchInputRef.current?.focus())}}><Search/></button>
     <button type="button" className={`pdf-reader-tool ${viewMode==="two"?"selected":""}`} aria-label={viewMode==="two"?"Switch to single-page view":"Switch to two-page view"} title="Two-page view" aria-pressed={viewMode==="two"} onClick={()=>setViewMode(value=>value==="two"?"single":"two")}><BookOpen/></button>
   </div>
   <div className="pdf-reader-tool-group pdf-reader-page-controls">
    <button type="button" className="pdf-reader-tool" aria-label="Previous page" title="Previous page" disabled={loading||!!error||currentPage<=1} onClick={()=>jumpToPage(currentPage-pageStep)}><ChevronLeft/></button>
    <label className="pdf-reader-page-input"><input aria-label="Current page" type="number" min="1" max={pageCount||1} disabled={loading||!!error} value={pageInput} onChange={event=>setPageInput(event.target.value)} onFocus={event=>event.target.select()} onBlur={()=>jumpToPage(pageInput)} onKeyDown={event=>{if(event.key==="Enter"){event.preventDefault();jumpToPage(pageInput);event.currentTarget.blur()}}}/><span>of {pageCount||"—"}</span></label>
    <button type="button" className="pdf-reader-tool" aria-label="Next page" title="Next page" disabled={loading||!!error||currentPage+pageStep>pageCount} onClick={()=>jumpToPage(currentPage+pageStep)}><ChevronRight/></button>
   </div>
   <div className="pdf-reader-tool-group pdf-reader-zoom-controls">
    <button type="button" className="pdf-reader-tool" aria-label="Zoom out" title="Zoom out by 5%" disabled={zoom<=minimumZoom} onClick={()=>stepZoom(-1)}><ZoomOut/></button>
    <select aria-label="Zoom level" value={fitMode==="page"?"fit-page":fitMode==="width"?"fit-width":zoom.toFixed(2)} onChange={event=>event.target.value==="fit-page"?void fitPage():event.target.value==="fit-width"?(setFitMode("width"),setZoom(1)):changeZoom(event.target.value)}>
     <option value="fit-page">Fit page</option><option value="fit-width">Fit width</option>{fitMode==="custom"&&!zoomPresets.some(value=>Math.abs(value-zoom)<.001)&&<option value={zoom.toFixed(2)}>{Math.round(zoom*100)}%</option>}{zoomPresets.map(value=><option key={value} value={value.toFixed(2)}>{Math.round(value*100)}%</option>)}
    </select>
    <button type="button" className="pdf-reader-tool" aria-label="Zoom in" title="Zoom in by 5%" disabled={zoom>=maximumZoom} onClick={()=>stepZoom(1)}><ZoomIn/></button>
   </div>
   <div className="pdf-reader-tool-group pdf-reader-tools-right">
    <button type="button" className={`pdf-reader-tool ${panMode?"selected":""}`} aria-label={panMode?"Enable text selection":"Enable hand tool"} title={panMode?"Enable text selection":"Hand tool"} onClick={()=>setPanMode(value=>!value)}>{panMode?<Hand/>:<MousePointer2/>}</button>
    <button type="button" className="pdf-reader-tool" aria-label="Rotate clockwise" title="Rotate clockwise" onClick={()=>setRotation(value=>(value+90)%360)}><RotateCw/></button>
    <button type="button" className="pdf-reader-tool" aria-label="Print PDF" title="Print PDF" onClick={printDocument}><Printer/></button>
    <button type="button" className="pdf-reader-tool" aria-label={isFullscreen?"Exit fullscreen":"Enter fullscreen"} title={isFullscreen?"Exit fullscreen":"Full screen"} onClick={()=>void toggleFullscreen()}><Maximize/></button>
   </div>
  </div>
  {searchOpen&&<form className="pdf-reader-search" role="search" onSubmit={event=>{event.preventDefault();void searchDocument()}}>
   <Search aria-hidden="true"/>
   <input ref={searchInputRef} aria-label="Find text in PDF" value={query} onChange={event=>setQuery(event.target.value)} placeholder="Find in document"/>
   <span className="pdf-search-count">{searching?"Searching…":matches.length?`${activeMatch+1} of ${matches.length}`:searchError}</span>
   <button type="button" className="pdf-reader-tool" aria-label="Previous match" disabled={!matches.length||searching} onClick={()=>moveSearchMatch(-1)}><ChevronLeft/></button>
   <button type="button" className="pdf-reader-tool" aria-label="Next match" disabled={!matches.length||searching} onClick={()=>moveSearchMatch(1)}><ChevronRight/></button>
   <button type="submit" className="pdf-reader-tool" aria-label="Search" disabled={searching||!query.trim()}><Search/></button>
   <button type="button" className="pdf-reader-tool" aria-label="Close search" onClick={()=>{setSearchOpen(false);setSearchError("")}}><X/></button>
  </form>}
  <div className="pdf-reader-workspace">
   {sidebarOpen&&<aside className="pdf-reader-sidebar" aria-label="PDF navigation">
    <div className="pdf-sidebar-tabs" role="tablist" aria-label="PDF navigation panels">
     <button type="button" role="tab" aria-selected={sidebarTab==="pages"} className={sidebarTab==="pages"?"active":""} onClick={()=>setSidebarTab("pages")}>Pages</button>
     <button type="button" role="tab" aria-selected={sidebarTab==="outline"} className={sidebarTab==="outline"?"active":""} onClick={()=>setSidebarTab("outline")}>Outline</button>
    </div>
    {sidebarTab==="pages"?<div ref={sidebarRef} className="pdf-thumbnail-list" role="tabpanel">{pdfDocument&&Array.from({length:pageCount},(_,index)=><PdfPageThumbnail key={index+1} pdfDocument={pdfDocument} pageNumber={index+1} active={currentPage===index+1} root={sidebarRef.current} onSelect={()=>jumpToPage(index+1)}/>)}</div>
    :<div className="pdf-outline-panel" role="tabpanel">{outline.length?<ul>{outline.map((item,index)=><PdfOutlineItem key={`${item.title}:${index}`} item={item} pdfDocument={pdfDocument} onSelect={selectOutlineItem}/>)}</ul>:<p>{loading?"Loading outline…":"This document has no outline."}</p>}</div>}
   </aside>}
   <div ref={containerRef} className="pdf-reader-scroll" onPointerDown={panStart} onPointerMove={panMove} onPointerUp={panEnd} onPointerCancel={panEnd}>
    {error?<div className="pdf-standard-message" role="alert">{error}<p>Download the file to open it with another PDF viewer.</p></div>
    :loading?<div className="pdf-standard-message" role="status"><span className="pdf-reader-spinner"/><strong>Opening document…</strong><p>Preparing pages and searchable text.</p></div>
    :<div className={`pdf-document-pages ${viewMode==="two"?"two-page-view":""}`}>{Array.from({length:pageCount},(_,index)=><PdfDocumentPage key={`${url}:${index+1}`} pdfjs={pdfjs} pdfDocument={pdfDocument} pageNumber={index+1} container={containerRef.current} width={pageWidth} zoom={zoom} rotation={rotation} searchMatches={searchMatchesByPage.get(index+1)||noSearchMatches} activeSearchMatch={activeMatchForPage?.page===index+1?activeMatchForPage.item:-1} registerPage={(page,element)=>{pageRefs.current[page]=element}} onTextContent={reportTextContent} onError={reportPageError} onOpenExternalLink={handleExternalLink} onNavigateToDestination={selectPdfDestination} forceRender={printedPages.has(index+1)||printPage===index+1} onRenderComplete={reportPrintedPage}/>)}</div>}
   </div>
  </div>
  <div className="pdf-reader-status" role="status"><span>{pdfDocument?`${pageCount} pages`:"PDF document"}</span><span>{panMode?"Hand tool · drag to pan":"Text selection enabled"}</span><span>{rotation?`${rotation}° rotation`:""}</span><span>{searchError}</span></div>
 </div>
}
