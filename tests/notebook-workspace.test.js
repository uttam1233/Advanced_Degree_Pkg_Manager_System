import assert from "node:assert/strict";
import test from "node:test";
import {buildNotebookTerminalCommand,createJupyterRuntime,findAlacrittyWithNotebook,isValidNotebookFileName,notebookWorkspacePath} from "../notebook-workspace.js";

test("notebook workspaces are isolated by both syllabus and notebook id",()=>{
 const firstSession="11111111-1111-4111-8111-111111111111";
 const secondSession="22222222-2222-4222-8222-222222222222";
 const firstNotebook="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
 const secondNotebook="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const first=notebookWorkspacePath("C:\\app-data\\practice",firstSession,firstNotebook);
 assert.notEqual(first,notebookWorkspacePath("C:\\app-data\\practice",firstSession,secondNotebook));
 assert.notEqual(first,notebookWorkspacePath("C:\\app-data\\practice",secondSession,firstNotebook));
 assert.ok(first.endsWith("\\11111111-1111-4111-8111-111111111111\\notebooks\\aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
});

test("notebook workspace paths reject invalid ids",()=>{
 assert.throws(()=>notebookWorkspacePath("C:\\app-data\\practice","..","notebook"),/valid UUIDs/);
});

test("terminal export accepts notebook filenames only",()=>{
 assert.equal(isValidNotebookFileName("analysis.ipynb"),true);
 assert.equal(isValidNotebookFileName("analysis.IPYNB"),true);
 assert.equal(isValidNotebookFileName("image.png"),false);
 assert.equal(isValidNotebookFileName("notebook"),false);
});

test("launches the matching notebook executable directly with safely quoted paths",()=>{
 assert.equal(
  buildNotebookTerminalCommand("C:\\Program Files\\Alacritty\\alacritty-notebook.exe","C:\\notebooks\\My Notes.ipynb"),
  "& 'C:\\Program Files\\Alacritty\\alacritty-notebook.exe' 'C:\\notebooks\\My Notes.ipynb'"
 );
 assert.equal(
  buildNotebookTerminalCommand("C:\\User's Apps\\alacritty-notebook.exe","C:\\notebooks\\User's Notes.ipynb"),
  "& 'C:\\User''s Apps\\alacritty-notebook.exe' 'C:\\notebooks\\User''s Notes.ipynb'"
 );
 assert.throws(()=>buildNotebookTerminalCommand("C:\\Alacritty\\alacritty-notebook.exe","notes.txt"),/filename ending in \.ipynb/);
 assert.throws(()=>buildNotebookTerminalCommand("","notes.ipynb"),/executable path is unavailable/);
});

test("prefers an Alacritty executable only when its matching notebook companion exists",()=>{
 const system="C:\\Program Files\\Alacritty\\alacritty.exe";
 const local="C:\\Users\\User\\AppData\\Local\\DegreeStudyManager\\Alacritty\\alacritty.exe";
 const existing=new Set([system,local,`${local.slice(0,local.lastIndexOf("\\")+1)}alacritty-notebook.exe`]);
 assert.equal(findAlacrittyWithNotebook([local,system],path=>existing.has(path)),local);
 assert.equal(findAlacrittyWithNotebook([system],path=>existing.has(path)),undefined);
});

test("keeps the discovered Jupyter executable path in the cached runtime",()=>{
 const runtime=createJupyterRuntime({jupyterPath:"C:\\Python\\Scripts\\jupyter.exe",pythonPath:"C:\\Python\\python.exe",kernels:[{name:"python3"}]});
 assert.equal(runtime.jupyterPath,"C:\\Python\\Scripts\\jupyter.exe");
 assert.equal(runtime.pythonPath,"C:\\Python\\python.exe");
 assert.deepEqual(runtime.kernels,[{name:"python3"}]);
 assert.throws(()=>createJupyterRuntime({pythonPath:"C:\\Python\\python.exe",kernels:[]}),/Jupyter executable path is unavailable/);
});
