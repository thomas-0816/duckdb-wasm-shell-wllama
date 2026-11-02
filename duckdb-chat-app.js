import { Wllama } from "./wllama/index.min.js";

import { $, el, escapeHtml } from "./duckdb-utils.js";
import { renderMarkdown } from "./duckdb-markdown.js";
import { searchDuckDBDocs } from "./duckdb-docs.js";
import { MAX_OUTPUT_TOKENS, MODELS, SYSTEM_PROMPT, TOOLS, WLLAMA_WASM_PATH } from "./duckdb-chat-config.js";

const SHELL_CONTEXT_LINES = 500;
const SHELL_CONTEXT_OPEN = "--- DuckDB shell output (last 500 lines) ---";
const SHELL_CONTEXT_CLOSE = "--- End of DuckDB shell output ---";

export class ChatApp {
  constructor(shell) {
    this.shell = shell;
    this.wllama = null;
    this.modelKey = "qwen3.5-0.8b";
    this.sampling = { temperature: 0.9, top_p: 0.95, repeat_penalty: 1.0 };
    this.modelLoaded = false;
    this.loading = false;
    this.generating = false;
    this.abortController = null;
    this.streamStarted = false;
    this.turnId = 0;
    this.pendingPrompt = null;
    this.suppressAbortMessage = false;
    this.activeBubble = null;
    this.history = [];
    this.historyIndex = -1;
    this.historyDraft = "";
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.maxToolIterations = 20;
    this.messagesEl = $("chat-messages");
    this.chatPanel = document.querySelector(".chat-panel");
    this.chatGutterFrame = 0;
    this.inputEl = $("chat-input");
    this.stopEl = $("btn-stop");
    this.statusEl = $("chat-status");
    this.statusTextEl = $("chat-status-text");
    this.percentEl = $("chat-percent");
    this.cacheButton = $("btn-cache");
    this.cacheDialog = $("cache-dialog");
    this.cacheListEl = $("cache-list");
    this.cacheSummaryEl = $("cache-summary");
    this.cacheClearButton = $("cache-clear");
    this.cacheCloseButton = $("cache-close");
    this.cacheWllama = null;
    this.progressWrap = $("model-progress-wrap");
    this.progressEl = $("model-progress");
    this.modelSelect = $("model-select");
    this.ctxBadge = $("ctx-badge");
    this.contextMax = 0;
    this.contextUsed = 0;
    this.contextLoaded = false;
    this.useGpu = !!navigator.gpu;
    this.newButton = $("btn-new-chat");
    this.subtitleEl = $("model-subtitle");
    this.autoScroll = true;
  }

