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
      'button[data-testid="send-button"]',
      '#composer-submit-button[data-testid="send-button"]',
      '#composer-submit-button',
    ],
    stopBtn: 'button[data-testid="stop-button"]',
    assistantMsg: '[data-turn="assistant"], div[data-message-author-role="assistant"]',
    msgBody: '.markdown.prose',
    // Fallback streaming indicator (blinking cursor) often used by ChatGPT
    streamingCursor: '.result-streaming',
    copyBtn: '[data-testid="copy-turn-action-button"]',
  };

  /**
   * Safely extract text in background tabs.
   * Includes logic to prevent duplicating text from nested block elements.
   */
  function extractText(el) {
    if (!el) return "";

    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TD', 'TH'];
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

  /**
   * Find the LAST assistant message's markdown body text.
   * Walks backwards to skip intermediate "Searching" or "Thinking" turns.
   */
  function extractLastAnswer() {
    const allMsgs = document.querySelectorAll(SEL.assistantMsg);
    if (!allMsgs.length) return "";

    for (let i = allMsgs.length - 1; i >= 0; i--) {
      const bodies = allMsgs[i].querySelectorAll(SEL.msgBody);
      if (bodies.length > 0) {
        const text = Array.from(bodies)
          .map(body => extractText(body))
          .filter(t => t.length > 0)
          .join("\n\n---\n\n");
        if (text.length > 0) return text;
      }
    }

    const last = allMsgs[allMsgs.length - 1];
    return extractText(last);
  }

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

    if (sendBtn && !sendBtn.disabled) {
      B.realClick(sendBtn);
    } else {
      composer.focus();
      composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }

    B.log("chatgpt: waiting for assistant message…");
    const msg = await B.waitForSelector([SEL.assistantMsg], { timeoutMs: 25000 });
    if (!msg) throw new Error("chatgpt: no assistant message appeared");

    B.log("chatgpt: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);

      const text = extractLastAnswer();
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }

      // Determine if still streaming
      const stopExists = !!document.querySelector(SEL.stopBtn) ||
        !!document.querySelector('button[aria-label*="Stop"]') ||
        !!document.querySelector('button[aria-label*="stoppen"]');
      const cursorExists = !!document.querySelector(SEL.streamingCursor);
      const isStreaming = stopExists || cursorExists;

      // Check if the copy button has appeared in the DOM. It usually appears only when generation is finished.
      const allMsgs = document.querySelectorAll(SEL.assistantMsg);
      const lastMsg = allMsgs.length > 0 ? allMsgs[allMsgs.length - 1] : null;
      const copyBtnExists = lastMsg ? !!lastMsg.querySelector(SEL.copyBtn) : false;

      const stableFor = Date.now() - lastChange;

      // Primary exit 1: Copy button is present and text is stable for a short buffer.
      // This is the most reliable indicator that generation has finished.
      if (text.length >= 10 && copyBtnExists && stableFor >= 1000) {
        const ms = Date.now() - tStart;
        B.log(`chatgpt: done (copy btn present) after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Primary exit 2: Stop button gone, cursor gone, and text stable for a longer buffer.
      // The 4500ms buffer prevents exiting during long pauses (e.g., when doing web searches).
      if (text.length >= 10 && !isStreaming && stableFor >= 4500) {
        const ms = Date.now() - tStart;
        B.log(`chatgpt: done+stable after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Safety fallback: UI indicates it IS streaming, but text hasn't changed in 60s.
      // Background tabs freeze text updates, so this MUST be longer than a full response generation.
      if (text.length >= 10 && isStreaming && stableFor >= 60000) {
        const ms = Date.now() - tStart;
        B.log(`chatgpt: stable-fallback after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }

    if (lastText.length < 10) throw new Error(`chatgpt: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`chatgpt: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "chatgpt", ask };
  B.log("chatgpt adapter ready (fresh-tab)");
})();