import {useMemo, useState} from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

const LATEX_SAMPLE = String.raw`\documentclass{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,graphicx}
\begin{document}

\title{Study Notes}
\author{Degree Study Manager}
\date{\today}
\maketitle

\section*{Core Formula}
The quadratic formula is
\[
 x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
\]

The Einstein relation is
\[
 E = mc^2
\]

\section*{Key Ideas}
\begin{itemize}
  \item Plan the workflow before solving.
  \item Verify each calculation carefully.
  \item Check the final answer with units.
\end{itemize}

\textbf{Example:} The derivative of $x^2$ is $2x$.

\[
 \int_0^1 x^2 \, dx = \frac{1}{3}
\]

\end{document}`;

function escapeHtml(value) {
 return value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");
}

function renderLatexMarkup(source) {
 let working = source;
 const replacements = [];
 const register = html => {
  const token = `__LATEX_MATH_${replacements.length}__`;
  replacements.push(html);
  return token;
 };

 working = working.replace(/\\\[([\s\S]*?)\\\]/g, (_, body) => register(katex.renderToString(body.trim(), {displayMode: true, throwOnError: false, strict: false})));
 working = working.replace(/\$\$([\s\S]*?)\$\$/g, (_, body) => register(katex.renderToString(body.trim(), {displayMode: true, throwOnError: false, strict: false})));
 working = working.replace(/\\\(([\s\S]*?)\\\)/g, (_, body) => register(katex.renderToString(body.trim(), {displayMode: false, throwOnError: false, strict: false})));
 working = working.replace(/\$([^$\n]+)\$/g, (_, body) => register(katex.renderToString(body.trim(), {displayMode: false, throwOnError: false, strict: false})));

 working = working.replace(/\\begin\{(equation\*?|align\*?|alignat\*?|gather\*?|multline\*?|matrix|pmatrix|bmatrix|vmatrix|cases)\}([\s\S]*?)\\end\{\1\}/g, (_, env, body) => register(katex.renderToString(body.trim(), {displayMode: true, throwOnError: false, strict: false})));
 working = working.replace(/\\begin\{center\}([\s\S]*?)\\end\{center\}/g, (_, body) => `<div class="latex-center">${body}</div>`);
 working = working.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (_, body) => {
  const items = body.split(/\\item\s*/).filter(Boolean).map(item => `<li>${item.trim()}</li>`).join("");
  return `<ul>${items}</ul>`;
 });
 working = working.replace(/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g, (_, body) => {
  const items = body.split(/\\item\s*/).filter(Boolean).map(item => `<li>${item.trim()}</li>`).join("");
  return `<ol>${items}</ol>`;
 });

 working = escapeHtml(working);
 working = working.replace(/__LATEX_MATH_(\d+)__/g, (_, index) => replacements[Number(index)] || "");
 working = working.replace(/\\section\*?\{([^}]+)\}/g, "<h2>$1</h2>");
 working = working.replace(/\\subsection\*?\{([^}]+)\}/g, "<h3>$1</h3>");
 working = working.replace(/\\subsubsection\*?\{([^}]+)\}/g, "<h4>$1</h4>");
 working = working.replace(/\\textbf\{([^}]+)\}/g, "<strong>$1</strong>");
 working = working.replace(/\\textit\{([^}]+)\}/g, "<em>$1</em>");
 working = working.replace(/\\emph\{([^}]+)\}/g, "<em>$1</em>");
 working = working.replace(/\\texttt\{([^}]+)\}/g, "<code>$1</code>");
 working = working.replace(/\\\s*\\n/g, "<br/>");
 working = working.replace(/\\newline/g, "<br/>");
 working = working.replace(/\\\\/g, "<br/>");
 working = working.replace(/\n{2,}/g, "</p><p>");
 working = working.replace(/^(.*)$/gm, (line) => { 
  if(!line.trim())return "";
  if(line.startsWith("<h")||line.startsWith("<ul>")||line.startsWith("<ol>")||line.startsWith("<div")||line.startsWith("<p>")||line.startsWith("<br")||line.startsWith("<li>"))return line;
  return `<p>${line}</p>`;
 });
 working = working.replace(/<p><h2>/g, "<h2>");
 working = working.replace(/<\/h2><\/p>/g, "</h2>");
 working = working.replace(/<p><h3>/g, "<h3>");
 working = working.replace(/<\/h3><\/p>/g, "</h3>");
 working = working.replace(/<p><h4>/g, "<h4>");
 working = working.replace(/<\/h4><\/p>/g, "</h4>");
 working = working.replace(/<p><ul>/g, "<ul>");
 working = working.replace(/<\/ul><\/p>/g, "</ul>");
 working = working.replace(/<p><ol>/g, "<ol>");
 working = working.replace(/<\/ol><\/p>/g, "</ol>");
 working = working.replace(/<p><div class="latex-center">/g, "<div class=\"latex-center\">");
 working = working.replace(/<\/div><\/p>/g, "</div>");
 working = working.replace(/\n/g, "");
 return working.trim() || "<p>Start typing LaTeX to render a preview.</p>";
}

