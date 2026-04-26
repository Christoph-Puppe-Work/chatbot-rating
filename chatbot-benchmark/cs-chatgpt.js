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
    assistantMsg: 'div[data-message-author-role="assistant"]',
    streamingCursor: '.result-streaming',
  };

  /**
   * Safely extract text in background tabs.
   * Includes logic to prevent duplicating text from nested block elements.
   */
  /**
   * Recursive DOM walker for background tabs.
   * Extracts text natively and processes blocks/lists without dropping content.
   */
  function extractTextNode(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    // Explicitly ignore ChatGPT's inline citation pills (so they don't pollute the text)
    if (node.hasAttribute && node.hasAttribute('data-testid') && node.getAttribute('data-testid') === 'webpage-citation-pill') {
      return "";
    }

    const tag = node.tagName.toUpperCase();

    // Ignore UI elements like "Copy" buttons, icons, SVGs
    if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
      return "";
    }

    const isBlock = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TR', 'UL', 'OL', 'TABLE', 'FIGURE'].includes(tag);

    let text = "";
    for (let i = 0; i < node.childNodes.length; i++) {
      text += extractTextNode(node.childNodes[i]);
    }

    // Tab between table cells
    if (tag === 'TD' || tag === 'TH') {
      text += " \t ";
    }

    // Wrap blocks in newlines
    if (isBlock) {
      text = "\n\n" + text + "\n\n";
    }

    return text;
  }

  function extractText(el) {
    if (!el) return "";
    let raw = extractTextNode(el);
    return raw
      .replace(/[ \t]+/g, ' ')         // Collapse horizontal whitespace
      .replace(/\n[ \t]+/g, '\n')      // Remove leading spaces per line
      .replace(/[ \t]+\n/g, '\n')      // Remove trailing spaces per line
      .replace(/\n{3,}/g, '\n\n')      // Reduce 3+ newlines to 2
      .trim();
  }

  /**
   * Find the LAST assistant message's markdown body text.
   * Walks backwards to skip intermediate "Searching" or "Thinking" turns.
   */
  function extractLastAnswer() {
    const allMsgs = document.querySelectorAll(SEL.assistantMsg);
    if (!allMsgs.length) return "";

    // Loop backwards to find the ACTUAL response, bypassing the "Searching" tool UI
    for (let i = allMsgs.length - 1; i >= 0; i--) {
      // The real answer always contains the .markdown.prose container.
      // Tool messages (like "Searching 5 sites") do not.
      const markdownBody = allMsgs[i].querySelector('.markdown.prose');
      if (markdownBody) {
        return extractText(markdownBody);
      }
    }

    return "";
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
    const msg = await B.waitForSelector([SEL.assistantMsg], { timeoutMs: maxWaitMs });
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

      // The ONLY reliable completion signal: the Send/Voice button SVG (#f8aa74)
      // reappears inside the composer's submit button (class: composer-submit-button-color).
      // During streaming, the button has id="composer-submit-button" and data-testid="stop-button".
      // After completion, it is REPLACED by a different button with class "composer-submit-button-color".
      const sendAppeared = !!document.querySelector('button.composer-submit-button-color use[href*="#f8aa74"]');

      const stableFor = Date.now() - lastChange;

      // Exit: Send button SVG has reappeared and text is stable for 1.5s.
      if (text.length >= 10 && sendAppeared && stableFor >= 1500) {
        const ms = Date.now() - tStart;
        B.log(`chatgpt: done (send btn #f8aa74) after ${ms}ms, ${text.length} chars`);
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