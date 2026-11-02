import {useEffect,useRef,useState} from "react";
import {EditorState} from "@codemirror/state";
import {autocompletion,completionKeymap,closeBrackets,closeBracketsKeymap} from "@codemirror/autocomplete";
import {defaultKeymap,history,historyKeymap,indentWithTab,toggleComment} from "@codemirror/commands";
import {foldGutter,foldKeymap,indentOnInput,indentUnit,bracketMatching,syntaxHighlighting,defaultHighlightStyle,HighlightStyle} from "@codemirror/language";
import {python} from "@codemirror/lang-python";
import {forceLinting,lintGutter,linter} from "@codemirror/lint";
import {tags} from "@lezer/highlight";
import {Decoration,EditorView,keymap,lineNumbers,highlightActiveLine,highlightActiveLineGutter,highlightSpecialChars,drawSelection,dropCursor,ViewPlugin,hoverTooltip} from "@codemirror/view";
import {searchKeymap} from "@codemirror/search";

const pythonKeywords="and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ");
const pythonBuiltins="abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip".split(" ");
const pythonCompletions=[
 ...pythonKeywords.map(label=>({label,type:"keyword"})),
 ...pythonBuiltins.map(label=>({label,type:"function"})),
 ...["False","None","True","self"].map(label=>({label,type:"variable"}))
];

function codeUnitOffset(code,codePointOffset){
 if(!Number.isInteger(codePointOffset)||codePointOffset<0)return code.length;
 let offset=0;
 for(const character of code){
  if(codePointOffset--<=0)break;
  offset+=character.length
 }
 return offset
}

async function pythonCompletionSource(context,callbacks){
 const word=context.matchBefore(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.?/);
 if((!word||word.from===word.to)&&!context.explicit)return null;
 let cancelled=context.aborted;
 context.addEventListener("abort",()=>{cancelled=true},{onDocChange:true});
 try{
  const code=context.state.doc.toString();
  const result=await callbacks.current.onComplete?.(code,context.pos,()=>cancelled);
  if(cancelled)return null;
  const dynamicOptions=(result?.matches||[]).map(label=>{
   const typeInfo=result.metadata?.["_jupyter_types_experimental"]?.find(item=>item.text===label);
   const isAttribute=word?.text.includes(".");
   return{label,type:typeInfo?.type|| (isAttribute?"function":"variable")}
  });
  const from=result?codeUnitOffset(code,result.cursorStart):word?.from??context.pos;
  const to=result?codeUnitOffset(code,result.cursorEnd):context.pos;
  const safeFrom=Math.min(Math.max(0,from),context.pos);
  const safeTo=Math.max(safeFrom,Math.min(context.state.doc.length,to));
  return{
   from:safeFrom,
   to:safeTo,
   options:[...dynamicOptions,...pythonCompletions],
   validFor:/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\.?$/
  }
 }catch(error){
  if(!cancelled)callbacks.current.onCompletionError?.(error);
  return null
 }
}

const codeHighlight=syntaxHighlighting(HighlightStyle.define([
 {tag:tags.keyword,color:"var(--code-keyword)",fontWeight:"600"},
 {tag:tags.string,color:"var(--code-string)"},
 {tag:tags.comment,color:"var(--code-comment)",fontStyle:"italic"},
 {tag:tags.number,color:"var(--code-number)"},
 {tag:tags.bool,color:"var(--code-number)"},
 {tag:tags.null,color:"var(--code-number)"},
 {tag:tags.function(tags.variableName),color:"var(--code-function)"},
 {tag:tags.function(tags.propertyName),color:"var(--code-function)"},
 {tag:tags.propertyName,color:"var(--code-function)"},
 {tag:tags.definition(tags.variableName),color:"var(--code-function)"},
 {tag:tags.variableName,color:"var(--code-variable)"},
 {tag:tags.className,color:"var(--code-class)"},
 {tag:tags.operator,color:"var(--text)"},
 {tag:tags.punctuation,color:"var(--muted)"}
]));

