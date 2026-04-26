# Chatbot Product Benchmark

A Chrome extension that benchmarks the **consumer chatbot products**
(claude.ai, chatgpt.com, gemini.google.com, grok.com) — not the underlying
API models — by:

1. Pulling the latest 10 articles from Hacker News front page
2. Generating one self-contained question per article via Gemini 3.1 Pro
3. Opening all four chatbots in real tabs and dispatching the questions
   through their actual UIs (with all the system-prompt + tool baggage real
   users get)
4. Scraping each answer
5. Scoring each answer 0–10 on **Completeness** and **Precision** using
   two independent judges: Gemini 3.1 Pro and Claude Opus 4.7
6. Measuring **Speed** (end-to-end time from submit to streaming-complete)
7. Producing a results table + CSV export

## Install (developer mode)

1. Open `chrome://extensions/`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder
5. **Log in to all four chatbots** in the same browser profile:
   - https://claude.ai
   - https://chatgpt.com
   - https://gemini.google.com/app
   - https://grok.com
6. Click the extension icon in the toolbar → dashboard opens in a new tab
7. Paste your API keys (Gemini + Anthropic) — stored locally only via
   `chrome.storage.local`, never sent anywhere except the respective APIs
8. Hit **▶ start benchmark**

## What you'll see

- Real-time log console showing every step
- Four progress bars (news fetch / question gen / opening tabs / asking)
- Results table populating row-by-row as each question completes
- Click any score cell to see the full answer + judge reasoning
- CSV export at the end

## Caveats — read these

**DOM selectors will break.** Each chatbot ships UI changes weekly. The four
`cs-*.js` files each have a `SEL` object at the top with multiple fallback
selectors per element. When something fails:

- Open the chatbot's tab, open DevTools, find the new selector
- Add it to the top of the relevant fallback list in `cs-*.js`
- Reload the extension in `chrome://extensions/`

Common breakage points:
- Composer `contenteditable` elements (Claude uses ProseMirror, Gemini uses Quill)
- Send button (often re-skinned)
- Streaming-done detection (some sites toggle a stop button, others swap classes)

**Anti-bot detection.** None of these sites publishes an API for their
consumer product. They may flag automated input. The extension dispatches
real `pointer*` and `input` events from a logged-in user session — that's
about as low-friction as it gets — but if a site starts hard-blocking,
you'll need a cool-down period or fall back to a manual-paste mode (not
included in v0.1).

**Statistical caveat.** N=10 is small. Run it 3-5 times across different
days and merge the CSVs for any decision you'd actually act on. Per-answer
scoring also has judge variance — that's why we use two judges and average.

**Cost.** Per run with default settings: ~10 question-gen calls (Gemini)
+ 80 judge calls (40 Gemini + 40 Claude). Order of magnitude $0.50–$2.00
depending on answer length, mostly Claude Opus.

## Files

```
manifest.json        # MV3 manifest, host permissions, content script registrations
background.js        # service worker: orchestration, news fetch, API calls
dashboard.html       # the dashboard UI (single file, embedded CSS/JS)
cs-shared.js         # shared content-script utilities (typing, waiting, message bus)
cs-claude.js         # claude.ai adapter
cs-chatgpt.js        # chatgpt.com adapter
cs-gemini.js         # gemini.google.com adapter
cs-grok.js           # grok.com adapter
README.md            # this
```

## Adding a news source

In `background.js`, extend `fetchNews()`:

```js
if (source === "techcrunch") {
  const r = await fetch("https://techcrunch.com/feed/");
  const xml = await r.text();
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const items = [...doc.querySelectorAll("item")].slice(0, count);
  return items.map(it => ({
    title: it.querySelector("title")?.textContent || "",
    url:   it.querySelector("link")?.textContent || "",
    source: "techcrunch",
  }));
}
```

Then add a corresponding `<option>` in `dashboard.html` and the host
permission `"https://techcrunch.com/*"` in `manifest.json`.

## Adding a manual-paste fallback

Out of scope for v0.1. The cleanest version: when an adapter throws, the
dashboard pops a textarea and pauses the run until you paste an answer
and click continue.
