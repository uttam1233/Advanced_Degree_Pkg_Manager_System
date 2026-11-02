import {dirname,join,resolve} from "node:path";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function notebookWorkspacePath(rootDirectory,sessionId,notebookId){
 if(!uuidPattern.test(sessionId)||!uuidPattern.test(notebookId))throw new Error("Notebook workspace ids must be valid UUIDs.");
 return resolve(rootDirectory,sessionId,"notebooks",notebookId);
}

export function isValidNotebookFileName(fileName){
 return typeof fileName==="string"&&fileName.toLowerCase().endsWith(".ipynb");
}

export function findAlacrittyWithNotebook(candidates,exists){
 return candidates.find(path=>exists(path)&&exists(join(dirname(path),"alacritty-notebook.exe")));
}

export function createJupyterRuntime({jupyterPath,pythonPath,kernels}){
 if(typeof jupyterPath!=="string"||!jupyterPath.trim())throw new Error("The Jupyter executable path is unavailable.");
 if(typeof pythonPath!=="string"||!pythonPath.trim())throw new Error("The Jupyter Python executable path is unavailable.");
 if(!Array.isArray(kernels))throw new Error("The Jupyter kernel list is invalid.");
 return{jupyterPath,pythonPath,kernels};
}

export function buildNotebookTerminalCommand(executablePath,notebookPath){
 if(typeof executablePath!=="string"||!executablePath.trim())throw new Error("The Alacritty notebook executable path is unavailable.");
 if(!isValidNotebookFileName(notebookPath))throw new Error("Choose a valid notebook filename ending in .ipynb.");
 const quote=value=>`'${value.replace(/'/g,"''")}'`;
 return`& ${quote(executablePath)} ${quote(notebookPath)}`;
}