export default function LatexEditor({close}) {
 const [source, setSource] = useState(LATEX_SAMPLE);
 const [fontScale, setFontScale] = useState(1);
 const previewHtml = useMemo(() => renderLatexMarkup(source), [source]);

 const insertTemplate = (template) => {
  const blocks = {
   section: "\\section{New section}\n",
   subsection: "\\subsection{New subsection}\n",
   equation: "\\[\n  a^2 + b^2 = c^2\n\\]\n",
   itemize: "\\begin{itemize}\n  \\item First point\n  \\item Second point\n\\end{itemize}\n",
   matrix: "\\[\n\\begin{pmatrix}\n a & b \\\\\n c & d\n\\end{pmatrix}\n\\]\n",
   text: "\\textbf{Important:} \\emph{This is live LaTeX preview.}\n"
  };
  setSource(current => `${current}\n${blocks[template] || ""}`);
 };

 const copySource = async () => {
  try { await navigator.clipboard.writeText(source); } catch { /* ignore */ }
 };

 const downloadSource = () => {
  const blob = new Blob([source], {type: "text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "latex-notes.tex";
  link.click();
  URL.revokeObjectURL(url);
 };

 return (
  <div className="overlay">
   <div className="latex-editor-window dialog wide">
    <div className="section-head latex-header">
     <div>
      <small>Real-time LaTeX workspace</small>
      <h2>LaTeX preview editor</h2>
     </div>
     <div className="latex-actions">
      <button type="button" className="btn outline" onClick={()=>setSource(LATEX_SAMPLE)}>Reset sample</button>
      <button type="button" className="btn outline" onClick={copySource}>Copy code</button>
      <button type="button" className="btn outline" onClick={downloadSource}>Download .tex</button>
      <button type="button" className="btn ghost" onClick={close}>Close</button>
     </div>
    </div>
    <div className="latex-toolbar">
     <button type="button" className="btn outline" onClick={()=>insertTemplate("section")}>Section</button>
     <button type="button" className="btn outline" onClick={()=>insertTemplate("subsection")}>Subsection</button>
     <button type="button" className="btn outline" onClick={()=>insertTemplate("equation")}>Equation</button>
     <button type="button" className="btn outline" onClick={()=>insertTemplate("itemize")}>List</button>
     <button type="button" className="btn outline" onClick={()=>insertTemplate("matrix")}>Matrix</button>
     <button type="button" className="btn outline" onClick={()=>insertTemplate("text")}>Inline style</button>
     <label className="latex-scale">
      Scale
      <input type="range" min="0.8" max="1.5" step="0.05" value={fontScale} onChange={event=>setFontScale(Number(event.target.value))} />
     </label>
    </div>
    <div className="latex-editor-layout">
     <div className="latex-panel">
      <textarea
        className="control latex-editor"
        value={source}
        spellCheck={false}
        onChange={event => setSource(event.target.value)}
        aria-label="Latex source editor"
      />
     </div>
     <div className="latex-panel preview-panel" style={{fontSize: `${fontScale}rem`}}>
      <div className="latex-preview" dangerouslySetInnerHTML={{__html: previewHtml}} />
     </div>
    </div>
   </div>
  </div>
 );
}
