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
    responseBody: '.font-claude-response-body',
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
      // Filter out blocks that are nested inside other matched blocks
      // to avoid extracting the same text twice.
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
   * Re-query the DOM every iteration to avoid stale React references.
   * Returns { text, streamingDone }.
   */
  function queryResponse() {
    // 1. Check global streaming state
    let streamingDone = true;
    const streamingWrappers = document.querySelectorAll(SEL.streamingWrapper);
    if (streamingWrappers.length > 0) {
      // If any wrapper explicitly says it is streaming, we are not done
      const isStreaming = Array.from(streamingWrappers).some(w => w.getAttribute("data-is-streaming") === "true");
      streamingDone = !isStreaming;
    }

    // 2. Because this is a fresh tab, the actual response is simply the 
    // globally last markdown container. This avoids relative DOM traversal bugs.
    const mdAll = document.querySelectorAll(SEL.markdown);
    if (mdAll.length > 0) {
      const lastMd = mdAll[mdAll.length - 1];
      const text = extractText(lastMd);
      if (text) return { text, streamingDone };
    }

    // 3. Fallback: collect all body paragraphs globally
    const bodyEls = document.querySelectorAll(SEL.responseBody);
    if (bodyEls.length > 0) {
      const parts = Array.from(bodyEls)
        .map(el => extractText(el))
        .filter(Boolean);
      if (parts.length) {
        return { text: parts.join("\n\n"), streamingDone };
      }
    }

    // 4. Ultimate fallback: use the wrapper's text directly
    if (streamingWrappers.length > 0) {
      const lastWrapper = streamingWrappers[streamingWrappers.length - 1];
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

      if (text.length >= 10 && streamingDone && stableFor >= 2000) {
        const ms = Date.now() - tStart;
        B.log(`claude: streaming-done+stable after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      if (text.length >= 10 && stableFor >= 8000) {
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