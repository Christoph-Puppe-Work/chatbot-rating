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

  /**
   * Safely extract text in background tabs.
   * Includes logic to prevent duplicating text from nested block elements.
   */
  function extractText(el) {
    if (!el) return "";

    const blockTags = ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'PRE', 'BLOCKQUOTE'];
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

  function extractLastAnswer() {
    const msgs = document.querySelectorAll(SEL.msgBody);
    if (!msgs.length) {
      // Fallback: look for the assistant message wrapper
      const fallbacks = document.querySelectorAll(SEL.assistantMsg);
      if (!fallbacks.length) return "";
      return extractText(fallbacks[fallbacks.length - 1]);
    }
    return extractText(msgs[msgs.length - 1]);
  }

  function checkIsDoneLocally() {
    // Check if the action buttons have appeared and have the 'last-response' class
    const actions = document.querySelectorAll(SEL.actionButtons);
    if (!actions.length) return false;
    const lastAction = actions[actions.length - 1];
    return lastAction.classList.contains("last-response");
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
    // Wait for either the explicit message wrapper or the markdown body
    const msg = await B.waitForSelector([SEL.assistantMsg, SEL.msgBody], { timeoutMs: 30000 });
    if (!msg) throw new Error("grok: no assistant message appeared");

    B.log("grok: watching for completion…");
    let lastText = "";
    let lastChange = Date.now();

    while (Date.now() - tStart < maxWaitMs) {
      await B.sleep(400);

      const text = extractLastAnswer();
      if (text !== lastText) {
        lastText = text;
        lastChange = Date.now();
      }

      const hasLastResponse = checkIsDoneLocally();
      const stableFor = Date.now() - lastChange;

      // Primary exit: Grok has the .last-response action buttons, and text is stable
      // The 2500ms buffer prevents exiting in the tiny gap before streaming begins.
      if (text.length >= 10 && hasLastResponse && stableFor >= 2500) {
        const ms = Date.now() - tStart;
        B.log(`grok: last-response after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }

      // Safety fallback: If it's still streaming but text hasn't changed in 60s
      // Background tabs freeze text updates, so this MUST be longer than a full response generation.
      if (text.length >= 10 && !hasLastResponse && stableFor >= 60000) {
        const ms = Date.now() - tStart;
        B.log(`grok: stable-fallback after ${ms}ms, ${text.length} chars`);
        return { answer: text, durationMs: ms };
      }
    }

    if (lastText.length < 10) throw new Error(`grok: timeout, response too short (${lastText.length} chars)`);
    const ms = Date.now() - tStart;
    B.log(`grok: timeout after ${ms}ms, ${lastText.length} chars`);
    return { answer: lastText, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "grok", ask };
  B.log("grok adapter ready (fresh-tab)");
})();