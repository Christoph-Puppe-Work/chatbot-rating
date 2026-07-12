// cs-chatgpt.js — adapter for chatgpt.com
// Fresh-tab strategy: one question per tab, DOM starts empty.
//
// Completion detection uses a targeted MutationObserver on the specific
// .markdown container of the latest assistant message. We watch ONLY
// attributeFilter: ['class'] — ignoring the thousands of text-token
// mutations during streaming. When the 'streaming-animation' class is
// removed, the stream is done.

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
    assistantMsg: '[data-message-author-role="assistant"]',
    markdown: '.markdown',
    streamingClass: 'streaming-animation',
  };

  /**
   * Wait for the final answer using a targeted MutationObserver.
   *
   * Instead of polling the entire DOM or watching document.body (which fires
   * thousands of times per second during token streaming), we:
   *   1. Find the latest assistant message container
   *   2. Find its .markdown child
   *   3. If streaming-animation is already absent → done immediately
   *   4. Otherwise, observe ONLY that single element's class attribute
   *   5. Resolve the moment streaming-animation is removed
   *
   * This is hyper-efficient: zero overhead during streaming, instant detection
   * of completion, and no race conditions with fast/short responses.
   */
  function waitForFinalAnswer(maxWaitMs) {
    return new Promise((resolve, reject) => {
      const assistantMessages = document.querySelectorAll(SEL.assistantMsg);
      if (assistantMessages.length === 0) {
        return reject(new Error("No assistant messages found on the page."));
      }

      const latestMessage = assistantMessages[assistantMessages.length - 1];
      const markdownContainer = latestMessage.querySelector(SEL.markdown);

      if (!markdownContainer) {
        return reject(new Error("Markdown container not found inside the latest message."));
      }

      // Synchronous check: has streaming already finished?
      if (!markdownContainer.classList.contains(SEL.streamingClass)) {
        return resolve(markdownContainer.textContent.trim());
      }

      // Targeted observer: watch ONLY the class attribute of this specific node.
      // We don't care about text-token childList mutations — just the class flip.
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
            if (!markdownContainer.classList.contains(SEL.streamingClass)) {
              observer.disconnect();
              clearTimeout(timer);
              resolve(markdownContainer.textContent.trim());
            }
          }
        }
      });

      observer.observe(markdownContainer, {
        attributes: true,
        attributeFilter: ['class'],
        childList: false,
        subtree: false,
      });

      // Safety timeout — in case the class never flips (network error, etc.)
      // > 0 (not 10): NP-mode answers are single option digits ("3").
      const timer = setTimeout(() => {
        observer.disconnect();
        const fallbackText = markdownContainer.textContent.trim();
        if (fallbackText.length > 0) {
          resolve(fallbackText);
        } else {
          reject(new Error(`chatgpt: timeout waiting for stream completion (0 chars)`));
        }
      }, maxWaitMs);
    });
  }

  async function ask(question, { maxWaitMs = 300000 } = {}) {
    B.log("chatgpt: locating composer…");
    const composer = await B.waitForSelector(SEL.composer, { timeoutMs: maxWaitMs });
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

    // Wait for the assistant message to appear in the DOM
    B.log("chatgpt: waiting for assistant message…");
    const msg = await B.waitForSelector([SEL.assistantMsg], {
      timeoutMs: Math.max(0, maxWaitMs - (Date.now() - tStart)),
    });
    if (!msg) throw new Error("chatgpt: no assistant message appeared");

    // Wait for the .markdown container to appear inside the message
    B.log("chatgpt: waiting for markdown container…");
    let markdownEl = null;
    const mdDeadline = tStart + maxWaitMs;
    while (Date.now() < mdDeadline) {
      // Re-query the latest assistant message (in case a new one appeared)
      const allMsgs = document.querySelectorAll(SEL.assistantMsg);
      const latest = allMsgs[allMsgs.length - 1];
      markdownEl = latest?.querySelector(SEL.markdown);
      if (markdownEl) break;
      await B.sleep(200);
    }
    if (!markdownEl) throw new Error("chatgpt: .markdown container never appeared");

    // Use the targeted MutationObserver to wait for streaming completion
    B.log("chatgpt: observing class attribute for stream completion…");
    const remainingMs = Math.max(0, maxWaitMs - (Date.now() - tStart));
    const text = await waitForFinalAnswer(remainingMs);

    const ms = Date.now() - tStart;
    B.log(`chatgpt: done after ${ms}ms, ${text.length} chars`);
    return { answer: text, durationMs: ms };
  }

  window.__BENCH__.adapter = { name: "chatgpt", ask };
  B.log("chatgpt adapter ready (fresh-tab)");
})();