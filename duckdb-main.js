import { $ } from "./duckdb-utils.js";
import { DuckShell } from "./duckdb-shell.js";
import { ChatApp } from "./duckdb-chat-app.js";
import { preloadDuckDBDocs, searchDuckDBDocs } from "./duckdb-docs.js";
import { initPanelResizer } from "./duckdb-resizer.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  // Restore a saved panel width before the terminal is measured and fitted.
  initPanelResizer();

  const shell = new DuckShell($("terminal"));
  shell.init();

  // The shell's `.files` commands call these hooks (same contract as
  // shell.duckdb.org). Names may be supplied, otherwise file names are used.
  window.filesAdd = (args) => shell.importFiles(shell.parseImportNames(args));
  window.filesList = () => shell.showFileList();
  window.filesDrop = (name) => shell.dropFile(name);
  window.filesDropAll = () => shell.dropAllFiles();
  window.filesDownload = (name) => shell.downloadFile(name);

  const status = $("db-status");
  try {
    status.textContent = "loading DuckDB v2…";
    await shell.boot();
    status.textContent = `DuckDB ${shell.version} · ready`;
    status.classList.add("ready");
    status.classList.remove("error");
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    status.textContent = "DuckDB v2 failed to start";
    status.classList.add("error");
    shell.term.write(`\x1b[31mFailed to start DuckDB v2: ${message}\x1b[0m\r\n`);
    console.error(error);
    return;
  }

  const chat = new ChatApp(shell);
  chat.init();

  // Warm the manual and its search index in the background so the first
  // help(...) call does not pay the fetch and parse cost.
  const preloadManual = () => {
    preloadDuckDBDocs();
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(preloadManual, { timeout: 3000 });
  } else {
    setTimeout(preloadManual, 1200);
  }

  // Expose a small test surface. Useful from DevTools and automated checks.
  window.__app = {
    shell,
    chat,
    version: shell.version,
    ask: (text) => {
      chat.inputEl.value = text;
      chat.autoResize();
      chat.updateComposer();
      return chat.send();
    },
    runQuery: (sql) => shell.runQuery(sql, { source: "chat" }),
    searchDocs: (query) => searchDuckDBDocs(query),
    loadModel: (key) => chat.loadModel(key),
  };
  window.__shell = shell;
  window.__chat = chat;

  // Auto-load the default model (same behaviour as the wllama examples).
  setTimeout(() => {
    chat.loadModel(chat.modelKey);
  }, 250);
}

main().catch((error) => {
  console.error(error);
  const status = $("chat-status");
  if (status) {
    status.textContent = `Startup error: ${error.message || error}`;
    status.classList.add("error");
  }
});
