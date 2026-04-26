// cs-shared.js — utilities loaded into every chatbot page before its specific script.
// Defines `BENCH` on window with helpers each chatbot script implements its adapter on top of.

(function () {
  if (window.__BENCH__) return; // double-load guard

  const log = (...args) => console.log("%c[bench]", "color:#ff9021;font-weight:bold", ...args);
  const err = (...args) => console.error("%c[bench]", "color:#ff5f56;font-weight:bold", ...args);

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Try a list of selectors, return first match (or null).
  function pickOne(selectors, root = document) {
    for (const s of selectors) {
      const el = root.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // Wait until a selector resolves to an element, with timeout.
  async function waitForSelector(selectors, { timeoutMs = 30000, root = document } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = pickOne(selectors, root);
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  // Insert text into a composer. Supports <textarea>, <input>, and contenteditable
  // (including ProseMirror / Quill which need a beforeinput event).
  async function setComposerText(el, text) {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Use native setter so React/Vue see the change
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (el.isContentEditable) {
      // try beforeinput first (works for ProseMirror, Lexical, Quill)
      const ev = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      });
      const handled = !el.dispatchEvent(ev);
      if (!handled) {
        // fallback: textContent + input event
        el.textContent = text;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      }
      return;
    }
    throw new Error("composer element type not recognised");
  }

  // Click a real button via dispatching pointer events (more robust than .click()
  // for sites that hook pointer down/up).
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  // -------- universal response capture (selector-free) --------
  //
  // Strategy: instead of guessing where the assistant message lives in the DOM,
  // we snapshot all text-bearing elements BEFORE submit, then poll the page
  // looking for the element that:
  //   (a) doesn't contain our question text (= isn't the user-message bubble)
  //   (b) has grown significantly since snapshot (= is the streaming response)
  //   (c) has the most text content (= the full response, not a sub-paragraph)
  // Wait until that element's text stays stable for `stableMs`.
  //
  // This works on every chatbot because it doesn't depend on knowing their DOM.

  const TEXT_SELECTOR = "div, article, section, p, main, span, li, blockquote";

  function snapshotTextLengths(minLen = 30) {
    const m = new WeakMap();
    document.querySelectorAll(TEXT_SELECTOR).forEach(el => {
      const t = (el.innerText || "").trim();
      if (t.length >= minLen) m.set(el, t.length);
    });
    return m;
  }

  async function captureResponseUniversal({
    snapshot,
    question,
    maxWaitMs = 120000,
    stableMs = 2500,
    pollMs = 400,
    minLen = 50,
    minGrowth = 30,
    busyAttrSelector = null,    // optional: '.markdown-main-panel[aria-busy]'
    streamingClassSelector = null, // optional: '.streaming-animation' — done when GONE
    stopButtonSelector = null,  // optional: 'button[data-testid="stop-button"]' — done when GONE
  }) {
    const start = Date.now();
    const qProbe = (question || "").slice(0, 80).trim();
    let lastText = "";
    let lastChange = start;
    let bestEl = null;
    let observedAt = 0;

    while (Date.now() - start < maxWaitMs) {
      await sleep(pollMs);

      // strong done signals (any of these flipping = response complete)
      let doneSignal = null;

      if (busyAttrSelector) {
        const els = document.querySelectorAll(busyAttrSelector);
        if (els.length > 0 && Array.from(els).every(el => el.getAttribute("aria-busy") === "false")) {
          doneSignal = "aria-busy";
        }
      }
      if (!doneSignal && streamingClassSelector) {
        // we observed a streaming element earlier and now it's gone -> done
        if (observedAt && document.querySelector(streamingClassSelector) === null) {
          doneSignal = "streaming-class-gone";
        }
      }
      if (!doneSignal && stopButtonSelector) {
        if (observedAt && document.querySelector(stopButtonSelector) === null) {
          doneSignal = "stop-button-gone";
        }
      }

      // find candidates that grew vs snapshot AND don't contain the question
      // and AREN'T disclaimer/footer text (a common false-positive)
      const candidates = [];
      document.querySelectorAll(TEXT_SELECTOR).forEach(el => {
        if (!el.isConnected) return;
        const t = (el.innerText || "").trim();
        if (t.length < minLen) return;
        if (qProbe && t.includes(qProbe)) return;
        // blacklist: disclaimer/footer text in any of the 4 chatbot UIs.
        // These strings appear in the legal footers of every chatbot, and
        // would otherwise be mistaken for "the answer" because they're
        // visible and substantial.
        const tLower = t.toLowerCase();
        if (tLower.includes("kann fehler machen") ||
            tLower.includes("can make mistakes") ||
            tLower.includes("double-check") ||
            tLower.includes("überprüfe wichtige informationen") ||
            tLower.includes("cookie-voreinstellungen") ||
            tLower.includes("cookie preferences") ||
            tLower.includes("datenschutz und gemini") ||
            tLower.includes("ki und kann fehler") ||
            tLower.includes("important info")) return;
        const beforeLen = snapshot.get(el) || 0;
        if (t.length < beforeLen + minGrowth) return;
        const onlyChild = el.children.length === 1 ? el.children[0] : null;
        if (onlyChild && (onlyChild.innerText || "").trim() === t) return;
        candidates.push({ el, len: t.length, text: t });
      });

      if (candidates.length === 0) continue;

      candidates.sort((a, b) => b.len - a.len);
      const top = candidates[0];
      if (!observedAt) observedAt = Date.now();

      if (top.text !== lastText) {
        lastText = top.text;
        lastChange = Date.now();
        bestEl = top.el;
        continue;
      }

      // any explicit done signal, OR text stable for stableMs
      if (lastText && (doneSignal || Date.now() - lastChange >= stableMs)) {
        return {
          text: lastText, ms: Date.now() - start,
          reason: doneSignal || "stable",
          el: bestEl, waitedFirstSeenMs: observedAt - start,
        };
      }
    }
    return { text: lastText, ms: Date.now() - start, reason: "timeout", el: bestEl, waitedFirstSeenMs: observedAt ? observedAt - start : null };
  }

  // Watch a function that returns the current assistant-message text.
  // Returns when the text has been stable for `stableMs` (= response finished),
  // or when `maxMs` elapses (= timeout, return what we have).
  // Also accepts a `doneSignal` predicate that, if returns true, ends immediately.
  async function waitForResponse({
    getText,
    doneSignal = () => false,
    stableMs = 2500,
    maxMs = 120000,
    pollMs = 400,
  }) {
    const start = Date.now();
    let lastText = "";
    let lastChange = Date.now();
    while (Date.now() - start < maxMs) {
      await sleep(pollMs);
      try {
        if (doneSignal()) {
          const finalText = getText() || "";
          if (finalText) return { text: finalText, reason: "doneSignal", ms: Date.now() - start };
        }
      } catch {}
      const text = getText() || "";
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
        continue;
      }
      if (text && Date.now() - lastChange >= stableMs) {
        return { text, reason: "stable", ms: Date.now() - start };
      }
    }
    return { text: lastText, reason: "timeout", ms: Date.now() - start };
  }

  // Per-site adapter shape:
  //   window.__BENCH__.adapter = {
  //     name: "claude",
  //     ask: async (question, opts) => ({ answer, durationMs })
  //   }
  // The shared message handler dispatches ASK to whatever adapter has been registered.
  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.type === "PING") {
      reply({ ok: !!window.__BENCH__?.adapter, name: window.__BENCH__?.adapter?.name });
      return true;
    }
    if (msg?.type === "ASK") {
      (async () => {
        const a = window.__BENCH__?.adapter;
        if (!a) { reply({ ok: false, error: "no adapter registered" }); return; }

        // Acquire a Web Lock for the duration of the ask() call.
        // This signals to Chrome that this tab is doing critical work and
        // should NOT be frozen, throttled, or discarded while the lock is held.
        let lockRelease = null;
        const lockPromise = navigator.locks?.request(
          "benchmark-active-" + Date.now(),
          { mode: "exclusive" },
          () => new Promise(resolve => { lockRelease = resolve; })
        );

        try {
          const t0 = performance.now();
          const { answer } = await a.ask(msg.question, { maxWaitMs: msg.maxWaitMs });
          reply({ ok: true, answer: answer || "", durationMs: Math.round(performance.now() - t0) });
        } catch (e) {
          err("ask failed:", e);
          reply({ ok: false, error: String(e?.message || e) });
        } finally {
          // Release the Web Lock — Chrome can now throttle/freeze this tab
          if (lockRelease) lockRelease();
        }
      })();
      return true; // async reply
    }
  });

  window.__BENCH__ = {
    log, err, sleep, pickOne, waitForSelector, setComposerText, realClick, waitForResponse,
    snapshotTextLengths, captureResponseUniversal,
    adapter: null,
  };
  log("shared utilities loaded");
})();
