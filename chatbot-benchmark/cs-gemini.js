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
    // Primary: the markdown panel inside the response (has aria-busy)
    markdownPanel: '.markdown.markdown-main-panel',
    // Fallback: the message-content wrapper
    messageContent: 'message-content[id^="message-content-id-r_"]',
    // Fallback 2: the structured-content-container holding the response text
    structuredContent: 'structured-content-container.model-response-text',
  };

  /** Re-query the DOM every poll to avoid stale Angular references. */
  function findResponseText() {
    // Best: the markdown panel has the clean answer text + aria-busy signal
    const panel = document.querySelector(SEL.markdownPanel);
    if (panel) {
      return {
        text: (panel.innerText || "").trim(),
        ariaBusy: panel.getAttribute("aria-busy"),
      };
    }
    // Fallback: message-content wrapper (last one on page)
    const msgs = document.querySelectorAll(SEL.messageContent);
    if (msgs.length) {
      const last = msgs[msgs.length - 1];
      return { text: (last.innerText || "").trim(), ariaBusy: null };
    }
    // Fallback 2: structured-content-container
    const sc = document.querySelector(SEL.structuredContent);
    if (sc) {
      return { text: (sc.innerText || "").trim(), ariaBusy: null };
    }
    return { text: "", ariaBusy: null };
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

    B.log("gemini: waiting for response element…");
    // Wait until we see SOME response element appear
    const appeared = await B.waitForSelector(
      [SEL.markdownPanel, SEL.messageContent, SEL.structuredContent],
      { timeoutMs: 30000 }
    );
    if (!appeared) throw new Error("gemini: no response element appeared");

    B.log("gemini: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();
    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const { text, ariaBusy } = findResponseText();
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }
      const ariaBusyDone = ariaBusy === "false";
      const stableFor = Date.now() - lastChange;
      if (text.length >= 10 && (ariaBusyDone || stableFor >= 5000)) {
        const ms = Date.now() - tStart;
        B.log(`gemini: ${ariaBusyDone ? "aria-busy" : "stable"} after ${ms}ms, ${text.length} chars`);
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
