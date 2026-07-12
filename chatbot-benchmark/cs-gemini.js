// cs-gemini.js — adapter for gemini.google.com/app
// Fresh-tab strategy: one question per tab, DOM starts empty.

(function () {
  const B = window.__BENCH__;
  if (!B) { console.error("[bench] shared utils missing"); return; }

  const SEL = {
    composer: [
      'rich-textarea div.ql-editor[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendBtn: [
      // Current Gemini (2026): an mdc-icon-button labelled by locale — "Send message" (en) /
      // "Nachricht senden" (de) / "Prompt senden" — with a mat-icon "arrow_upward". The old
      // .send-button class is gone. Match by aria-label (exact first, then locale-fuzzy).
      'button[aria-label="Send message"]',
      'button[aria-label="Nachricht senden"]',
      'button[aria-label="Prompt senden"]',
      'button[aria-label*="send message" i]',
      'button[aria-label*="senden" i]',
      'button.send-button.submit',
      'button.send-button',
    ],
    // The single source of truth for the response text and streaming state
    markdownPanel: '.markdown.markdown-main-panel',
  };

  /**
   * Safely extract text in background tabs.
   * Includes logic to prevent duplicating text from nested block elements.
   */
  function extractText(el) {
    if (!el) return "";

    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE'];
    const blocks = el.querySelectorAll(blockTags.join(', '));

    if (blocks.length > 0) {
      const topLevelBlocks = Array.from(blocks).filter(node => {
        let parent = node.parentElement;
        while (parent && parent !== el) {
          if (blockTags.includes(parent.tagName)) return false;
          parent = parent.parentElement;
        }
        return true;
      });

      return topLevelBlocks
        .map(b => (b.textContent || "").trim())
        .filter(Boolean)
        .join("\n\n");
    }

    return (el.innerText || el.textContent || "").trim();
  }

  /** Re-query the DOM every poll to avoid stale Angular references. */
  function queryResponse() {
    const panel = document.querySelector(SEL.markdownPanel);
    if (!panel) return { text: "", isBusy: true };

    return {
      text: extractText(panel),
      // If the attribute is literally "false", it's done. Otherwise assume busy.
      isBusy: panel.getAttribute("aria-busy") !== "false"
    };
  }

  async function ask(question, { maxWaitMs = 300000 } = {}) {
    B.log("gemini: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: maxWaitMs });
    if (!composer) throw new Error("gemini composer not found");

    B.log("gemini: typing question…");
    await B.setComposerText(composer, question);
    await B.sleep(600);

    B.log("gemini: clicking send…");
    const tStart = Date.now();
    let sendBtn = B.pickOne(SEL.sendBtn);
    while (sendBtn && (sendBtn.disabled || sendBtn.getAttribute("aria-disabled") === "true") && Date.now() - tStart < 5000) {
      await B.sleep(150);
      sendBtn = B.pickOne(SEL.sendBtn);
    }

    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
      B.realClick(sendBtn);
    } else {
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }

    B.log("gemini: waiting for response panel…");
    // Wait exclusively for the markdown panel, bypassing intermediate loading wrappers
    const appeared = await B.waitForSelector([SEL.markdownPanel], { timeoutMs: Math.max(0, maxWaitMs - (Date.now() - tStart)) });
    if (!appeared) throw new Error("gemini: no response panel appeared");

    B.log("gemini: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const { text, isBusy } = queryResponse();

      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }

      const stableFor = Date.now() - lastChange;

      // Fast path: Gemini clears aria-busy AND text is stable. The 2500ms buffer avoids the
      // tiny gap before streaming begins. >= 1 (not 10): NP answers are single option digits.
      if (text.length >= 1 && !isBusy && stableFor >= 2500) {
        const ms = Date.now() - tStart;
        B.log(`gemini: aria-busy=false after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Primary done-signal: TEXT STABILITY, independent of aria-busy. Measured live, Gemini keeps
      // aria-busy="true" (and the stop button visible) for ~15s AFTER the answer text is fully
      // rendered — post-gen safety/grounding. Waiting for aria-busy=false therefore idles ~15s per
      // ask, and if trailing citations mutate the DOM the old 60s window never elapsed and the lane
      // rode out to maxWaitMs. The content script holds a Web Lock so the tab does NOT freeze (the
      // old comment's premise), which makes wall-clock text stability a reliable "done" marker.
      if (text.length >= 1 && stableFor >= 6000) {
        const ms = Date.now() - tStart;
        B.log(`gemini: text stable ${stableFor}ms (aria-busy=${isBusy}) after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }

    if (lastText.length < 1) throw new Error(`gemini: timeout, response empty`);
    const ms = Date.now() - tStart;
    B.log(`gemini: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "gemini", ask };
  B.log("gemini adapter ready (fresh-tab)");
})();