function editorTheme(){
 return EditorView.theme({
  "&":{color:"var(--text)",backgroundColor:"var(--editor)",fontSize:"13px"},
  ".cm-content":{fontFamily:"ui-monospace, SFMono-Regular, Consolas, monospace",lineHeight:"1.6",padding:"4px 12px",caretColor:"var(--accent)"},
  ".cm-indent-guide":{backgroundImage:"repeating-linear-gradient(to right, transparent 0, transparent calc(4ch - 1px), color-mix(in srgb, var(--indent-guide) 24%, transparent) calc(4ch - 1px), color-mix(in srgb, var(--indent-guide) 24%, transparent) 4ch)"},
  ".cm-gutters":{backgroundColor:"var(--editor)",color:"var(--muted)",border:"0",borderRight:"1px solid var(--divider)"},
  ".cm-lineNumbers .cm-gutterElement":{minWidth:"3ch",padding:"0 9px 0 7px"},
  ".cm-activeLine":{backgroundColor:"color-mix(in srgb, var(--accent) 7%, transparent)"},
  ".cm-activeLineGutter":{backgroundColor:"color-mix(in srgb, var(--accent) 10%, transparent)",color:"var(--text)"},
  ".cm-cursor":{borderLeftColor:"var(--accent)"},
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground":{backgroundColor:"color-mix(in srgb, var(--accent) 25%, transparent)"},
  ".cm-matchingBracket,.cm-nonmatchingBracket":{backgroundColor:"transparent",color:"inherit",outline:"none",fontWeight:"inherit"},
  ".cm-tooltip":{border:"1px solid var(--border)",borderRadius:"7px",backgroundColor:"var(--panel)",color:"var(--text)"},
  ".cm-tooltip-autocomplete ul li[aria-selected]":{backgroundColor:"var(--accent)",color:"var(--accent-text)"},
  ".cm-scroller":{overflow:"auto"}
 },{dark:true})
}

const indentationGuides=ViewPlugin.fromClass(class{
 constructor(view){this.decorations=this.build(view)}
 update(update){if(update.docChanged||update.viewportChanged)this.decorations=this.build(update.view)}
 build(view){
  const ranges=[];
  for(const{from,to}of view.visibleRanges){
   let line=view.state.doc.lineAt(from);
   while(line.from<=to){
    const indentation=/^[\t ]+/.exec(line.text)?.[0];
    if(indentation)ranges.push(Decoration.mark({class:"cm-indent-guide"}).range(line.from,line.from+indentation.length));
    if(line.to>=to)break;
    line=view.state.doc.line(line.number+1)
   }
  }
  return Decoration.set(ranges)
 }
},{decorations:plugin=>plugin.decorations});

function dedentOnBackspace(view){
 const selection=view.state.selection.main;
 if(!selection.empty)return false;
 const line=view.state.doc.lineAt(selection.head),prefix=line.text.slice(0,selection.head-line.from);
 if(!prefix||!/^[\t ]+$/.test(prefix))return false;
 const targetWidth=Math.max(0,Math.floor((widthOf(prefix)-1)/4)*4);
 let width=0,from=line.from;
 for(const character of prefix){
  const next=character==="\t"?width+4-width%4:width+1;
  if(next>targetWidth)break;
  width=next;
  from+=character.length
 }
 view.dispatch({changes:{from,to:selection.head,insert:""},selection:{anchor:from}});
 return true
}

function widthOf(text){
 return [...text].reduce((width,character)=>character==="\t"?width+4-width%4:width+1,0)
}

