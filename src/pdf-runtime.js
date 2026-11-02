const assetRoot="/dflip/";
let pdfRuntimePromise=null;

function loadScript(src){
 return new Promise((resolve,reject)=>{
  const script=document.createElement("script");
  script.src=src;
  script.onload=resolve;
  script.onerror=()=>reject(new Error("The PDF reader could not be loaded."));
  document.head.appendChild(script)
 })
}

export async function loadPdfJs(){
 if(window.pdfjsLib?.getDocument&&window.pdfjsLib?.renderTextLayer)return window.pdfjsLib;
 if(!pdfRuntimePromise)pdfRuntimePromise=(async()=>{
  await loadScript(`${assetRoot}js/libs/pdf.min.js`);
  const pdfjs=window.pdfjsLib;
  if(!pdfjs?.getDocument||!pdfjs?.renderTextLayer)throw new Error("The bundled PDF reader is missing text-layer support.");
  pdfjs.GlobalWorkerOptions.workerSrc=`${assetRoot}js/libs/pdf.worker.min.js`;
  return pdfjs
 })();
 try{return await pdfRuntimePromise}catch(error){pdfRuntimePromise=null;throw error}
}
