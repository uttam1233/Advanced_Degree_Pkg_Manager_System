import {marked} from "marked";
import katex from "katex";

marked.setOptions({gfm:true,breaks:false});
const firstIndex=(...indices)=>{const found=indices.filter(index=>index>=0);return found.length?Math.min(...found):undefined};
marked.use({extensions:[
 {
  name:"notebookMathBlock",
  level:"block",
  start(source){return firstIndex(source.indexOf("$$"),source.indexOf("\\["))},
  tokenizer(source){
   const match=/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/.exec(source);
   return match?{type:"notebookMathBlock",raw:match[0],text:(match[1]||match[2]).trim()}:undefined
  },
  renderer(token){return katex.renderToString(token.text,{displayMode:true,throwOnError:false,strict:false})}
 },
 {
  name:"notebookMathInline",
  level:"inline",
  start(source){return firstIndex(source.indexOf("$"),source.indexOf("\\("))},
  tokenizer(source){
   const match=/^(?:\$(?!\$)([^$\n]+?)\$(?!\$)|\\\(([\s\S]+?)\\\))/.exec(source);
   return match?{type:"notebookMathInline",raw:match[0],text:(match[1]||match[2]).trim()}:undefined
  },
  renderer(token){return katex.renderToString(token.text,{displayMode:false,throwOnError:false,strict:false})}
 }
]});

export function normalizeNotebookMarkdown(source){
 return source
  .replace(/(!\[[^\]]*\])\s*\(\s*(data:image\/(?:png|jpe?g|gif|webp);base64,)([\s\S]*?)\s*\)/gi,(_,image,dataPrefix,data)=>`${image}(${dataPrefix}${data.replace(/\s/g,"")})`)
  .replace(/(!\[[^\]]*\])\s*\n+\s*(?=\()/g,"$1");
}

export function renderNotebookMarkdown(source){
 return marked.parse(normalizeNotebookMarkdown(source));
}
