// cs-claude.js — adapter for claude.ai
//
// Fresh-tab strategy: this script runs in a tab that was just opened for
// EXACTLY ONE question. The DOM starts empty (no prior conversation), so
// we don't need ID diffing, consumed-marking, or stream concurrency
// handling. We just wait for THE answer to appear.

(function () {
  const B = window.__BENCH__;
  if (!B) { console.error("[bench] shared utils missing"); return; }

  const SEL = {
    composer: [
      'div[contenteditable="true"][data-testid="chat-input"]',
      'div.ProseMirror[contenteditable="true"]',
      'fieldset div[contenteditable="true"]',
      'div[contenteditable="true"]',
    ],
    sendBtn: [
      'button[aria-label="Send Message"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Senden"]',
      'button[aria-label*="Send"]',
      'button[type="submit"]',
    ],
    streamingWrapper: 'div[data-is-streaming]',
    markdown: '.standard-markdown, .progressive-markdown',
    responseBody: '.font-claude-response',
  };

  function extractAnswer(wrapper) {
    if (!wrapper) return "";
    const md = wrapper.querySelector(SEL.markdown);
    if (md) return (md.innerText || "").trim();
    const body = wrapper.querySelector(SEL.responseBody);
    if (body) return (body.innerText || "").trim();
    return (wrapper.innerText || "").trim();
  }

  async function ask(question, { maxWaitMs = 180000 } = {}) {
    B.log("claude: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: 30000 });
    if (!composer) throw new Error("claude composer not found");

    B.log("claude: typing question…");
    await B.setComposerText(composer, question);
    await B.sleep(400);

    B.log("claude: submitting…");
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

    // Wait for the streaming wrapper to appear (only one will exist)
    B.log("claude: waiting for streaming wrapper…");
    let wrapper = await B.waitForSelector([SEL.streamingWrapper], { timeoutMs: 25000 });
    if (!wrapper) throw new Error("claude: no streaming wrapper appeared");

    B.log("claude: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();
    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const text = extractAnswer(wrapper);
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }
      const streaming = wrapper.getAttribute("data-is-streaming");
      const streamingDone = streaming === "false";
      const stableFor = Date.now() - lastChange;
      if (text.length >= 100 && (streamingDone || stableFor >= 4000)) {
        const ms = Date.now() - tStart;
        B.log(`claude: ${streamingDone ? "streaming-done" : "stable"} after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }
    if (lastText.length < 30) throw new Error(`claude: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`claude: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "claude", ask };
  B.log("claude adapter ready (fresh-tab)");
})();
