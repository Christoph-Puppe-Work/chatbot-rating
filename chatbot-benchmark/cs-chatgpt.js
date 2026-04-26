// cs-chatgpt.js — adapter for chatgpt.com
// Fresh-tab strategy: one question per tab, DOM starts empty.

(function () {
  const B = window.__BENCH__;
  if (!B) { console.error("[bench] shared utils missing"); return; }

  const SEL = {
    composer: [
      '#prompt-textarea',
      'div[contenteditable="true"]#prompt-textarea',
      'textarea[name="prompt-textarea"]',
      'div[contenteditable="true"]',
    ],
    sendBtn: [
      '#composer-submit-button[data-testid="send-button"]',
      'button[data-testid="send-button"]',
      '#composer-submit-button',
    ],
    stopBtn: 'button[data-testid="stop-button"]',
    streamingClass: '.streaming-animation',
    assistantMsg: 'div[data-message-author-role="assistant"]',
    msgBody: '.markdown.prose',
  };

  async function ask(question, { maxWaitMs = 180000 } = {}) {
    B.log("chatgpt: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: 30000 });
    if (!composer) throw new Error("chatgpt composer not found");

    B.log("chatgpt: typing question…");
    await B.setComposerText(composer, question);
    await B.sleep(400);

    B.log("chatgpt: submitting…");
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

    // wait for the (only) assistant message
    B.log("chatgpt: waiting for assistant message…");
    const msg = await B.waitForSelector([SEL.assistantMsg], { timeoutMs: 25000 });
    if (!msg) throw new Error("chatgpt: no assistant message appeared");

    B.log("chatgpt: watching for completion (quiet+stable)…");
    let lastText = "";
    let lastChange = Date.now();
    let quietSince = null;

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const body = msg.querySelector(SEL.msgBody) || msg;
      const text = (body.innerText || "").trim();
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }
      const stopExists = !!document.querySelector(SEL.stopBtn);
      const streamingEl = msg.querySelector(SEL.streamingClass);
      const isStreaming = stopExists || !!streamingEl;
      if (isStreaming) {
        quietSince = null;
        continue;
      }
      if (quietSince === null) quietSince = Date.now();
      const quietFor = Date.now() - quietSince;
      const stableFor = Date.now() - lastChange;
      if (text.length >= 100 && quietFor >= 1500 && stableFor >= 800) {
        const ms = Date.now() - tStart;
        B.log(`chatgpt: quiet+stable after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }
    if (lastText.length < 30) throw new Error(`chatgpt: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`chatgpt: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "chatgpt", ask };
  B.log("chatgpt adapter ready (fresh-tab)");
})();
