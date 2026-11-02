import { $, formatBytes, sleep, stripAnsi } from "./duckdb-utils.js";

// ---------------------------------------------------------------------------
// DuckDB v2 web shell assets (served by the official shell CDN)
// ---------------------------------------------------------------------------

const SHELL_ASSETS = {
  shellJs: "https://shell.duckdb.org/static/assets/duckdb.087a37a1ec.js",
  shellWasm: "https://shell.duckdb.org/static/assets/duckdb.b1d87cedf1.wasm",
  worker: "https://shell.duckdb.org/static/assets/worker.ec60d07e58.js",
  engine: "https://shell.duckdb.org/static/assets/duckdb-eh.9ea52324b7.wasm",
};
const ENGINE_URL = new URL(SHELL_ASSETS.engine, location.href).href;

// Start the engine worker as early as possible, exactly like the official
// shell: it downloads/instantiates the DuckDB engine while the frontend WASM
// and the xterm UI are still loading. A worker script cannot be constructed
// cross-origin, so fetch the CDN worker and run it from a blob URL.
const EARLY_MESSAGES = [];

const EARLY_WORKER = (async () => {
  const response = await fetch(SHELL_ASSETS.worker, { mode: "cors" });
  if (!response.ok) {
    throw new Error(`could not load ${SHELL_ASSETS.worker} (HTTP ${response.status})`);
  }
  const source = await response.text();
  const workerUrl = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  const worker = new Worker(workerUrl);
  URL.revokeObjectURL(workerUrl);
  worker.onmessage = (event) => { EARLY_MESSAGES.push(event); };
  worker.postMessage({ op: "instantiate", tag: 0, mainModuleURL: ENGINE_URL });
  return worker;
})();

// ---------------------------------------------------------------------------
// DuckDB WASM shell
// ---------------------------------------------------------------------------

// Wire opcodes used by the DuckDB v2 shell frontend <-> engine worker.
const WIRE_OP = {
  1: "create_connection", 2: "close_connection", 3: "query", 4: "send_query",
  5: "prepare", 6: "execute", 7: "fetch", 8: "cast_to_varchar",
  9: "begin_transaction", 10: "commit", 11: "rollback", 12: "is_auto_commit",
  13: "interrupt", 14: "clear_interrupt", 15: "table_info", 16: "fetch_chunk_at",
};

// The prompt is "<database>[.<schema>] D "; names can change with USE or ATTACH.
const PROMPT_PREFIX = /^(?![\s│┌┐└┘├┤┬┴┼─])(?:Loading\.\.\.|.+?)\s+D(?:\s|$)/;
const PROMPT_ONLY = /^(?![\s│┌┐└┘├┤┬┴┼─])(?:Loading\.\.\.|.+?)\s+D\s*$/;

const readU64 = (data, offset) => {
  const view = new DataView(data.buffer, data.byteOffset + offset);
  return view.getUint32(0, true) + view.getUint32(4, true) * 0x100000000;
};

const readU32 = (data, offset) => {
  const view = new DataView(data.buffer, data.byteOffset + offset);
  return view.getUint32(0, true);
};

export class DuckShell {
  constructor(container) {
    this.container = container;
    this.term = null;
    this.fitAddon = null;
    this.wasm = null;
    this.worker = null;
    this.workerReady = false;
    this.initDone = false;
    this.ready = false;
    this.version = "";
    this.workerCallbacks = {};
    this.nextTag = 1;
    this.inflight = new Set();
    this.grammarCheckTags = new Set();
    this.grammarSyncing = false;
    this.queryQueue = Promise.resolve();
    this.resizeObserver = null;
    this.resolveFrontend = null;
    this.rejectFrontend = null;
    this.frontendReady = null;
    this.fileInput = null;
    this.pendingImportNames = [];
    this.asyncBusy = false;
    this.mode = "duckbox";
    this.modeSelect = null;
    this.modeOutputBuffer = "";
    this.duckLogo = null;
    this.duckTimer = null;
    this.manualQueryPending = false;
  }

