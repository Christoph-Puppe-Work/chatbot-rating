// cs-grok.js — adapter for grok.com
// Fresh-tab strategy: one question per tab, DOM starts empty.

(function () {
  const B = window.__BENCH__;
  if (!B) { console.error("[bench] shared utils missing"); return; }

  const SEL = {
    composer: [
      'div.tiptap.ProseMirror[contenteditable="true"]',
      'div[data-testid="chat-input"] div[contenteditable="true"]',
      'div.ProseMirror[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    submitBtn: [
      'button[data-testid="chat-submit"]',
      'form button[type="submit"]',
      'form button[aria-label*="bsenden" i]',
      'form button[aria-label*="Submit"]',
    ],
    assistantMsg: 'div[data-testid="assistant-message"]',
    msgBody: '.response-content-markdown.markdown',
    actionButtons: '.action-buttons',
  };

  function findContainerFor(msgEl) {
    let n = msgEl;
    while (n && n !== document.body) {
      if (n.id && n.id.startsWith("response-")) return n;
      n = n.parentElement;
    }
    return null;
  }

  async function ask(question, { maxWaitMs = 180000 } = {}) {
    B.log("grok: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: 30000 });
    if (!composer) throw new Error("grok composer not found");

    B.log("grok: typing question…");
    await B.setComposerText(composer, question);
    await B.sleep(400);

    B.log("grok: submitting…");
    const tStart = Date.now();
    let submitBtn = B.pickOne(SEL.submitBtn);
    while (submitBtn && (submitBtn.disabled || submitBtn.getAttribute("aria-disabled") === "true") && Date.now() - tStart < 5000) {
      await B.sleep(150);
      submitBtn = B.pickOne(SEL.submitBtn);
    }
    if (submitBtn) {
      B.realClick(submitBtn);
    } else {
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }

    B.log("grok: waiting for assistant message…");
    const msg = await B.waitForSelector([SEL.assistantMsg], { timeoutMs: 30000 });
    if (!msg) throw new Error("grok: no assistant message appeared");
    const container = findContainerFor(msg);

    B.log("grok: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();
    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const body = msg.querySelector(SEL.msgBody) || msg;
      const text = (body.innerText || "").trim();
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }
      const actions = container?.querySelector(SEL.actionButtons);
      const hasLastResponse = actions && actions.classList.contains("last-response");
      const stableFor = Date.now() - lastChange;
      if (text.length >= 100 && (hasLastResponse || stableFor >= 4000)) {
        const ms = Date.now() - tStart;
        B.log(`grok: ${hasLastResponse ? "last-response" : "stable"} after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }
    if (lastText.length < 30) throw new Error(`grok: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`grok: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "grok", ask };
  B.log("grok adapter ready (fresh-tab)");
})();
