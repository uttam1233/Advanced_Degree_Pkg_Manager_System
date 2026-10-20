# Degree Study Manager - Full Local Version

This is the full locally runnable reconstruction of the Copilot Page.

## Run

1. Install Node.js 20.19 or newer.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the address printed by Vite, usually `http://localhost:5173`.
6. Keep the development server running while using the app.
<img src="https://github.com/uttam1233/Advanced_Degree_Pkg_Manager_System/blob/main/Screenshot%202026-10-21%20030906.png">
## Important

- Study data, uploaded files, and images inside notes are stored in a local SQLite database under the operating system's application data directory (on Windows, `%LOCALAPPDATA%\DegreeStudyManager\degree-study-manager.sqlite`).
- The SQLite database is stored on this computer and persists across browser and app restarts. It is not cloud-synced or shared across computers. Records remain until you delete them in the app or remove the database file.
- Existing browser-stored data is migrated to SQLite automatically when the app first connects to its database.
- To migrate data from an older browser session, open the development app at the same browser origin (same protocol, host, and port) where that data was stored. Browsers keep storage separate for different URLs.
- To run the production build locally, run `npm run build` and then `npm start`; the local server opens at `http://localhost:3001`.
- Use **Backup** to export the data as JSON and keep a separate copy in case the database file or computer is lost.
- Any file up to 100 MB can be attached to a syllabus item, including source code and Jupyter `.ipynb` notebooks. PDFs and images open in the in-app viewer; common text/code files up to 2 MB and notebooks up to 100 MB can be previewed there. Notebook Markdown cells render common formatting and embedded PNG/JPEG/GIF/WebP images, including Jupyter cell attachments and image outputs.
- Use **Open with…** in an attachment viewer to show the Windows app chooser and select an installed editor such as VS Code. The app stages a temporary copy under your operating system's temporary directory for Windows to open. The browser cannot automatically list installed desktop apps.
- <img src="https://github.com/uttam1233/Advanced_Degree_Pkg_Manager_System/blob/main/Screenshot%202026-10-21%20033705.png">
- Open **Practice code** inside a syllabus to edit, run, save, or rename a program file stored as an attachment to that syllabus in SQLite and synced to its PowerShell workspace. Saved source files are available to terminal commands such as `python main.py`; renaming a saved file removes its old workspace copy. While a program is running, enter input in the terminal panel and press Enter to send it to the program. Choose the filename extension (for example `.py`, `.js`, `.java`, `.c`, `.cpp`, `.go`, `.rs`, `.ps1`, or `.rb`) to select a runner; the corresponding runtime/compiler must be installed and available on `PATH`. The workspace also includes a PowerShell command panel. Tab indents by four spaces, Shift+Tab dedents, Enter keeps the current indentation, and Ctrl+Enter runs the program. Commands run as your Windows account and can access or change files you can access. Each command stops after 30 seconds and output is limited to 1 MB.
- After updating the app files, close all running app windows and restart the app so the local practice API uses the updated runner. The practice editor checks the API version and reports when an older server is still running.

- <img src ="https://github.com/uttam1233/Advanced_Degree_Pkg_Manager_System/blob/main/Screenshot%202026-10-21%20033809.png">
- Select **New notebook** inside a syllabus to create a saved, in-app Jupyter notebook. Its kernel picker lists kernels registered with the Jupyter installation found on `PATH`; selecting one starts a stateful local kernel, and notebook cells support code execution, Markdown, text/image output, and prompted input. Markdown source remains in the editor until you choose **Render Markdown**. Code and Markdown editors start at one line high and grow as you type. Use **Upload files** to add files (up to 25 MB each) to the syllabus notebook workspace, then select **Workspace files** to view the saved uploads or **Delete file** to remove the selected upload. The upload list and files are stored locally and persist when the notebook is closed or the app restarts. Uploading a filename that already exists is rejected with a warning instead of replacing the existing file. CSV files can be loaded in Python with `import pandas as pd` and `pd.read_csv("data.csv")`. If pandas reports a UTF-8 decode error for a Windows/Excel CSV, try `pd.read_csv("data.csv", encoding="cp1252")`; use the encoding used when the file was saved if it is different. The notebook UI can use Jupyter Light, Jupyter Dark, Solarized Light, or Monokai themes. Save notebooks with the syllabus or download them as standard `.ipynb` files. A Python installation must include Jupyter and `jupyter_client`; register another Python environment as a kernel by installing `ipykernel` in that environment and running `python -m ipykernel install --user --name my-env --display-name "My Environment"`. To install a package into the currently selected kernel from a notebook, use the IPython magic `%pip install package-name`; it targets that kernel's Python environment. Running plain `pip install` in a separate terminal installs into whichever environment that terminal's `pip` points to, which may be global or a different environment. Libraries such as PyTorch and TensorFlow must be installed in the selected kernel environment before use. Notebook kernels execute with your Windows account's permissions and stop when the notebook closes.
- Use the three-dot menu on a syllabus item to edit its name or delete the syllabus and all of its notes and attachments.
- The note editor supports bold, underline, undo, redo, colors, font sizes, line breaks, four-space Tab indentation, and inline PNG/JPG/WebP images that can be resized by dragging their corner.
- Editing a note preloads its saved title and formatted content.
