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
    const allTurns = document.querySelectorAll('.agent-turn');
    if (!allTurns.length) return "";

    const lastTurn = allTurns[allTurns.length - 1];

    // Wir suchen alle Markdown-Blöcke im letzten Turn und nehmen strikt den LETZTEN.
    // Das ignoriert eventuelle "Searched 5 sites" Blöcke, die davor gerendert werden.
    const markdowns = lastTurn.querySelectorAll('.markdown.prose');
    if (!markdowns.length) return "";

    return extractText(markdowns[markdowns.length - 1]);
  }

  async function ask(question, { maxWaitMs = 300000 } = {}) {
    B.log("chatgpt: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: maxWaitMs });
    if (!composer) throw new Error("chatgpt composer not found");

    const initialMsgCount = document.querySelectorAll('.agent-turn').length;

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

    // Phase 1: Warten, bis überhaupt eine neue Nachricht im DOM erscheint
    B.log("chatgpt: waiting for message container…");
    const phase1Deadline = Math.min(tStart + maxWaitMs, tStart + 60000);
    while (Date.now() < phase1Deadline) {
      await B.sleep(300);
      if (document.querySelectorAll('.agent-turn').length > initialMsgCount) {
        break;
      }
    }

    // Phase 2: Deterministische Überwachung mit "Seen"-Flag
    B.log("chatgpt: watching for completion…");
    let lastText = "";
    let lastTextChange = Date.now();
    let hasSeenActiveUI = false;

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);

      const text = extractLastAnswer();
      if (text !== lastText) {
        lastText = text;
        lastTextChange = Date.now();
      }

      const textStableFor = Date.now() - lastTextChange;

      const stopBtnExists = !!document.querySelector('[data-testid="stop-button"]');
      const allTurns = document.querySelectorAll('.agent-turn');
      const lastTurn = allTurns.length > 0 ? allTurns[allTurns.length - 1] : null;
      const hasStreamingClass = lastTurn ? !!lastTurn.querySelector('.streaming-animation, .result-streaming') : false;

      // 1. Haben wir die aktiven UI-Elemente schon gesehen?
      if (stopBtnExists || hasStreamingClass) {
        hasSeenActiveUI = true;
      }

      // 2. Primärer Exit: Wenn wir die UI gesehen haben, MUSS sie weg sein UND der Text muss ruhen.
      if (hasSeenActiveUI) {
        if (!stopBtnExists && !hasStreamingClass && text.length > 0) {
          // 1.5 Sekunden Puffer, um Tool-Wechsel und Netzwerk-Flackern sicher abzufangen
          if (textStableFor >= 1500) {
            const ms = Date.now() - tStart;
            B.log(`chatgpt: done (UI cleared) after ${ms}ms, ${text.length} chars`);
            return { answer: text, durationMs: ms };
          }
        }
      }
      // 3. Fallback Exit: Falls die API extrem schnell war und wir die UI komplett verpasst haben
      else {
        if (text.length > 0 && textStableFor >= 4000) {
          const ms = Date.now() - tStart;
          B.log(`chatgpt: done (fast API fallback) after ${ms}ms, ${text.length} chars`);
          return { answer: text, durationMs: ms };
        }
      }

      // Safety fallback für eingefrorene Hintergrund-Tabs
      if (text.length > 10 && textStableFor >= 60000) {
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