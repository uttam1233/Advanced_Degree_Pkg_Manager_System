const imageMimeTypes=["image/png","image/jpeg","image/gif","image/webp"];

function isRecord(value){
 return value!==null&&typeof value==="object"&&!Array.isArray(value);
}

function notebookText(value){
 if(typeof value==="string")return value;
 return Array.isArray(value)&&value.every(part=>typeof part==="string")?value.join(""):"";
}

function importAttachments(source,attachments){
 if(!isRecord(attachments))return source;
 return source.replace(/(!\[[^\]]*\]\s*\(\s*)attachment:([^)\s]+)(\s*\))/g,(original,prefix,name,suffix)=>{
  let attachmentName=name;
  try{attachmentName=decodeURIComponent(name)}catch{}
  const attachment=attachments[attachmentName];
  if(!isRecord(attachment))return original;
  const mime=imageMimeTypes.find(type=>typeof attachment[type]==="string"||Array.isArray(attachment[type]));
  if(!mime)return original;
  const data=notebookText(attachment[mime]).replace(/\s/g,"");
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(data))return original;
  return`${prefix}data:${mime};base64,${data}${suffix}`;
 });
}

function importOutput(output){
 if(!isRecord(output))return null;
 if(output.output_type==="stream")return{type:"stream",name:typeof output.name==="string"?output.name:"stdout",text:notebookText(output.text)};
 if(output.output_type==="error")return{type:"error",ename:typeof output.ename==="string"?output.ename:"Error",evalue:typeof output.evalue==="string"?output.evalue:"",traceback:Array.isArray(output.traceback)?output.traceback.filter(line=>typeof line==="string"):[]};
 if(output.output_type==="execute_result"||output.output_type==="display_data"){
  return{type:output.output_type,executionCount:Number.isInteger(output.execution_count)?output.execution_count:null,data:isRecord(output.data)?output.data:{},metadata:isRecord(output.metadata)?output.metadata:{}};
 }
 return null;
}

function normalizeNotebook(input){
 if(input.nbformat===4&&Array.isArray(input.cells))return input;
 if(input.nbformat!==3||!Array.isArray(input.worksheets))throw new Error("This file is not a supported Jupyter Notebook format v3 or v4 file.");
 const cells=input.worksheets.flatMap(worksheet=>Array.isArray(worksheet?.cells)?worksheet.cells:[]);
 return{
  ...input,
  nbformat:4,
  cells:cells.map(cell=>{
   const cellType=cell.cell_type==="heading"?"markdown":cell.cell_type;
   const source=cell.cell_type==="code"?cell.input:cell.source;
   return{
    ...cell,
    cell_type:cellType,
    source:cell.cell_type==="heading"?`${"#".repeat(Math.max(1,Math.min(6,Number(cell.level)||1)))} ${notebookText(source)}`:source,
    execution_count:cell.execution_count??cell.prompt_number??null,
    outputs:Array.isArray(cell.outputs)?cell.outputs.map(output=>output?.output_type==="pyout"?{...output,output_type:"execute_result",execution_count:output.prompt_number}:output?.output_type==="pyerr"?{...output,output_type:"error",evalue:notebookText(output.traceback)}:output):[]
   };
  })
 };
}

export function importIpynbNotebook(contents){
 let input;
 try{input=JSON.parse(contents)}
 catch{throw new Error("This .ipynb file is not valid JSON.")}
 if(!isRecord(input))throw new Error("This file is not a supported Jupyter Notebook format v3 or v4 file.");
 input=normalizeNotebook(input);

 const usedIds=new Set();
 const cells=input.cells.map((cell,index)=>{
  if(!isRecord(cell)||!["code","markdown","raw"].includes(cell.cell_type))throw new Error(`Notebook cell ${index+1} has an unsupported format.`);
  const originalId=typeof cell.id==="string"&&/^[A-Za-z0-9_-]{1,64}$/.test(cell.id)?cell.id:"";
  const createId=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let id=originalId&&!usedIds.has(originalId)?originalId:createId();
  while(usedIds.has(id))id=createId();
  usedIds.add(id);
  const source=notebookText(cell.source);
  const outputs=cell.cell_type==="code"&&Array.isArray(cell.outputs)?cell.outputs.map(importOutput).filter(Boolean):[];
  outputs.forEach(output=>{
   for(const type of [...imageMimeTypes,"text/html","text/plain","text/latex"]){
    if(Array.isArray(output.data?.[type])&&output.data[type].every(part=>typeof part==="string"))output.data[type]=output.data[type].join("");
   }
  });
  return{
   id,
   cell_type:cell.cell_type==="code"?"code":"markdown",
   source:cell.cell_type==="markdown"?importAttachments(source,cell.attachments):source,
   outputs,
   execution_count:cell.cell_type==="code"&&Number.isInteger(cell.execution_count)?cell.execution_count:null,
   metadata:isRecord(cell.metadata)?cell.metadata:{},
   rendered:cell.cell_type==="markdown"
  };
 });

 const metadata=isRecord(input.metadata)?input.metadata:{};
 const kernelName=isRecord(metadata.kernelspec)&&typeof metadata.kernelspec.name==="string"?metadata.kernelspec.name:"";
 return{cells,metadata,kernelName};
}
