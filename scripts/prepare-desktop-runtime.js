import {copyFileSync, mkdirSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const projectDirectory=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const runtimeDirectory=resolve(projectDirectory,"src-tauri","runtime");
const nodeExecutable=resolve(runtimeDirectory,"node.exe");

if(process.platform!=="win32"||process.arch!=="x64"){
 throw new Error("The Windows desktop app currently requires a 64-bit Windows build environment.");
}

if(Number(process.versions.node.split(".")[0])<22){
 throw new Error("The Windows desktop app requires Node.js 22 or newer to build.");
}

mkdirSync(runtimeDirectory,{recursive:true});
copyFileSync(process.execPath,nodeExecutable);
console.log(`Prepared bundled Node.js runtime at ${nodeExecutable}`);