  init() {
    this.term = new window.Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 10000,
      allowProposedApi: true,
      theme: {
        background: "#0d131a",
        foreground: "#d7e3ee",
        cursor: "#f2c94c",
        selectionBackground: "#2b3b4d",
        black: "#1b2430",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e5eef7",
        brightBlack: "#64748b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde68a",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f8fafc",
      },
    });

    this.fitAddon = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.container);
    this.fit();
    this.syncTerminalSize();

    this.term.onData((data) => this.handleData(data));
    this.term.onResize(() => {
      this.fit();
      this.syncTerminalSize();
    });

    this.container.addEventListener("mousedown", () => this.term.focus());
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(this.container);

    const clearButton = $("btn-shell-clear");
    if (clearButton) {
      clearButton.addEventListener("click", () => this.clearScreen());
    }

    this.duckLogo = $("duck-logo");
    this.modeSelect = $("mode-select");
    if (this.modeSelect) {
      this.modeSelect.value = this.mode;
      this.modeSelect.addEventListener("change", () => {
        this.setMode(this.modeSelect.value);
      });
    }

    this.fileInput = $("shell-file-input");
    if (this.fileInput) {
      this.fileInput.addEventListener("change", () => this.registerSelectedFiles());
      this.fileInput.addEventListener("cancel", () => {
        this.pendingImportNames = [];
        this.asyncBusy = false;
        this.resumeShellEditing();
        this.term.focus();
      });
    }
    const importButton = $("btn-shell-import");
    if (importButton) {
      importButton.addEventListener("click", () => this.importFiles());
    }

    this.term.write(
      "\x1b[38;5;220mDuckDB WASM Shell\x1b[0m  \x1b[90mloading DuckDB v2…\x1b[0m\r\n"
    );
  }

  fit() {
    try {
      this.fitAddon?.fit();
    } catch {
      // The terminal may not be visible yet.
    }
  }

  /**
   * The shell frontend's line editor lays out the prompt and input itself and
   * reads the terminal size from these globals (it falls back to 80x24 when
   * they are missing).  Keep them in sync with xterm, otherwise a wrapped
   * input line is accounted for on the wrong row: cursor keys redraw the
   * prompt a row off and erasing it can drop the previous command.
   */
  syncTerminalSize() {
    if (!this.term) return;
    window.termCols = this.term.cols;
    window.termRows = this.term.rows;
  }

  // -------------------------------------------------------------------------
  // Worker wire transport
  // -------------------------------------------------------------------------

  async initWorker() {
    this.worker = await EARLY_WORKER;
    const instantiated = new Promise((resolve, reject) => {
      this.workerCallbacks[0] = (status, data, error) => {
        if (status !== 0) reject(new Error(error || "worker instantiation failed"));
        else resolve(data);
      };
    });

    this.worker.onmessage = (event) => {
      const { tag, status, data, error } = event.data || {};
      if (error) console.error("[duckdb worker]", error);
      const callback = this.workerCallbacks[tag];
      if (callback) {
        callback(status, data, error);
        delete this.workerCallbacks[tag];
      } else if (this.wasm && this.initDone) {
        this.deliverToFrontend(tag, status, data);
      }
    };

    // The instantiate reply may have arrived before this handler was wired.
    for (const event of EARLY_MESSAGES.splice(0)) this.worker.onmessage(event);
    this.worker.onerror = (event) => console.error("[duckdb worker] error event", event);
    return instantiated;
  }

  sendToWorkerAsync(op, params = {}) {
    return new Promise((resolve, reject) => {
      const tag = this.nextTag++;
      this.workerCallbacks[tag] = (status, data, error) => {
        if (status !== 0) reject(new Error(error || "worker error"));
        else resolve(data);
      };
      this.worker.postMessage({ op, tag, ...params });
    });
  }

  deliverToFrontend(tag, status, data) {
    this.inflight.delete(tag);
    if (this.grammarCheckTags.delete(tag)) {
      this.grammarSyncing = true;
      setTimeout(() => this.syncGrammar(), 0);
    }

    const payload = data || new Uint8Array(0);
    const envelope = new Uint8Array(9 + payload.length);
    const view = new DataView(envelope.buffer);
    view.setUint32(0, tag & 0xFFFFFFFF, true);
    view.setUint32(4, Math.floor(tag / 0x100000000), true);
    view.setUint8(8, status);
    if (payload.length > 0) envelope.set(payload, 9);

    const ptr = this.wasm._malloc(envelope.length);
    this.wasm.HEAPU8.set(envelope, ptr);
    this.wasm._wasm_on_ws_response(ptr, envelope.length);
    this.wasm._free(ptr);
    this.flushPending();
    this.settleAfterFeed();

    if (this.wasm._wasm_is_editing() && this.wasm._wasm_has_buffered_input()) {
      this.wasm._wasm_feed_key(0, 0);
      this.flushPending();
      this.settleAfterFeed();
    }

    // A typed statement is done once its response has been delivered and
    // the shell is back at the prompt (prompt lookups included).
    if (
      this.manualQueryPending &&
      this.wasm._wasm_is_editing() &&
      this.inflight.size === 0
    ) {
      this.manualQueryPending = false;
      this.animateDuck();
    }
  }

  async syncGrammar() {
    this.grammarSyncing = true;
    try {
      const sql = "SELECT coalesce(string_agg(concat_ws(chr(31), type, rule_name, definition, CASE WHEN collapsible THEN '1' ELSE '0' END, CASE WHEN suppress_suggestions THEN '1' ELSE '0' END, CASE WHEN has_code THEN '1' ELSE '0' END), chr(30)), '')::VARCHAR FROM duckdb_grammar_changes()";
      await this.sendToWorkerAsync("query", { sql, castMode: 0 });
    } catch (error) {
      console.warn("[duckdb] grammar sync failed", error);
    } finally {
      this.grammarSyncing = false;
    }
  }

  flushPending() {
    if (!this.wasm || !this.workerReady) return;
    while (this.wasm._wasm_has_pending()) {
      const ptr = this.wasm._wasm_take_pending();
      const size = this.wasm._wasm_pending_size();
      const raw = new Uint8Array(this.wasm.HEAPU8.buffer, ptr, size).slice();
      const tag = readU64(raw, 0);
      const opcode = raw[8];

      switch (opcode) {
        case 3:
        case 4: {
          this.inflight.add(tag);
          const castMode = raw[17];
          const sqlLength = readU32(raw, 18);
          const sql = new TextDecoder().decode(raw.subarray(22, 22 + sqlLength));
          if (/active_grammar_extensions|\breset\s+all\b/i.test(sql)) {
            this.grammarCheckTags.add(tag);
          }
          this.worker.postMessage({
            op: opcode === 3 ? "query" : "send_query",
            tag,
            sql,
            castMode,
          });
          break;
        }
        case 7:
          this.worker.postMessage({ op: "fetch", tag });
          break;
        case 16:
          this.worker.postMessage({ op: "fetch_chunk_at", tag, chunkIdx: readU64(raw, 17) });
          break;
        case 13:
          this.worker.postMessage({ op: "interrupt", tag });
          break;
        case 14:
          this.worker.postMessage({ op: "clear_interrupt", tag });
          break;
        default:
          console.warn("[duckdb wire] unhandled opcode", opcode, WIRE_OP[opcode]);
      }
    }
  }

  settleAfterFeed() {
    for (let round = 0; round < 10000; round++) {
      if (this.asyncBusy || !this.wasm._wasm_is_idle() || this.wasm._wasm_has_pending() || this.wasm._wasm_is_editing()) return;
      this.wasm._wasm_start_editing();
      this.flushPending();
      if (!this.wasm._wasm_is_editing() || !this.wasm._wasm_has_buffered_input()) return;
      this.wasm._wasm_feed_key(0, 0);
      this.flushPending();
    }
  }

  // -------------------------------------------------------------------------
  // Frontend WASM
  // -------------------------------------------------------------------------

  loadFrontendWasm() {
    this.frontendReady = new Promise((resolve, reject) => {
      this.resolveFrontend = resolve;
      this.rejectFrontend = reject;
    });

    window.Module = {
      locateFile: (path, prefix) =>
        path === "duckdb.wasm" ? SHELL_ASSETS.shellWasm : prefix + path,
      print: (text) => this.onWasmPrint(text),
      printErr: (text) => this.onWasmPrintErr(text),
      onRuntimeInitialized: () => {
        this.wasm = window.Module;
        this.wasm.onWasmOutput = (bytes) => {
          const text = new TextDecoder().decode(bytes);
          this.trackModeOutput(text);
          this.term.write(text.replace(/\r?\n/g, "\r\n"));
        };
        this.wasm._wasm_init(1n);
        this.wasm._wasm_set_backend_ready(this.workerReady ? 1 : 0);
        this.initDone = true;
        this.wasm._wasm_start_editing();
        this.flushPending();
        this.resolveFrontend?.();
      },
    };

    const script = document.createElement("script");
    script.crossOrigin = "anonymous";
    script.src = SHELL_ASSETS.shellJs;
    script.onerror = () => this.rejectFrontend?.(new Error("Could not load the DuckDB shell frontend."));
    document.body.appendChild(script);
  }

  onWasmPrint(text) {
    const output = String(text);
    this.trackModeOutput(output);
    this.term.write(output.replace(/\r?\n/g, "\r\n") + "\r\n");
  }

  onWasmPrintErr(text) {
    const output = String(text);
    this.trackModeOutput(output);
    this.term.write("\x1b[31m" + output.replace(/\r?\n/g, "\r\n") + "\x1b[0m\r\n");
  }

  trackModeOutput(text) {
    // `.mode` with no argument reports the current mode; keep the picker
    // in sync. Buffer chunks because the report can be split across them.
    this.modeOutputBuffer += text;
    const match = this.modeOutputBuffer.match(/current output mode:\s*([a-z0-9_]+)/i);
    if (match) {
      this.modeOutputBuffer = "";
      this.syncMode(match[1]);
    } else if (this.modeOutputBuffer.length > 256) {
      this.modeOutputBuffer = this.modeOutputBuffer.slice(-128);
    }
  }

  // -------------------------------------------------------------------------
  // Terminal input
  // -------------------------------------------------------------------------

  handleData(data) {
    if (!this.initDone || !this.wasm) return;

    if (data === "\r" || data === "\n") {
      const line = this.currentInputLine();
      // Keep the mode picker in sync when the command is typed by hand.
      const match = line.match(/\.mode\s+([a-z0-9_]+)\s*$/i);
      if (match) this.syncMode(match[1]);
      // A typed SQL statement (not a dot command) should quack when done.
      const input = line.replace(PROMPT_PREFIX, "").trim();
      this.manualQueryPending = Boolean(input && !input.startsWith("."));
    }

    if (data === "\x04") return; // Ctrl+D: keep the session alive.
    if (data === "\x0c") { // Ctrl+L
      this.clearScreen();
      return;
    }
    if (data === "\x03") { // Ctrl+C
      this.manualQueryPending = false;
      if (!this.wasm._wasm_is_editing()) {
        this.wasm._wasm_interrupt();
        this.flushPending();
      } else {
        this.term.write("\x1b[J\r\n");
        this.wasm._wasm_start_editing();
        this.flushPending();
      }
      return;
    }

    const encoded = new TextEncoder().encode(data);
    const ptr = this.wasm._malloc(encoded.length);
    this.wasm.HEAPU8.set(encoded, ptr);
    this.wasm._wasm_feed_key(ptr, encoded.length);
    this.wasm._free(ptr);
    this.flushPending();
    this.settleAfterFeed();
  }

  feed(text) {
    const encoded = new TextEncoder().encode(text);
    const ptr = this.wasm._malloc(encoded.length);
    this.wasm.HEAPU8.set(encoded, ptr);
    this.wasm._wasm_feed_key(ptr, encoded.length);
    this.wasm._free(ptr);
    this.flushPending();
    this.settleAfterFeed();
  }

  currentInputLine() {
    const buffer = this.term?.buffer?.active;
    if (!buffer) return "";
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    return line ? line.translateToString(true) : "";
  }

  syncMode(mode) {
    const value = String(mode || "").trim().toLowerCase();
    if (!value || value === this.mode) return;
    this.mode = value;
    if (this.modeSelect) this.modeSelect.value = value;
  }

  async setMode(mode) {
    const value = String(mode || "").trim().toLowerCase();
    if (!value) return;
    this.mode = value;
    if (this.modeSelect) this.modeSelect.value = value;
    if (!this.ready || !this.wasm) return;
    // Serialize with queries so the command is not typed into a busy shell.
    const run = async () => {
      if (!(await this.waitForPrompt(true, 20000))) return;
      this.feed(`.mode ${value}\n`);
      await this.waitForSettled(10000);
    };
    this.queryQueue = this.queryQueue.then(run, run);
    await this.queryQueue;
    this.term.focus();
  }

  animateDuck() {
    const logo = this.duckLogo;
    if (!logo) return;
    logo.classList.remove("quack");
    void logo.offsetWidth;
    logo.classList.add("quack");
    clearTimeout(this.duckTimer);
    this.duckTimer = setTimeout(() => logo.classList.remove("quack"), 750);
  }

  clearScreen() {
    this.term.clear();
    this.term.write("\x1b[2J\x1b[H");
    this.writeBanner();
    if (this.wasm) {
      this.wasm._wasm_start_editing();
      this.flushPending();
    }
  }

  // -------------------------------------------------------------------------
  // File import (same flow as https://shell.duckdb.org/)
  // -------------------------------------------------------------------------

  parseImportNames(args) {
    const names = [];
    const text = String(args || "").trim();
    let i = 0;
    while (i < text.length) {
      while (text[i] === " ") i++;
      if (i >= text.length) break;
      if (text[i] === "'") {
        const end = text.indexOf("'", i + 1);
        if (end === -1) {
          names.push(text.slice(i + 1));
          break;
        }
        names.push(text.slice(i + 1, end));
        i = end + 1;
      } else {
        const end = text.indexOf(" ", i);
        if (end === -1) {
          names.push(text.slice(i));
          break;
        }
        names.push(text.slice(i, end));
        i = end + 1;
      }
    }
    return names;
  }

  /** Open the picker. Names are optional overrides for the selected files. */
  importFiles(names = []) {
    if (!this.ready || !this.wasm) {
      this.term.write("\x1b[31mDuckDB is still starting.\x1b[0m\r\n");
      return;
    }
    if (!this.fileInput) return;
    this.pendingImportNames = Array.isArray(names) ? names : [];
    this.asyncBusy = true;
    this.fileInput.value = "";
    this.fileInput.click();
  }

  async registerSelectedFiles() {
    this.asyncBusy = true;
    const files = Array.from(this.fileInput?.files || []);
    const names = this.pendingImportNames;
    this.pendingImportNames = [];
    if (!files.length) {
      this.asyncBusy = false;
      this.resumeShellEditing();
      return;
    }

    this.term.write(`\x1b[90mImporting ${files.length} file${files.length === 1 ? "" : "s"}…\x1b[0m\r\n`);
    for (let i = 0; i < files.length; i++) {
      const name = names[i] || files[i].name;
      try {
        const buffer = new Uint8Array(await files[i].arrayBuffer());
        await this.sendToWorkerAsync("register_file", { fileName: name, buffer });
        this.term.write(
          `\x1b[32mRegistered:\x1b[0m ${name} \x1b[90m(${formatBytes(buffer.length)})\x1b[0m\r\n`
        );
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        this.term.write(`\x1b[31mImport failed for ${name}: ${message}\x1b[0m\r\n`);
      }
    }

    const firstName = names[0] || files[0].name;
    this.term.write(
      `\x1b[90mQuery it with: SELECT * FROM '${firstName}' LIMIT 10;\x1b[0m\r\n`
    );

    this.asyncBusy = false;
    this.resumeShellEditing();
    this.term.focus();
  }

  async listRegisteredFiles() {
    const data = await this.sendToWorkerAsync("list_files");
    if (!data || data.length === 0) return [];
    return JSON.parse(new TextDecoder().decode(data));
  }

  renderFileList(files) {
    if (!files.length) {
      this.term.write("No files registered.\r\n");
      return;
    }
    const labels = files.map(
      (file) => `${file.fileName} (${formatBytes(file.fileSize)})`
    );
    const widest = Math.max(...labels.map((label) => label.length));
    const colWidth = Math.min(widest + 3, 80);
    const termWidth = this.term.cols || 80;
    const numCols = Math.max(1, Math.floor(termWidth / colWidth));
    for (let i = 0; i < labels.length; i += numCols) {
      let line = "";
      for (let j = 0; j < numCols && i + j < labels.length; j++) {
        line += labels[i + j].padEnd(colWidth);
      }
      this.term.write(line.trimEnd() + "\r\n");
    }
  }

  resumeShellEditing() {
    if (!this.wasm || !this.ready) return;
    if (!this.wasm._wasm_is_editing()) {
      this.wasm._wasm_start_editing();
    }
    this.flushPending();
  }

  beginFileOperation() {
    this.asyncBusy = true;
  }

  endFileOperation() {
    this.asyncBusy = false;
    this.resumeShellEditing();
  }

  unquoteFileName(name) {
    const text = String(name || "").trim();
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
      return text.slice(1, -1);
    }
    return text;
  }

  async showFileList() {
    this.beginFileOperation();
    try {
      this.renderFileList(await this.listRegisteredFiles());
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.term.write(`\x1b[31mCould not list files: ${message}\x1b[0m\r\n`);
    } finally {
      this.endFileOperation();
    }
  }

  async dropFile(name) {
    this.beginFileOperation();
    const target = this.unquoteFileName(name);
    try {
      if (!target) {
        this.term.write("Usage: .files drop <name>\r\n");
        return;
      }
      const files = await this.listRegisteredFiles();
      if (!files.some((file) => file.fileName === target)) {
        this.term.write(`File not found: ${target}\r\n`);
      } else {
        await this.sendToWorkerAsync("drop_file", { fileName: target });
        this.term.write(`Dropped: ${target}\r\n`);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.term.write(`\x1b[31mCould not drop ${target}: ${message}\x1b[0m\r\n`);
    } finally {
      this.endFileOperation();
    }
  }

  async dropAllFiles() {
    this.beginFileOperation();
    try {
      await this.sendToWorkerAsync("drop_files");
      this.term.write("All files dropped.\r\n");
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.term.write(`\x1b[31mCould not drop files: ${message}\x1b[0m\r\n`);
    } finally {
      this.endFileOperation();
    }
  }

  async downloadFile(name) {
    this.beginFileOperation();
    const target = this.unquoteFileName(name);
    try {
      if (!target) {
        this.term.write("Usage: .files download <name>\r\n");
        return;
      }
      const files = await this.listRegisteredFiles();
      if (!files.some((file) => file.fileName === target)) {
        this.term.write(`File not found: ${target}\r\n`);
      } else {
        const data = await this.sendToWorkerAsync("download_file", {
          fileName: target,
        });
        if (!data || data.length === 0) {
          this.term.write(`Error: could not read file ${target}\r\n`);
        } else {
          const blob = new Blob([data]);
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = target.includes("/") ? target.split("/").pop() : target;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          URL.revokeObjectURL(url);
          this.term.write(
            `Downloaded: ${target} (${formatBytes(data.length)})\r\n`
          );
        }
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.term.write(`\x1b[31mCould not download ${target}: ${message}\x1b[0m\r\n`);
    } finally {
      this.endFileOperation();
    }
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async boot() {
    this.loadFrontendWasm();
    await this.initWorker();
    await this.sendToWorkerAsync("open", { config: "" });
    await this.sendToWorkerAsync("connect");
    this.workerReady = true;
    await this.frontendReady;

    this.wasm._wasm_set_backend_ready(1);
    if (this.wasm._wasm_is_editing() && this.wasm._wasm_is_line_empty()) {
      this.term.write("\r\x1b[2K");
      this.wasm._wasm_start_editing();
    }
    this.flushPending();
    this.ready = true;

    // Let the initial prompt query finish before clearing the screen,
    // otherwise the first prompt can render with a null database name.
    await this.waitForPrompt(false, 5000);

    // The v2 shell build is fixed; no need to run a query just to show it.
    const version = "v2.0.0";
    this.version = version;

    this.term.clear();
    this.term.write("\x1b[2J\x1b[H");
    this.writeBanner(version);
    this.wasm._wasm_start_editing();
    this.flushPending();
    await this.waitForSettled(5000);
    this.term.focus();
  }

  writeBanner(version = this.version) {
    const label = version ? `DuckDB ${version}` : "DuckDB v2 (Cyanoptera)";
    this.term.write(
      "\x1b[38;5;220m" + label + "\x1b[0m  \x1b[90mWebAssembly · in-memory\x1b[0m\r\n" +
      `\x1b[90mOutput mode: ${this.mode} · type .help for commands\x1b[0m\r\n` +
      "\x1b[90mTry: SELECT 42 AS answer;\x1b[0m\r\n\r\n"
    );
  }

  // -------------------------------------------------------------------------
  // Query execution
  // -------------------------------------------------------------------------

  isIdle() {
    const m = this.wasm;
    return Boolean(
      m && this.workerReady && this.initDone &&
      m._wasm_is_editing() && m._wasm_is_idle() &&
      !m._wasm_has_pending() && this.inflight.size === 0
    );
  }

  async waitForPrompt(requireEmpty = false, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.isIdle() && (!requireEmpty || this.wasm._wasm_is_line_empty())) return true;
      await sleep(40);
    }
    return false;
  }

  async waitForSettled(timeout = 120000) {
    const start = Date.now();
    let signature = "";
    let stable = 0;
    while (Date.now() - start < timeout) {
      if (this.isIdle()) {
        const buffer = this.term.buffer.active;
        const next = `${buffer.length}:${buffer.baseY}:${buffer.cursorY}:${buffer.cursorX}`;
        if (next === signature) stable++;
        else { signature = next; stable = 0; }
        if (stable >= 3) return true;
      } else {
        signature = "";
        stable = 0;
      }
      await sleep(80);
    }
    return false;
  }

  readNewLines(before) {
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let index = before; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    return lines;
  }

  /** Plain text of the last `maxLines` terminal lines, without the startup banner. */
  recentOutput(maxLines = 500) {
    const buffer = this.term?.buffer?.active;
    if (!buffer) return "";
    const cursor = buffer.baseY + buffer.cursorY;
    const end = Math.max(0, Math.min(cursor, buffer.length - 1));
    const start = Math.max(0, end - maxLines + 1);
    const lines = [];
    for (let index = start; index <= end; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      const text = stripAnsi(line.translateToString(true));
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    const header = [
      /^DuckDB\s+v\S+\s+WebAssembly\s+\u00b7\s+in-memory$/,
      /^Output mode:.*type \.help for commands$/,
      /^Try: SELECT 42 AS answer;$/,
      /^DuckDB WASM Shell\s+loading DuckDB/,
    ];
    const output = lines
      .filter((line) => !header.some((pattern) => pattern.test(line.trim())))
      .map((line) => line.replace(PROMPT_PREFIX, ""));
    while (output.length && !output[0].trim()) output.shift();
    while (output.length && !output[output.length - 1].trim()) output.pop();
    const last = output[output.length - 1];
    if (last != null && PROMPT_ONLY.test(last)) {
      output.pop();
    }
    while (output.length && !output[output.length - 1].trim()) output.pop();
    return output.join("\n");
  }

  /** Locate the shell prompt line at or above `before`. */
  findPromptLine(before) {
    const buffer = this.term.buffer.active;
    const limit = Math.min(before, buffer.length);
    for (let index = limit - 1; index >= 0; index--) {
      const line = buffer.getLine(index);
      if (!line) continue;
      if (PROMPT_PREFIX.test(stripAnsi(line.translateToString(true)))) {
        return index;
      }
    }
    return Math.max(0, before - 1);
  }

  /**
   * The shell echoes the submitted statement on the prompt line (and on
   * following lines for multi-line statements).  Long lines wrap in xterm.
   * Walk the buffer from the prompt line and return the index of the first
   * line that belongs to the result rather than the echo.
   */
  resultStart(before, statement) {
    const buffer = this.term.buffer.active;
    const sourceLines = Math.max(1, statement.split("\n").length);
    let index = this.findPromptLine(before);
    let logical = 0;

    while (index < buffer.length && logical < sourceLines) {
      const line = buffer.getLine(index);
      if (!line) {
        index++;
        continue;
      }
      if (!line.isWrapped) logical++;
      index++;
    }

    // Consume wrapped continuations of the final echoed source line.
    while (index < buffer.length) {
      const line = buffer.getLine(index);
      if (line && line.isWrapped) index++;
      else break;
    }
    return index;
  }

  ensureSemicolon(sql) {
    const statement = String(sql ?? "").trim();
    if (!statement || statement.endsWith(";")) return statement;
    // A trailing line comment would swallow a semicolon appended on the same line.
    const lastLine = statement.slice(statement.lastIndexOf("\n") + 1);
    return lastLine.includes("--") ? `${statement}\n;` : `${statement};`;
  }

  async runQuery(sql, options = {}) {
    const statement = this.ensureSemicolon(sql);
    const run = async () => {
      if (!this.ready) {
        return { ok: false, sql: statement, markdown: "", error: "DuckDB shell is not ready yet." };
      }
      if (!(await this.waitForPrompt(true, 20000))) {
        return { ok: false, sql: statement, markdown: "", error: "DuckDB shell is busy." };
      }

      const buffer = this.term.buffer.active;
      // The cursor sits on the prompt line while the shell is idle. Use that
      // line (not buffer.length, which may include unused viewport rows) to
      // anchor result extraction.
      const promptIndex = buffer.baseY + buffer.cursorY;
      const before = buffer.length;
      this.feed(statement + "\n");

      // Make sure the statement actually left the input line before we
      // start waiting for the shell to become idle again.  This guards
      // against a busy main thread (e.g. a model loading) delaying output.
      const feedStart = Date.now();
      while (Date.now() - feedStart < 5000) {
        if (this.term.buffer.active.length > before || !this.isIdle()) break;
        await sleep(20);
      }

      if (!(await this.waitForSettled(120000))) {
        return { ok: false, sql: statement, markdown: "", error: "Query timed out." };
      }

      // The query is done: let the duck celebrate (but not during boot).
      if (options.source !== "init") this.animateDuck();

      const lines = this.readNewLines(this.resultStart(promptIndex + 1, statement));

      // The final line is the shell prompt (e.g. "memory.test D ").
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const last = lines[lines.length - 1];
      if (last != null && PROMPT_ONLY.test(stripAnsi(last))) {
        lines.pop();
      }

      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

      const raw = lines.join("\n");
      const error = this.detectError(raw);
      return {
        ok: !error,
        sql: statement,
        markdown: error ? "" : raw,
        error,
        raw,
      };
    };

    this.queryQueue = this.queryQueue.then(run, run);
    return this.queryQueue;
  }

  detectError(markdown) {
    if (!markdown) return "";
    // DuckDB prefixes errors with a category, e.g. "Parser Error:",
    // "Binder Error:", or "Catalog Error:".  Scan every line so an echoed
    // SQL line or leading blank line cannot hide the error from the chat.
    for (const line of markdown.split("\n")) {
      const text = stripAnsi(line).trim();
      if (!text) continue;
      if (/^(?:[A-Z][A-Za-z0-9 _-]*\s)?Error:/.test(text)) {
        return markdown.trim();
      }
    }
    return "";
  }
}
