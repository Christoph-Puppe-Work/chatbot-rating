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
      'button.send-button.submit',
      'button.send-button',
      'button[mat-icon-button][aria-label*="senden"]',
      'button[mat-icon-button][aria-label*="Send"]',
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

  async function ask(question, { maxWaitMs = 180000 } = {}) {
    B.log("gemini: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: 30000 });
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
    const appeared = await B.waitForSelector([SEL.markdownPanel], { timeoutMs: 30000 });
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

      // Primary exit: Gemini explicitly tells us it is done via the DOM, and text is stable
      // The 2500ms buffer prevents exiting in the tiny gap before streaming begins.
      if (text.length >= 10 && !isBusy && stableFor >= 2500) {
        const ms = Date.now() - tStart;
        B.log(`gemini: aria-busy=false after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Safety fallback: If aria-busy gets stuck but text hasn't changed in 60s
      // Background tabs freeze text updates, so this MUST be longer than a full response generation.
      if (text.length >= 10 && isBusy && stableFor >= 60000) {
        const ms = Date.now() - tStart;
        B.log(`gemini: stable-fallback after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }

    if (lastText.length < 10) throw new Error(`gemini: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`gemini: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "gemini", ask };
  B.log("gemini adapter ready (fresh-tab)");
})();