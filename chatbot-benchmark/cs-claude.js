// cs-claude.js — adapter for claude.ai
//
// Fresh-tab strategy: this script runs in a tab that was just opened for
// EXACTLY ONE question. The DOM starts empty (no prior conversation).

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
    // Der von dir identifizierte, isolierte Container (escaped für querySelector)
    targetContainer: '.row-start-2 .row-start-1.relative.z-\\[2\\]'
  };

  /**
   * Rekursiver DOM-Walker für Hintergrund-Tabs.
   * Extrahiert Text nativ und verarbeitet Tabellen/Listen, ohne Inhalte zu droppen.
   */
  function extractTextNode(node) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.tagName.toUpperCase();

    // Ignoriere störende UI-Elemente wie "Copy", "Retry" Buttons oder Icons
    if (tag === 'BUTTON' || tag === 'SVG' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
      return "";
    }

    const isBlock = ['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE', 'TR', 'UL', 'OL', 'TABLE', 'FIGURE'].includes(tag);

    let text = "";
    for (let i = 0; i < node.childNodes.length; i++) {
      text += extractTextNode(node.childNodes[i]);
    }

    // Tabulator zwischen Tabellenzellen für bessere Lesbarkeit
    if (tag === 'TD' || tag === 'TH') {
      text += " \t ";
    }

    // Neue Zeilen um Block-Elemente legen
    if (isBlock) {
      text = "\n\n" + text + "\n\n";
    }

    return text;
  }

  /** Wrapper zur Bereinigung überschüssiger Leerzeichen und Zeilenumbrüche */
  function extractText(el) {
    if (!el) return "";
    let raw = extractTextNode(el);
    return raw
      .replace(/[ \t]+/g, ' ')         // Horizontale Leerzeichen kollabieren
      .replace(/\n[ \t]+/g, '\n')      // Führende Leerzeichen pro Zeile entfernen
      .replace(/[ \t]+\n/g, '\n')      // Nachgestellte Leerzeichen pro Zeile entfernen
      .replace(/\n{3,}/g, '\n\n')      // 3+ Zeilenumbrüche auf 2 reduzieren
      .trim();
  }

  function queryResponse() {
    let streamingDone = true;
    const wrappers = document.querySelectorAll(SEL.streamingWrapper);
    if (wrappers.length > 0) {
      const isStreaming = Array.from(wrappers).some(w => w.getAttribute("data-is-streaming") === "true");
      streamingDone = !isStreaming;
    }

    // 1. Primär: Nutze den spezifischen Container aus Zeile 2 (ignoriert "Thinking"-Blöcke)
    const targets = document.querySelectorAll(SEL.targetContainer);
    if (targets.length > 0) {
      // Wenn es mehrere gibt (unwahrscheinlich im Fresh-Tab), nimm den letzten
      const text = extractText(targets[targets.length - 1]);
      if (text) return { text, streamingDone };
    }

    // 2. Fallback: Suche nach dem generischen Markdown-Container
    const mdAll = document.querySelectorAll(SEL.markdown);
    if (mdAll.length > 0) {
      const lastMd = mdAll[mdAll.length - 1];
      const text = extractText(lastMd);
      if (text) return { text, streamingDone };
    }

    // 3. Letzter Fallback: Der Streaming-Wrapper selbst
    if (wrappers.length > 0) {
      const lastWrapper = wrappers[wrappers.length - 1];
      return { text: extractText(lastWrapper), streamingDone };
    }

    return { text: "", streamingDone: false };
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

    B.log("claude: waiting for streaming wrapper…");
    const appeared = await B.waitForSelector([SEL.streamingWrapper], { timeoutMs: 25000 });
    if (!appeared) throw new Error("claude: no streaming wrapper appeared");

    B.log("claude: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();
    let streamingEndedAt = null;

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);
      const { text, streamingDone } = queryResponse();

      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }

      if (streamingDone && streamingEndedAt === null) {
        streamingEndedAt = Date.now();
      }
      if (!streamingDone) {
        streamingEndedAt = null;
      }

      const stableFor = Date.now() - lastChange;

      // Primary exit: Stop button gone (streamingDone), and text stable for a short buffer.
      // The 2500ms buffer prevents exiting in the tiny gap before streaming begins.
      if (text.length >= 10 && streamingDone && stableFor >= 2500) {
        const ms = Date.now() - tStart;
        B.log(`claude: streaming-done+stable after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Safety fallback: UI indicates it IS streaming, but text hasn't changed in 60s.
      // Background tabs freeze text updates, so this MUST be longer than a full response generation.
      if (text.length >= 10 && !streamingDone && stableFor >= 60000) {
        const ms = Date.now() - tStart;
        B.log(`claude: stable-fallback after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }

    if (lastText.length < 10) throw new Error(`claude: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`claude: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "claude", ask };
  B.log("claude adapter ready (fresh-tab)");
})();