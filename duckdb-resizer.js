// ---------------------------------------------------------------------------
// Mouse-resizable split between the shell and chat panels
// ---------------------------------------------------------------------------

import { $ } from "./duckdb-utils.js";

const STORAGE_KEY = "duckdb-shell:chat-width";
const MIN_CHAT = 380;
const MIN_SHELL = 360;
const KEYBOARD_STEP = 24;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function initPanelResizer() {
  const app = document.querySelector(".app");
  const handle = $("panel-resizer");
  const chatPanel = $("chat-panel");
  if (!app || !handle || !chatPanel) return;

  let desiredWidth = null;
  let drag = null;
  let frame = 0;

  // The handle is hidden by the stacked mobile layout.
  const isActive = () => handle.offsetParent !== null;

  const appContentWidth = () => {
    const style = getComputedStyle(app);
    const left = parseFloat(style.paddingLeft) || 0;
    const right = parseFloat(style.paddingRight) || 0;
    return app.clientWidth - left - right;
  };

  const maxChatWidth = () => {
    const handleWidth = handle.getBoundingClientRect().width || 0;
    return Math.max(MIN_CHAT, appContentWidth() - handleWidth - MIN_SHELL);
  };

  const updateAria = (width = chatPanel.getBoundingClientRect().width) => {
    handle.setAttribute("aria-valuemin", String(MIN_CHAT));
    handle.setAttribute("aria-valuemax", String(Math.round(maxChatWidth())));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
  };

  const setWidth = (width) => {
    const next = clamp(width, MIN_CHAT, maxChatWidth());
    desiredWidth = next;
    app.style.setProperty("--chat-width", `${Math.round(next)}px`);
    updateAria(next);
    return next;
  };

  const save = () => {
    if (desiredWidth == null) return;
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(desiredWidth)));
    } catch {
      // Storage can be unavailable (private mode, file://).
    }
  };

  const reset = () => {
    desiredWidth = null;
    app.style.removeProperty("--chat-width");
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
    requestAnimationFrame(() => updateAria());
  };

  const applyDesired = () => {
    if (desiredWidth == null || !isActive()) return;
    setWidth(desiredWidth);
  };

  // Restore the width chosen in a previous session.
  try {
    const saved = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(saved) && saved > 0) desiredWidth = saved;
  } catch {
    // Ignore.
  }
  applyDesired();
  updateAria();

  const finishDrag = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove("dragging");
    document.body.classList.remove("resizing-panels");
    save();
  };

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !isActive()) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: chatPanel.getBoundingClientRect().width,
    };
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing-panels");
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    setWidth(drag.startWidth - (event.clientX - drag.startX));
  });

  const endPointer = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (handle.hasPointerCapture?.(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    finishDrag();
    handle.focus({ preventScroll: true });
  };

  handle.addEventListener("pointerup", endPointer);
  handle.addEventListener("pointercancel", endPointer);
  handle.addEventListener("lostpointercapture", finishDrag);
  handle.addEventListener("dblclick", reset);

  handle.addEventListener("keydown", (event) => {
    if (!isActive()) return;
    const current = chatPanel.getBoundingClientRect().width;
    let delta = 0;

    if (event.key === "ArrowLeft") {
      delta = KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      delta = -KEYBOARD_STEP;
    } else if (event.key === "Home") {
      delta = MIN_CHAT - current;
    } else if (event.key === "End") {
      delta = maxChatWidth() - current;
    } else if (event.key === "Enter") {
      reset();
      event.preventDefault();
      return;
    } else {
      return;
    }

    event.preventDefault();
    setWidth(current + delta);
    save();
  });

  window.addEventListener("resize", () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!isActive()) return;
      if (desiredWidth == null) updateAria();
      else applyDesired();
    });
  });
}
