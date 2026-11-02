import assert from "node:assert/strict";
import test from "node:test";
import {importIpynbNotebook} from "../src/notebook-import.js";
import {renderNotebookMarkdown} from "../src/notebook-render.js";

test("imports notebook cells, kernel metadata, execution counts, and outputs",()=>{
 const notebook=importIpynbNotebook(JSON.stringify({
  nbformat:4,
  metadata:{kernelspec:{name:"python3",display_name:"Python 3"},language_info:{name:"python"}},
  cells:[
   {id:"markdown-cell",cell_type:"markdown",metadata:{tags:["intro"]},source:["# Study notes\n","Ready"]},
   {id:"code-cell",cell_type:"code",metadata:{collapsed:false},execution_count:3,source:["print(1 + 1)"],outputs:[
    {output_type:"stream",name:"stdout",text:["2","\n"]},
    {output_type:"execute_result",execution_count:3,data:{"text/plain":"2"},metadata:{}},
    {output_type:"display_data",data:{"image/png":"aGVsbG8="},metadata:{width:10}},
    {output_type:"error",ename:"ValueError",evalue:"bad value",traceback:["ValueError: bad value"]}
   ]}
  ]
 }));
 assert.equal(notebook.kernelName,"python3");
 assert.equal(notebook.cells[0].source,"# Study notes\nReady");
 assert.deepEqual(notebook.cells[0].metadata,{tags:["intro"]});
 assert.equal(notebook.cells[1].source,"print(1 + 1)");
 assert.equal(notebook.cells[1].execution_count,3);
 assert.deepEqual(notebook.cells[1].outputs.map(output=>output.type),["stream","execute_result","display_data","error"]);
 assert.equal(notebook.cells[1].outputs[0].text,"2\n");
 assert.deepEqual(notebook.cells[1].outputs[2].data,{"image/png":"aGVsbG8="});
 assert.equal(notebook.cells[1].outputs[3].evalue,"bad value");
});

test("inlines embedded markdown image attachments for the app notebook renderer",()=>{
 const notebook=importIpynbNotebook(JSON.stringify({
  nbformat:4,
  cells:[{cell_type:"markdown",metadata:{},source:"![diagram](attachment:diagram.png)",attachments:{
   "diagram.png":{"image/png":["aGVs","bG8="]}
  }}]
 }));
 assert.equal(notebook.cells[0].source,"![diagram](data:image/png;base64,aGVsbG8=)");
});

test("imports attachment links split across source lines and joined base64 data",()=>{
 const notebook=importIpynbNotebook(JSON.stringify({
  nbformat:4,
  cells:[{cell_type:"markdown",metadata:{},source:["![diagram]\n","(attachment:diagram.png)"],attachments:{
   "diagram.png":{"image/png":["aGVs","bG8="]}
  }}]
 }));
 assert.equal(notebook.cells[0].source,"![diagram]\n(data:image/png;base64,aGVsbG8=)");
 assert.equal(notebook.cells[0].rendered,true);
});

test("renders common Jupyter Markdown, HTML, math, and wrapped inline images",()=>{
 const html=renderNotebookMarkdown([
  "# Study notes",
  "",
  "**Important** and `inline code`",
  "",
  "| Column | Value |",
  "| --- | ---: |",
  "| sample | 42 |",
  "",
  "$x^2$",
  "",
  "![image.png]",
  "(data:image/png;base64,",
  " YWJj",
  " ZA==",
  ")"
 ].join("\n"));
 assert.match(html,/<h1>Study notes<\/h1>/);
 assert.match(html,/<strong>Important<\/strong>/);
 assert.match(html,/<table>/);
 assert.match(html,/class="katex"/);
 assert.match(html,/<img src="data:image\/png;base64,YWJjZA==" alt="image\.png">/);
});

test("replaces invalid or duplicate cell ids with unique ids",()=>{
 const notebook=importIpynbNotebook(JSON.stringify({
  nbformat:4,
  cells:[
   {id:"same",cell_type:"code",source:"1",outputs:[]},
   {id:"same",cell_type:"code",source:"2",outputs:[]},
   {id:"not valid!",cell_type:"raw",source:"notes"}
  ]
 }));
 assert.equal(new Set(notebook.cells.map(cell=>cell.id)).size,3);
 assert.equal(notebook.cells[2].cell_type,"markdown");
});

test("imports legacy v3 worksheets into the same editable cell model",()=>{
 const notebook=importIpynbNotebook(JSON.stringify({
  nbformat:3,
  metadata:{},
  worksheets:[{cells:[
   {cell_type:"heading",level:2,source:"Course notes"},
   {cell_type:"code",input:"print('ready')",prompt_number:1,outputs:[
    {output_type:"pyout",prompt_number:1,data:{"text/plain":"ready"},metadata:{}}
   ]}
  ]}]
 }));
 assert.equal(notebook.cells[0].source,"## Course notes");
 assert.equal(notebook.cells[1].source,"print('ready')");
 assert.equal(notebook.cells[1].execution_count,1);
 assert.equal(notebook.cells[1].outputs[0].type,"execute_result");
});

test("reports invalid JSON, unsupported formats, and malformed cells",()=>{
 assert.throws(()=>importIpynbNotebook("{"),/not valid JSON/);
 assert.throws(()=>importIpynbNotebook('{"nbformat":2,"cells":[]}'),/format v3 or v4/);
 assert.throws(()=>importIpynbNotebook('{"nbformat":4,"cells":[{"cell_type":"unknown"}]}'),/cell 1/);
});
