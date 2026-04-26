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
    messageContent: 'message-content[id^="message-content-id-r_"]',
    markdownPanel: '.markdown.markdown-main-panel',
  };

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
    if (sendBtn) {
      B.realClick(sendBtn);
    } else {
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }

    B.log("gemini: waiting for message-content…");
    const msg = await B.waitForSelector([SEL.messageContent], { timeoutMs: 30000 });
    if (!msg) throw new Error("gemini: no message-content appeared");

    B.log("gemini: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();
    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const panel = msg.querySelector(SEL.markdownPanel);
      const text = panel ? (panel.innerText || "").trim() : "";
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }
      const busy = panel?.getAttribute("aria-busy");
      const ariaBusyDone = busy === "false";
      const stableFor = Date.now() - lastChange;
      if (text.length >= 100 && (ariaBusyDone || stableFor >= 5000)) {
        const ms = Date.now() - tStart;
        B.log(`gemini: ${ariaBusyDone ? "aria-busy" : "stable"} after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }
    if (lastText.length < 30) throw new Error(`gemini: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`gemini: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "gemini", ask };
  B.log("gemini adapter ready (fresh-tab)");
})();