  init() {
    this.inputEl.addEventListener("input", () => {
      this.historyIndex = -1;
      this.autoResize();
      this.updateComposer();
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.handleHistoryKey(event)) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this.send();
      }
    });
    this.stopEl.addEventListener("click", () => this.stop());
    this.newButton.addEventListener("click", () => this.newChat());
    this.modelSelect.addEventListener("change", () => {
      const key = this.modelSelect.value;
      const model = MODELS[key];
      if (model) {
        this.subtitleEl.textContent = model.subtitle;
        this.setContextMax(model.nCtx, false);
      }
      this.updateComposer();
      this.loadModel(key);
    });
    this.cacheButton.addEventListener("click", () => this.openCacheDialog());
    this.cacheCloseButton.addEventListener("click", () => this.cacheDialog.close());
    this.cacheDialog.addEventListener("click", (event) => {
      if (event.target === this.cacheDialog) this.cacheDialog.close();
    });
    this.cacheClearButton.addEventListener("click", () => this.clearCache());
    this.syncChatGutter();
    if (typeof ResizeObserver !== "undefined") {
      this.chatGutterObserver = new ResizeObserver(() => this.scheduleChatGutterSync());
      this.chatGutterObserver.observe(this.messagesEl);
    }
    if (typeof MutationObserver !== "undefined") {
      this.chatGutterMutation = new MutationObserver(() => this.scheduleChatGutterSync());
      this.chatGutterMutation.observe(this.messagesEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "open", "style"],
      });
    }
    window.addEventListener("resize", () => this.scheduleChatGutterSync());
    this.messagesEl.addEventListener("scroll", () => {
      const distance = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight;
      this.autoScroll = distance < 80;
    });
    this.updateComposer();
  }

  autoResize() {
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
  }

  syncChatGutter() {
    const width = this.messagesEl.offsetWidth - this.messagesEl.clientWidth;
    this.chatPanel.style.setProperty("--chat-scrollbar-width", `${width}px`);
  }

  scheduleChatGutterSync() {
    if (this.chatGutterFrame) return;
    this.chatGutterFrame = requestAnimationFrame(() => {
      this.chatGutterFrame = 0;
      this.syncChatGutter();
    });
  }

  handleHistoryKey(event) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
    const start = this.inputEl.selectionStart ?? 0;
    const end = this.inputEl.selectionEnd ?? 0;
    if (start !== end) return false;
    const value = this.inputEl.value;
    if (event.key === "ArrowUp" && value.slice(0, start).includes("\n")) return false;
    if (event.key === "ArrowDown" && value.slice(end).includes("\n")) return false;
    return this.navigateHistory(event.key === "ArrowUp" ? -1 : 1);
  }

  navigateHistory(delta) {
    if (!this.history.length) return false;
    if (this.historyIndex === -1) {
      if (delta > 0) return false;
      this.historyDraft = this.inputEl.value;
      this.historyIndex = this.history.length - 1;
      this.setInputValue(this.history[this.historyIndex]);
      return true;
    }
    const next = this.historyIndex + delta;
    if (next < 0 || next >= this.history.length) {
      this.historyIndex = -1;
      this.setInputValue(this.historyDraft);
      return true;
    }
    this.historyIndex = next;
    this.setInputValue(this.history[this.historyIndex]);
    return true;
  }

  setInputValue(value) {
    this.inputEl.value = value;
    this.autoResize();
    this.updateComposer();
    const end = value.length;
    this.inputEl.setSelectionRange(end, end);
    this.inputEl.scrollTop = this.inputEl.scrollHeight;
  }

  rememberPrompt(text) {
    const value = String(text).trim();
    if (!value) return;
    if (this.history[this.history.length - 1] !== value) {
      this.history.push(value);
      if (this.history.length > 100) this.history.shift();
    }
    this.historyIndex = -1;
    this.historyDraft = "";
  }

  setStatus(text, kind = "") {
    this.statusTextEl.textContent = text;
    this.statusEl.classList.toggle("error", kind === "error");
    this.statusEl.classList.toggle("ready", kind === "ready");
  }

  setContextMax(nCtx, loaded = false) {
    this.contextMax = Number(nCtx) > 0 ? Number(nCtx) : 0;
    this.contextLoaded = loaded;
    this.updateContextBadge();
  }

  setContextUsed(used) {
    const value = Number(used);
    if (!Number.isFinite(value) || value <= 0) return;
    this.contextUsed = Math.max(0, Math.round(value));
    this.updateContextBadge();
  }

  updateContextBadge() {
    if (!this.ctxBadge) return;
    const used = this.contextUsed.toLocaleString("en-US");
    const max = this.contextMax > 0 ? this.contextMax.toLocaleString("en-US") : "—";
    this.ctxBadge.textContent = `ctx ${used}/${max}`;
    this.ctxBadge.title = this.contextLoaded
      ? `Loaded context: ${used} of ${max} tokens used`
      : `Configured context: ${used} of ${max} tokens used`;
    this.ctxBadge.classList.toggle("ready", this.contextLoaded);
    this.ctxBadge.classList.toggle(
      "warn",
      this.contextMax > 0 && this.contextUsed / this.contextMax >= 0.9
    );
  }

  setProgress(percent) {
    if (percent == null) {
      this.progressWrap.classList.remove("show");
      this.progressEl.style.width = "0%";
      return;
    }
    this.progressWrap.classList.add("show");
    this.progressEl.style.width = Math.max(0, Math.min(100, percent)) + "%";
  }

  setPercent(percent) {
    if (percent == null) {
      this.percentEl.textContent = "";
      this.percentEl.classList.add("hidden");
      return;
    }
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    this.percentEl.textContent = `${value}%`;
    this.percentEl.classList.remove("hidden");
  }

  getCacheManager() {
    if (this.wllama) return this.wllama.cacheManager;
    if (!this.cacheWllama) {
      this.cacheWllama = new Wllama({
        default: WLLAMA_WASM_PATH,
      });
    }
    return this.cacheWllama.cacheManager;
  }

  formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    const scaled = value / Math.pow(1024, index);
    return `${scaled.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  async openCacheDialog() {
    if (!this.cacheDialog.open) this.cacheDialog.showModal();
    await this.refreshCache();
  }

  async refreshCache() {
    this.cacheListEl.innerHTML = "";
    this.cacheSummaryEl.textContent = "Reading browser cache…";
    this.cacheClearButton.disabled = true;
    try {
      const entries = await this.getCacheManager().list();
      entries.sort((a, b) => {
        const left = a.metadata?.originalURL || a.name;
        const right = b.metadata?.originalURL || b.name;
        return String(left).localeCompare(String(right));
      });
      const total = entries.reduce(
        (sum, entry) => sum + Number(entry.metadata?.originalSize || entry.size || 0),
        0
      );
      this.cacheSummaryEl.textContent = entries.length
        ? `${entries.length} file${entries.length === 1 ? "" : "s"} · ${this.formatBytes(total)}`
        : "No cached model files.";
      this.cacheClearButton.disabled = entries.length === 0 || this.loading;
      if (!entries.length) {
        this.cacheListEl.appendChild(
          el("div", "cache-empty", "No cached models. Select a model to download it.")
        );
        return;
      }
      for (const entry of entries) {
        const url = entry.metadata?.originalURL || "";
        const name = url ? url.split("/").pop() : entry.name;
        const size = entry.metadata?.originalSize || entry.size;
        const item = el("div", "cache-item");
        item.appendChild(el("div", "cache-item-name", name || entry.name));
        item.appendChild(el("div", "cache-item-size", this.formatBytes(size)));
        const remove = el("button", "btn ghost cache-item-clear", "Clear");
        remove.type = "button";
        remove.title = "Remove this file from the browser cache";
        remove.disabled = this.loading;
        remove.addEventListener("click", () => this.clearCacheEntry(entry));
        item.appendChild(remove);
        item.appendChild(el("div", "cache-item-url", url || entry.name));
        item.title = url || entry.name;
        this.cacheListEl.appendChild(item);
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.cacheSummaryEl.textContent = "Could not read the browser cache.";
      this.cacheListEl.appendChild(el("div", "cache-empty error", message));
      this.cacheClearButton.disabled = true;
    }
  }

  async clearCacheEntry(entry) {
    if (this.loading) return;
    const label = entry.metadata?.originalURL || entry.name;
    try {
      await this.getCacheManager().delete(entry.name);
      await this.refreshCache();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.cacheSummaryEl.textContent = `Could not clear ${label}.`;
      this.cacheListEl.appendChild(el("div", "cache-empty error", message));
    }
  }

  async clearCache() {
    this.cacheClearButton.disabled = true;
    this.cacheSummaryEl.textContent = "Clearing cache…";
    try {
      await this.getCacheManager().clear();
      await this.refreshCache();
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      this.cacheSummaryEl.textContent = "Could not clear the browser cache.";
      this.cacheListEl.innerHTML = "";
      this.cacheListEl.appendChild(el("div", "cache-empty error", message));
    }
  }

  updateComposer() {
    this.modelSelect.disabled = this.loading || this.generating;
    this.stopEl.classList.toggle("hidden", !this.generating);
  }

  scrollToBottom() {
    if (!this.autoScroll) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  hideWelcome() {
    $("welcome")?.remove();
  }

  addUserMessage(text) {
    this.hideWelcome();
    const message = el("div", "msg msg-user");
    message.appendChild(el("div", "msg-label", "You"));
    const body = el("div", "msg-body");
    body.textContent = text;
    message.appendChild(body);
    this.messagesEl.appendChild(message);
    this.scrollToBottom();
    return message;
  }

  addAssistantBubble() {
    this.hideWelcome();
    const message = el("div", "msg msg-assistant");
    message.appendChild(el("div", "msg-label", "Assistant"));
    const body = el("div", "msg-body streaming");
    message.appendChild(body);
    const thinking = el("div", "thinking", "Thinking...");
    message.insertBefore(thinking, body);
    const thinkingStart = Date.now();
    let thinkingDetail = "";
    const renderThinking = () => {
      if (!thinking.isConnected) {
        clearInterval(thinkingTimer);
        return;
      }
      const seconds = Math.max(1, Math.round((Date.now() - thinkingStart) / 1000));
      const detail = thinkingDetail ? ` · ${thinkingDetail}` : "";
      thinking.textContent = `Thinking... ${seconds}s${detail}`;
    };
    const thinkingTimer = setInterval(renderThinking, 1000);
    renderThinking();
    let reasoning = null;
    let reasoningDetails = null;
    this.messagesEl.appendChild(message);
    this.scrollToBottom();

    return {
      el: message,
      body,
      setThinking: (detail) => {
        thinkingDetail = String(detail || "");
        renderThinking();
      },
      setText: (text) => {
        thinking.remove();
        body.textContent = text;
        this.scrollToBottom();
      },
      setReasoning: (text) => {
        thinking.remove();
        if (!reasoning) {
          reasoningDetails = el("details", "reasoning streaming");
          reasoningDetails.open = true;
          reasoningDetails.appendChild(el("summary", "", "Reasoning"));
          const content = el("div");
          reasoningDetails.appendChild(content);
          message.insertBefore(reasoningDetails, body);
          reasoning = content;
        }
        reasoning.textContent = text;
        this.scrollToBottom();
      },
      finalize: (text) => {
        clearInterval(thinkingTimer);
        thinking.remove();
        reasoningDetails?.classList.remove("streaming");
        body.classList.remove("streaming");
        body.innerHTML = renderMarkdown(text);
        this.scrollToBottom();
      },
      stop: () => {
        clearInterval(thinkingTimer);
        thinking.remove();
        reasoningDetails?.classList.remove("streaming");
        body.classList.remove("streaming");
      },
      remove: () => {
        clearInterval(thinkingTimer);
        message.remove();
      },
    };
  }

  addToolCallCard(name, input, placeholder = "(missing input)") {
    this.hideWelcome();
    const message = el("div", "msg msg-tool");
    message.appendChild(el("div", "msg-label", `⚙ ${name}`));
    message.appendChild(el("pre", "tool-sql", input || placeholder));
    this.messagesEl.appendChild(message);
    this.scrollToBottom();
    return message;
  }

  addToolResultCard(result, ok, name = "query") {
    const message = el("div", `msg ${ok ? "msg-tool" : "msg-error"}`);
    message.appendChild(el("div", "msg-label", ok ? `↩ ${name} result` : `↩ ${name} error`));
    const body = el("div", "tool-result");
    const details = el("details");
    const summary = el("summary", "", ok ? "Show result (also in shell)" : "Show error");
    if (name === "help") {
      details.open = true;
      summary.textContent = ok ? "DuckDB manual results" : "DuckDB manual error";
    }
    details.appendChild(summary);
    const content = el("div", "md");
    if (name === "query" && /[┌└├│]/.test(result)) {
      // Box-drawing output needs its spacing preserved.
      content.innerHTML = `<pre>${escapeHtml(result)}</pre>`;
    } else {
      content.innerHTML = renderMarkdown(result);
    }
    details.appendChild(content);
    body.appendChild(details);
    message.appendChild(body);
    this.messagesEl.appendChild(message);
    this.scrollToBottom();
    return message;
  }

  addErrorMessage(text) {
    this.hideWelcome();
    const message = el("div", "msg msg-error");
    message.appendChild(el("div", "msg-label", "Error"));
    const body = el("div", "msg-body");
    body.textContent = text;
    message.appendChild(body);
    this.messagesEl.appendChild(message);
    this.scrollToBottom();
    return message;
  }

  newChat() {
    if (this.pendingPrompt) {
      this.pendingPrompt.resolve();
      this.pendingPrompt = null;
    }
    if (this.generating) {
      this.suppressAbortMessage = true;
      this.stop();
    }
    this.historyIndex = -1;
    this.historyDraft = "";
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
    this.contextUsed = 0;
    this.updateContextBadge();
    this.messagesEl.innerHTML = "";
    const welcome = el("div", "welcome");
    welcome.id = "welcome";
    welcome.innerHTML =
      "<strong>Ask questions about your DuckDB data.</strong><br>" +
      "The assistant can call <code>query(...)</code> to inspect tables, columns, " +
      "schemas, and data, and <code>help(...)</code> to search the bundled DuckDB " +
      "manual. Query results appear in the shell on the left in the selected output mode, " +
      "and the last 500 lines of shell output are sent with each message so you can ask " +
      "about earlier results. Try: " +
      "<em>“List the tables and their columns.”</em>";
    this.messagesEl.appendChild(welcome);
    this.inputEl.value = "";
    this.autoResize();
    this.setStatus(this.modelLoaded ? "Ready." : "Load a model to start.", this.modelLoaded ? "ready" : "");
    this.updateComposer();
  }

  async loadModel(key) {
    if (this.loading || this.generating) return;
    const resolvedKey = MODELS[key] ? key : this.modelKey;
    const model = MODELS[resolvedKey];
    this.modelKey = resolvedKey;
    this.sampling = model.sampling || { temperature: 0.9, top_p: 0.95, repeat_penalty: 1.0 };
    if (this.modelSelect) this.modelSelect.value = resolvedKey;
    this.modelLoaded = false;
    this.loading = true;
    this.updateComposer();
    this.setProgress(0);
    this.setPercent(0);
    this.subtitleEl.textContent = model.subtitle;
    this.contextUsed = 0;
    this.setContextMax(model.nCtx, false);
    this.setStatus(
      `Loading ${model.label} (${model.size}) on ${this.useGpu ? "GPU" : "CPU"}…`
    );

    if (this.wllama) {
      try {
        await this.wllama.exit();
      } catch {
        // Ignore cleanup errors.
      }
      this.wllama = null;
    }

    const wllama = new Wllama({
      default: WLLAMA_WASM_PATH,
    });
    this.wllama = wllama;

    try {
      await wllama.loadModelFromHF(
        { repo: model.repo, file: model.file },
        {
          n_ctx: model.nCtx,
          n_gpu_layers: this.useGpu ? 9999 : 0,
          cache_type_k: "q8_0",
          cache_type_v: "q8_0",
          reasoning: true,
          reasoning_budget_tokens: 512,
          reasoning_format: "deepseek",
          progressCallback: ({ loaded, total }) => {
            const value = total
              ? Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
              : null;
            if (value != null) this.setProgress(value);
            this.setPercent(value);
            this.setStatus(
              value === 100
                ? `Loading ${model.label} into memory...`
                : `Downloading ${model.label}...`
            );
          },
        }
      );
      this.modelLoaded = true;
      let loadedCtx = model.nCtx;
      try {
        loadedCtx = wllama.getLoadedContextInfo().n_ctx || model.nCtx;
      } catch {
        // Keep the configured context length.
      }
      this.setContextMax(loadedCtx, true);
      this.setProgress(null);
      this.setPercent(null);
      this.setStatus("Model ready.", "ready");
      this.shell.animateDuck();
    } catch (error) {
      this.setProgress(null);
      this.setPercent(null);
      const message = error && error.message ? error.message : String(error);
      this.setStatus(`Model load failed: ${message}`, "error");
      this.addErrorMessage(
        `Could not load ${model.label}. ${message}\n\n` +
        "If WebGPU is unavailable, launch Chromium with:\n" +
        "ungoogled-chromium --enable-unsafe-webgpu --enable-features=Vulkan " +
        window.location.href
      );
    } finally {
      this.loading = false;
      this.updateComposer();
      if (this.cacheDialog.open) this.refreshCache();
    }
  }

  send() {
    const text = this.inputEl.value.trim();
    if (!text || !this.modelLoaded) return Promise.resolve();
    this.rememberPrompt(text);
    this.inputEl.value = "";
    this.autoResize();
    this.updateComposer();

    if (this.generating) {
      if (this.pendingPrompt) this.pendingPrompt.resolve();
      const queued = new Promise((resolve) => {
        this.pendingPrompt = { text, resolve };
      });
      this.stop();
      return queued;
    }
    return this.startPrompt(text);
  }

  shellContext() {
    const output = this.shell.recentOutput(SHELL_CONTEXT_LINES).trim();
    if (!output) return "";
    return `${SHELL_CONTEXT_OPEN}\n${output}\n${SHELL_CONTEXT_CLOSE}`;
  }

  stripShellContext() {
    for (const message of this.messages) {
      if (message.role !== "user" || typeof message.content !== "string") continue;
      const start = message.content.indexOf(SHELL_CONTEXT_OPEN);
      if (start !== -1) message.content = message.content.slice(0, start).trimEnd();
    }
  }

  async startPrompt(text) {
    const turnId = ++this.turnId;
    this.addUserMessage(text);
    this.stripShellContext();
    const context = this.shellContext();
    this.messages.push({
      role: "user",
      content: context ? `${text}\n\n${context}` : text,
    });
    this.generating = true;
    this.streamStarted = false;
    this.abortController = new AbortController();
    this.autoScroll = true;
    this.updateComposer();
    this.setStatus("Thinking…");

    try {
      await this.runAssistantTurn(turnId);
      if (turnId !== this.turnId) return;
      this.setStatus("Ready.", "ready");
    } catch (error) {
      if (turnId !== this.turnId) return;
      if (error && (error.name === "AbortError" || /abort/i.test(String(error.message)))) {
        this.sanitizeAbortedMessages();
        if (!this.pendingPrompt && !this.suppressAbortMessage) {
          this.addErrorMessage("Generation stopped.");
          this.setStatus("Stopped.");
        }
      } else {
        const message = error && error.message ? error.message : String(error);
        this.addErrorMessage(message);
        this.setStatus(`Error: ${message}`, "error");
      }
    } finally {
      if (turnId !== this.turnId) return;
      this.activeBubble?.stop();
      this.activeBubble = null;
      this.generating = false;
      this.abortController = null;
      this.suppressAbortMessage = false;
      this.updateComposer();
      const next = this.pendingPrompt;
      this.pendingPrompt = null;
      if (next) {
        this.startPrompt(next.text).then(
          () => next.resolve(),
          () => next.resolve()
        );
      }
    }
  }

  stop() {
    if (!this.abortController) return;
    const prefill = this.generating && !this.streamStarted;
    this.abortController.abort();
    if (prefill) this.stopPrefill();
  }

  // Prompt processing runs inside the wasm worker and cannot see the abort
  // signal until the first token. Terminate the worker instead of waiting.
  stopPrefill() {
    this.turnId++;
    this.generating = false;
    this.abortController = null;
    this.streamStarted = false;
    this.activeBubble?.remove();
    this.activeBubble = null;
    const next = this.pendingPrompt;
    this.pendingPrompt = null;
    this.modelLoaded = false;
    this.loading = false;
    this.suppressAbortMessage = false;
    this.setStatus("Stopped. Reloading model...");
    this.updateComposer();
    if (!next) this.addErrorMessage("Generation stopped.");
    const dying = this.wllama;
    this.wllama = null;
    if (dying) dying.exit().catch(() => {});
    this.loadModel(this.modelKey).then(
      () => {
        if (next) {
          next.resolve();
          this.startPrompt(next.text);
        }
      },
      (error) => {
        const message = error && error.message ? error.message : String(error);
        this.addErrorMessage(message);
        this.setStatus(`Error: ${message}`, "error");
      }
    );
  }

  throwIfAborted() {
    if (this.abortController?.signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
  }

  sanitizeAbortedMessages() {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const message = this.messages[i];
      if (message.role === "assistant" && message.tool_calls) {
        const pending = new Set(message.tool_calls.map((call) => call.id));
        let j = i + 1;
        while (j < this.messages.length && this.messages[j].role === "tool") {
          pending.delete(this.messages[j].tool_call_id);
          j++;
        }
        if (pending.size) this.messages.length = i;
        return;
      }
      if (message.role === "user") return;
    }
  }

  async runAssistantTurn(turnId) {
    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      if (turnId !== this.turnId) return;
      this.throwIfAborted();
      const bubble = this.addAssistantBubble();
      this.activeBubble = bubble;
      let content = "";
      let reasoning = "";
      let finishReason = null;
      const toolCalls = new Map();

      console.log("DuckDB chat prompt", JSON.stringify(this.messages, null, 2));

      this.streamStarted = false;
      const stream = await this.wllama.createChatCompletion({
        messages: this.messages,
        tools: TOOLS,
        tool_choice: "auto",
        temperature: this.sampling.temperature,
        min_p: 0.0,
        top_p: this.sampling.top_p,
        top_k: this.sampling.top_k,
        repeat_penalty: this.sampling.repeat_penalty ?? 1.05,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
        abortSignal: this.abortController?.signal,
        timings_per_token: true,
      });

      for await (const chunk of stream) {
        if (turnId !== this.turnId) return;
        if (chunk.prompt_progress && chunk.prompt_progress.total) {
          const { processed, total } = chunk.prompt_progress;
          bubble.setThinking(`Reading prompt ${processed}/${total}`);
        }

        // Timings and usage may arrive on chunks without choices (the
        // final usage chunk has an empty choices array).
        const timings = chunk.timings;
        if (timings) {
          const used =
            (timings.cache_n || 0) + (timings.prompt_n || 0) + (timings.predicted_n || 0);
          if (used > 0) this.setContextUsed(used);
          const parts = [];
          if (timings.predicted_n) parts.push(`${timings.predicted_n} tokens`);
          if (timings.predicted_per_second) {
            parts.push(`${timings.predicted_per_second.toFixed(1)} t/s`);
          }
          if (parts.length) {
            bubble.setThinking(parts.join(" · "));
          }
          if (timings.predicted_per_second) {
            this.setStatus(`Generating · ${timings.predicted_per_second.toFixed(1)} t/s`);
          }
        }
        if (chunk.usage && Number.isFinite(chunk.usage.total_tokens)) {
          this.setContextUsed(chunk.usage.total_tokens);
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        this.streamStarted = true;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};

        const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta) {
          reasoning += reasoningDelta;
          bubble.setReasoning(reasoning);
        }
        if (delta.content) {
          content += delta.content;
          bubble.setText(content);
        }
        if (delta.tool_calls) {
          for (const toolCall of delta.tool_calls) {
            const index = toolCall.index ?? 0;
            if (!toolCalls.has(index)) {
              toolCalls.set(index, { id: "", name: "", arguments: "" });
            }
            const entry = toolCalls.get(index);
            if (toolCall.id) entry.id = toolCall.id;
            if (toolCall.function?.name) entry.name += toolCall.function.name;
            if (toolCall.function?.arguments) entry.arguments += toolCall.function.arguments;
          }
        }

      }

      if (turnId !== this.turnId) return;
      this.throwIfAborted();
      const calls = [...toolCalls.values()].filter((call) => call.name);
      if (finishReason === "length") {
        this.activeBubble = null;
        if (calls.length > 0) {
          bubble.remove();
          this.addErrorMessage(
            `The model hit the ${MAX_OUTPUT_TOKENS}-token limit while preparing a tool call. Try a shorter prompt or a larger model.`
          );
        } else if (content.trim()) {
          const truncated = `${content}\n\n_Response truncated at the ${MAX_OUTPUT_TOKENS}-token limit._`;
          bubble.finalize(truncated);
          this.messages.push({ role: "assistant", content: truncated });
        } else {
          bubble.remove();
          this.addErrorMessage(
            `The model hit the ${MAX_OUTPUT_TOKENS}-token limit while reasoning and did not call a tool. Try a shorter prompt or a larger model.`
          );
        }
        return;
      }
      if (finishReason === "tool_calls" && calls.length > 0) {
        if (content.trim()) {
          bubble.finalize(content);
        } else {
          bubble.remove();
        }
        this.activeBubble = null;

        const assistantMessage = {
          role: "assistant",
          content: content || null,
          reasoning: reasoning || undefined,
          tool_calls: calls.map((call, index) => ({
            id: call.id || `call_${Date.now()}_${index}`,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments || "{}",
            },
          })),
        };
        this.messages.push(assistantMessage);

        for (const call of assistantMessage.tool_calls) {
          if (turnId !== this.turnId) return;
          this.throwIfAborted();
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }
          const name = call.function.name;
          const sql = String(args.query ?? args.sql ?? "").trim();
          const keywords = String(args.keywords ?? args.query ?? args.sql ?? "").trim();
          this.addToolCallCard(
            name,
            name === "help" ? keywords : sql,
            name === "help" ? "(missing keywords)" : "(missing query)"
          );

          let result;
          let ok = false;
          if (name === "query") {
            if (!sql) {
              result = "Error: the query argument is required.";
            } else {
              this.setStatus("Running query in shell…");
              const queryResult = await this.shell.runQuery(sql, { source: "chat" });
              ok = queryResult.ok;
              result = ok
                ? `SQL: ${sql}\n\n${queryResult.markdown || "Statement executed successfully. No rows returned."}`
                : `SQL: ${sql}\n\nError: ${queryResult.error}`;
            }
          } else if (name === "help") {
            if (!keywords) {
              result = "Error: the keywords argument is required.";
            } else {
              this.setStatus("Searching DuckDB manual…");
              try {
                result = await searchDuckDBDocs(keywords);
                ok = true;
              } catch (error) {
                const message = error && error.message ? error.message : String(error);
                result = `Error searching the DuckDB manual: ${message}`;
              }
            }
          } else {
            result = `Error: unknown tool "${name}".`;
          }

          this.throwIfAborted();
          if (turnId !== this.turnId) return;
          this.addToolResultCard(result, ok, name);
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
        continue;
      }

      // No tool call: this is the final answer.
      this.throwIfAborted();
      if (!content.trim()) {
        bubble.remove();
        this.addErrorMessage("The model returned an empty response.");
      } else {
        bubble.finalize(content);
      }
      this.activeBubble = null;
      this.messages.push({ role: "assistant", content: content || "" });
      return;
    }

    this.addErrorMessage("Stopped after too many tool calls. Please ask a more specific question.");
  }
}