export default function NotebookCodeEditor({value,onChange,onRun,onInspect,onHoverInspect,onComplete,onCompletionError,onValidate,onEditorView,kernelReady=false,language="python"}){
 const host=useRef(null),editorView=useRef(null),callbacks=useRef({onChange,onRun,onInspect,onHoverInspect,onComplete,onCompletionError,onValidate,onEditorView}),[position,setPosition]=useState({line:1,column:1,indent:0});
 callbacks.current={onChange,onRun,onInspect,onHoverInspect,onComplete,onCompletionError,onValidate,onEditorView};

 useEffect(()=>{
  if(!host.current)return;
  const isPython=language.toLowerCase().includes("python");
  const state=EditorState.create({
   doc:value,
   extensions:[
    lineNumbers(),
    foldGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    indentUnit.of("    "),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    EditorView.contentAttributes.of({"aria-label":`${language} code editor`,"spellcheck":"false"}),
    syntaxHighlighting(defaultHighlightStyle,{fallback:true}),
    codeHighlight,
    ...(isPython?[python(),autocompletion({activateOnTypingDelay:300,override:[context=>pythonCompletionSource(context,callbacks)]}),lintGutter(),linter(async view=>{
     try{return await callbacks.current.onValidate?.(view.state.doc.toString())||[]}
     catch(error){return[{from:0,to:Math.min(1,view.state.doc.length),severity:"error",source:"Python syntax",message:error instanceof Error?`Live syntax checking failed: ${error.message}`:"Live syntax checking failed."}]}
    },{delay:650}),hoverTooltip(async(view,pos)=>{
     const line=view.state.doc.lineAt(pos),tokens=[...line.text.matchAll(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/g)];
     const token=tokens.find(match=>pos>=line.from+(match.index||0)&&pos<=line.from+(match.index||0)+match[0].length);
     if(!token||!callbacks.current.onHoverInspect)return null;
     const from=line.from+(token.index||0),to=from+token[0].length;
     let inspection;
     try{inspection=await callbacks.current.onHoverInspect(view.state.doc.toString(),pos)}
     catch(error){inspection={found:true,text:`Documentation unavailable: ${error instanceof Error?error.message:"Unable to inspect this object."}`,error:true}}
     if(!inspection?.found||!inspection.text)return null;
     return{pos:from,end:to,create(){
      const dom=document.createElement("div"),pre=document.createElement("pre");
      dom.className=`cm-tooltip-jupyter-doc${inspection.error?" error":""}`;
      pre.textContent=inspection.text.slice(0,6000);
      dom.append(pre);
      return{dom}
     }}
    },{hoverTime:450,hideOnChange:true})]:[]),
    indentationGuides,
    editorTheme(),
    keymap.of([
     {key:"Mod-Enter",run:()=>{callbacks.current.onRun?.(false);return true}},
     {key:"Shift-Enter",run:()=>{callbacks.current.onRun?.(true);return true}},
     {key:"Mod-Shift-Space",run:()=>{callbacks.current.onInspect?.();return true}},
     {key:"Mod-/",run:toggleComment},
     {key:"Backspace",run:dedentOnBackspace},
     indentWithTab,
     ...closeBracketsKeymap,
     ...defaultKeymap,
     ...historyKeymap,
     ...foldKeymap,
     ...completionKeymap,
     ...searchKeymap
    ]),
    EditorView.updateListener.of(update=>{
     if(update.docChanged)callbacks.current.onChange?.(update.state.doc.toString());
     if(update.docChanged||update.selectionSet){
      const selection=update.state.selection.main,line=update.state.doc.lineAt(selection.head),leading=line.text.match(/^[\t ]*/)?.[0]||"";
      setPosition({line:line.number,column:selection.head-line.from+1,indent:Math.floor(widthOf(leading)/4)})
     }
    })
   ]
  });
  const view=new EditorView({state,parent:host.current});
  editorView.current=view;
  callbacks.current.onEditorView?.(view);
  return()=>{
   editorView.current=null;
   callbacks.current.onEditorView?.(null);
   view.destroy()
  }
 },[]);

 useEffect(()=>{if(kernelReady&&editorView.current)forceLinting(editorView.current)},[kernelReady]);

 return <div className="jupyter-code-editor">
  <div ref={host} aria-label="Python code editor"/>
  <div className="jupyter-editor-status" aria-live="polite"><span>Ln {position.line}, Col {position.column}</span><span>Indent {position.indent}</span><span>{language}</span><span className="jupyter-editor-shortcuts">Tab / Shift+Tab or Backspace to dedent · Ctrl+Space suggestions · Ctrl+Shift+Space docs · Shift+Enter runs and advances · Ctrl+Enter runs here</span></div>
 </div>
}
