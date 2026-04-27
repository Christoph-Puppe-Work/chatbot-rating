// background.js — orchestrator for the benchmark run.
//
// Lifecycle:
//   1. Dashboard sends START_BENCHMARK with config (API keys, source, count).
//   2. We fetch news headlines from the configured source.
//   3. We ask Gemini 3.1 Pro to turn each headline into a self-contained question.
//   4. We open a tab per chatbot, wait for content scripts to be reachable.
//   5. For each question, we dispatch ASK to all 4 tabs in parallel,
//      collect ANSWER messages, and judge each with Gemini + Claude.
//   6. Partial results stream back to the dashboard so the UI feels alive.
//
// Everything that talks to external APIs runs here, not in content scripts —
// content scripts inherit page CORS, the service worker does not.

const GEMINI_MODEL = "gemini-3.1-pro-preview";
const CLAUDE_MODEL = "claude-opus-4-7";

const CHATBOTS = [
  { id: "claude",  url: "https://claude.ai/new",            label: "Claude" },
  { id: "chatgpt", url: "https://chatgpt.com/",             label: "ChatGPT" },
  { id: "gemini",  url: "https://gemini.google.com/app",    label: "Gemini" },
  { id: "grok",    url: "https://grok.com/",                label: "Grok" },
];

// ---------- open dashboard when the toolbar icon is clicked ----------

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

// ---------- dashboard ↔ background message bus ----------

let dashboardPort = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dashboard") return;
  dashboardPort = port;
  port.onMessage.addListener(async msg => {
    if (msg.type === "START_BENCHMARK") {
      try {
        await runBenchmark(msg.config);
      } catch (e) {
        send("ERROR", { message: String(e?.message || e) });
      } finally {
        send("DONE", {});
      }
    }
    if (msg.type === "REJUDGE") {
      try {
        await rejudge(msg.config, msg.results);
      } catch (e) {
        send("ERROR", { message: String(e?.message || e) });
      } finally {
        send("DONE", {});
      }
    }
  });
  port.onDisconnect.addListener(() => { dashboardPort = null; });
});

function send(type, payload) {
  try { dashboardPort?.postMessage({ type, payload }); } catch {}
}

// ---------- main run ----------

async function runBenchmark(config) {
  send("LOG", { level: "info", msg: `starting run · ${config.count} questions · source=${config.source}` });

  let validQuestions = [];

  if (config.customQuestions && config.customQuestions.length > 0) {
    send("LOG", { level: "info", msg: `using ${config.customQuestions.length} custom questions from file` });
    validQuestions = config.customQuestions.map(q => ({ article: null, question: q }));
    send("PHASE", { phase: "news", done: 1, total: 1 });
    send("PHASE", { phase: "questions", done: validQuestions.length, total: validQuestions.length });
  } else {
    // 1. fetch news
    send("PHASE", { phase: "news", done: 0, total: 1 });
    const articles = await fetchNews(config.source, config.count);
    send("LOG", { level: "ok", msg: `fetched ${articles.length} articles` });
    send("PHASE", { phase: "news", done: 1, total: 1 });

    // 2. generate questions in parallel
    send("PHASE", { phase: "questions", done: 0, total: articles.length });
    const questions = [];
    let qDone = 0;
    await Promise.all(articles.map(async (a, i) => {
      try {
        const q = await withRetry(() => generateQuestion(a, config.geminiKey, config.questionPrompt), 3);
        questions[i] = { article: a, question: q };
        send("LOG", { level: "debug", msg: `Q${i+1}: ${q.slice(0, 80)}…` });
      } catch (e) {
        send("LOG", { level: "err", msg: `Q${i+1} gen failed: ${e.message}` });
        questions[i] = { article: a, question: null };
      } finally {
        qDone++;
        send("PHASE", { phase: "questions", done: qDone, total: articles.length });
      }
    }));
    validQuestions = questions.filter(q => q.question);
  }

  if (config.systemMessage) {
    for (let q of validQuestions) {
      q.question = config.systemMessage + "\n\n" + q.question;
    }
  }

  if (validQuestions.length === 0) throw new Error("no questions generated");
  send("QUESTIONS_READY", { questions: validQuestions });

  // 3. FULL-PARALLEL: spawn one tab per (question, chatbot) pair, all at once.
  // Each tab is opened, used for exactly ONE question, then closed.
  const totalTasks = validQuestions.length * CHATBOTS.length;
  send("PHASE", { phase: "asking", done: 0, total: totalTasks });
  const concurrency = Math.max(1, Math.min(40, config.concurrency || 8));
  send("LOG", { level: "info", msg: `dispatching ${totalTasks} tasks (${validQuestions.length} questions × ${CHATBOTS.length} chatbots) · max ${concurrency} concurrent tabs` });

  let completed = 0;
  const allTasks = [];

  for (let qi = 0; qi < validQuestions.length; qi++) {
    for (const cb of CHATBOTS) {
      allTasks.push({ qi, cb, question: validQuestions[qi].question });
    }
  }

  // Keep-alive: track all active benchmark tabs and ping them periodically
  // to prevent Chrome from discarding or freezing them in the background.
  const activeTabs = new Set();
  const keepAliveInterval = setInterval(async () => {
    for (const tid of activeTabs) {
      try { await chrome.tabs.sendMessage(tid, { type: "PING" }); } catch {}
    }
  }, 15000);

  const taskResults = await runWithConcurrency(allTasks, concurrency, async (task) => {
    const { qi, cb, question } = task;
    const t0 = performance.now();
    let tabId = null;
    try {
      // open a fresh tab for this question
      const tab = await chrome.tabs.create({ url: cb.url, active: false });
      tabId = tab.id;
      activeTabs.add(tabId);
      send("LOG", { level: "debug", msg: `Q${qi+1}/${cb.label}: tab ${tabId} opened` });

      // wait for content script to load — poll PING with backoff
      let alive = false;
      const tWait = Date.now();
      while (Date.now() - tWait < 30000) {
        await sleep(1000);
        alive = await pingTab(tabId);
        if (alive) break;
      }
      if (!alive) throw new Error("content script never became reachable");

      // additional 2s settle time after content script is ready
      await sleep(2000);

      // dispatch ASK
      const resp = await chrome.tabs.sendMessage(tabId, {
        type: "ASK",
        question,
        maxWaitMs: config.maxWaitMs ?? 300_000,
      });
      if (!resp?.ok) throw new Error(resp?.error || "no response");

      const ms = Math.round(performance.now() - t0);
      send("LOG", { level: "ok", msg: `Q${qi+1}/${cb.label}: ${resp.answer.length} chars in ${resp.durationMs ?? ms}ms` });
      return { qi, chatbot: cb.id, answer: resp.answer, durationMs: resp.durationMs ?? ms, error: null };
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      send("LOG", { level: "err", msg: `Q${qi+1}/${cb.label} failed: ${e.message}` });
      return { qi, chatbot: cb.id, answer: "", durationMs: ms, error: String(e.message) };
    } finally {
      activeTabs.delete(tabId);
      // conditionally close the tab when done
      if (tabId !== null && config.autoclose !== false) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      completed++;
      send("PHASE", { phase: "asking", done: completed, total: totalTasks });
    }
  });

  clearInterval(keepAliveInterval);

  // group results back by question
  const askResultsByQ = validQuestions.map(() => []);
  for (const tr of taskResults) {
    askResultsByQ[tr.qi].push({
      chatbot: tr.chatbot,
      answer: tr.answer,
      durationMs: tr.durationMs,
      error: tr.error,
    });
  }

  // 4. judge each answer
  send("LOG", { level: "info", msg: "all answers in, judging…" });
  const results = [];
  
  const judgeTasks = [];
  for (let qi = 0; qi < validQuestions.length; qi++) {
    const { question, article } = validQuestions[qi];
    results[qi] = { question, article, answers: new Array(askResultsByQ[qi].length) };
    for (let ci = 0; ci < askResultsByQ[qi].length; ci++) {
      judgeTasks.push({ qi, ci, question, ar: askResultsByQ[qi][ci] });
    }
  }

  // Limit judging to 2 concurrent tasks to avoid hitting 30k TPM rate limits
  await runWithConcurrency(judgeTasks, 2, async (task) => {
    const { qi, ci, question, ar } = task;
    if (ar.error || !ar.answer) {
      results[qi].answers[ci] = { ...ar, scores: { gemini: null, claude: null }, errored: true };
    } else {
      const [gScore, cScore] = await Promise.all([
        withRetry(() => judgeWithGemini(question, ar.answer, config.geminiKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
        withRetry(() => judgeWithClaude(question, ar.answer, config.claudeKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
      ]);
      await sleep(2000); // intentional throttle
      send("LOG", { level: "debug", msg: `  Q${qi+1}/${ar.chatbot}: gemini=${fmtScore(gScore)} claude=${fmtScore(cScore)}` });
      results[qi].answers[ci] = { ...ar, scores: { gemini: gScore, claude: cScore } };
    }
    
    // Check if this question is fully judged
    let done = 0;
    for (let i = 0; i < results[qi].answers.length; i++) {
      if (results[qi].answers[i]) done++;
    }
    if (done === results[qi].answers.length) {
      send("PARTIAL_RESULT", { index: qi, result: results[qi] });
    }
  });

  send("RESULTS", { results });
  send("LOG", { level: "ok", msg: "run complete" });
}

function fmtScore(s) {
  if (!s || s.error) return "?";
  return `${s.completeness}/${s.precision}`;
}

async function pingTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return r?.ok === true;
  } catch { return false; }
}

// ---------- news fetching ----------

// Shared RSS parser — extracts <item> titles and links from XML text.
function parseRss(xml, sourceName, limit) {
  const items = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/) || [])[1]
               || (block.match(/<title>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/title>/) || [])[2]
               || "";
    const link  = (block.match(/<link>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/link>/) || [])[1]
               || (block.match(/<link>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/link>/) || [])[2]
               || "";
    if (title.trim()) {
      items.push({ title: decodeHtmlEntities(title.trim()), url: link.trim(), source: sourceName });
    }
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

async function fetchNews(source, count) {
  // --- Hacker News (existing) ---
  if (source === "hackernews") {
    const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${count}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HN fetch failed: ${r.status}`);
    const j = await r.json();
    return j.hits.map(h => ({
      title: h.title || h.story_title || "(untitled)",
      url:   h.url   || h.story_url   || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      source: "hackernews",
    }));
  }

  // --- Reddit (multiple subreddits) ---
  const redditMatch = source.match(/^reddit-(.+)$/);
  if (redditMatch) {
    const sub = redditMatch[1];
    const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${Math.min(count + 5, 50)}`;
    const r = await fetch(url, { headers: { "User-Agent": "ChatbotBenchmark/1.0" } });
    if (!r.ok) throw new Error(`Reddit r/${sub} fetch failed: ${r.status}`);
    const j = await r.json();
    return j.data.children
      .filter(c => !c.data.stickied && c.data.title)
      .slice(0, count)
      .map(c => ({
        title: decodeHtmlEntities(c.data.title),
        url: c.data.url || `https://www.reddit.com${c.data.permalink}`,
        points: c.data.score,
        source: `reddit-${sub}`,
      }));
  }

  // --- BBC RSS (multiple sections) ---
  const bbcSections = {
    "bbc-world":         "world",
    "bbc-politics":      "uk_politics",
    "bbc-business":      "business",
    "bbc-technology":    "technology",
    "bbc-science":       "science_and_environment",
    "bbc-entertainment": "entertainment_and_arts",
    "bbc-health":        "health",
  };
  if (bbcSections[source]) {
    const section = bbcSections[source];
    const url = `https://feeds.bbci.co.uk/news/${section}/rss.xml`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`BBC ${section} fetch failed: ${r.status}`);
    const xml = await r.text();
    return parseRss(xml, source, count);
  }

  // --- Wikipedia Current Events ---
  if (source === "wikipedia") {
    // Fetch the current month's Current Events portal
    const now = new Date();
    const monthNames = ["January","February","March","April","May","June",
                        "July","August","September","October","November","December"];
    const pageTitle = `Portal:Current_events/${monthNames[now.getMonth()]}_${now.getFullYear()}`;
    const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=text&format=json&origin=*`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Wikipedia fetch failed: ${r.status}`);
    const j = await r.json();
    const html = j.parse?.text?.["*"] || "";
    // Extract list items from the HTML — each <li> is a news event
    const liRegex = /<li>([\s\S]*?)<\/li>/gi;
    const items = [];
    let m;
    while ((m = liRegex.exec(html)) !== null && items.length < count * 3) {
      // Strip HTML tags to get plain text
      const text = m[1].replace(/<[^>]+>/g, "").trim();
      // Skip very short items (sub-bullets, dates, etc.)
      if (text.length > 30) {
        const href = (m[1].match(/href="\/wiki\/([^"]+)"/) || [])[1];
        items.push({
          title: decodeHtmlEntities(text.slice(0, 200)),
          url: href ? `https://en.wikipedia.org/wiki/${href}` : "https://en.wikipedia.org/wiki/Portal:Current_events",
          source: "wikipedia",
        });
      }
    }
    return items.slice(0, count);
  }

  // --- NPR ---
  if (source === "npr") {
    const r = await fetch("https://feeds.npr.org/1001/rss.xml");
    if (!r.ok) throw new Error(`NPR fetch failed: ${r.status}`);
    return parseRss(await r.text(), "npr", count);
  }

  // --- Al Jazeera ---
  if (source === "aljazeera") {
    const r = await fetch("https://www.aljazeera.com/xml/rss/all.xml");
    if (!r.ok) throw new Error(`Al Jazeera fetch failed: ${r.status}`);
    return parseRss(await r.text(), "aljazeera", count);
  }

  // --- Deutsche Welle ---
  if (source === "dw") {
    const r = await fetch("https://rss.dw.com/rdf/rss-en-all");
    if (!r.ok) throw new Error(`DW fetch failed: ${r.status}`);
    return parseRss(await r.text(), "dw", count);
  }

  // --- CNBC ---
  if (source === "cnbc") {
    const r = await fetch("https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114");
    if (!r.ok) throw new Error(`CNBC fetch failed: ${r.status}`);
    return parseRss(await r.text(), "cnbc", count);
  }

  // --- People Magazine ---
  if (source === "people") {
    const r = await fetch("https://people.com/feed/");
    if (!r.ok) throw new Error(`People fetch failed: ${r.status}`);
    return parseRss(await r.text(), "people", count);
  }

  // --- E! News ---
  if (source === "eonline") {
    const r = await fetch("https://www.eonline.com/syndication/feeds/rssfeeds/topstories.xml");
    if (!r.ok) throw new Error(`E! News fetch failed: ${r.status}`);
    return parseRss(await r.text(), "eonline", count);
  }

  throw new Error(`unknown source: ${source}`);
}

// ---------- Gemini API: question generation + judging ----------

async function geminiCall(apiKey, prompt, schema) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      thinkingConfig: { thinkingLevel: "low" }, // judging is fine on low
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

async function generateQuestion(article, geminiKey, customPrompt) {
  const prompt = customPrompt
    ? customPrompt.replace(/\{\{HEADLINE\}\}/g, article.title).replace(/\{\{URL\}\}/g, article.url)
    : `You are generating benchmark questions for testing AI chatbots on tech news comprehension.

Given a news headline, produce ONE specific factual question that:
1. A knowledgeable reader would actually want answered after seeing the headline
2. Is self-contained — the chatbot will not see the article
3. Asks for substantive content, not the article's existence ("what does X claim about Y?", not "is there an article about X?")
4. Is answerable in a few paragraphs by a strong AI

HEADLINE: ${article.title}
URL: ${article.url}

Output JSON with one key: question (string).`;

  const schema = {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  };
  const out = await geminiCall(geminiKey, prompt, schema);
  return out.question;
}

async function judgeWithGemini(question, answer, geminiKey, customPrompt) {
  const prompt = buildJudgePrompt(question, answer, customPrompt);
  const schema = {
    type: "object",
    properties: {
      completeness: { type: "integer", minimum: 0, maximum: 10 },
      precision:    { type: "integer", minimum: 0, maximum: 10 },
      reasoning:    { type: "string" },
    },
    required: ["completeness", "precision", "reasoning"],
  };
  return await geminiCall(geminiKey, prompt, schema);
}

// ---------- Claude API: judging ----------

async function judgeWithClaude(question, answer, claudeKey, customPrompt) {
  const prompt = buildJudgePrompt(question, answer, customPrompt);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": claudeKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      tools: [{ type: "web_search" }],
      messages: [{ role: "user", content: prompt + "\n\nReply with ONLY a JSON object, no prose, no markdown fences." }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`claude ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("\n");
  const cleaned = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

function buildJudgePrompt(question, answer, customTemplate) {
  if (customTemplate) {
    return customTemplate
      .replace(/\{\{QUESTION\}\}/g, question)
      .replace(/\{\{ANSWER\}\}/g, answer);
  }
  return `You are an expert evaluator of AI chatbot answers.

Score the ANSWER below 0–10 on two dimensions:

- COMPLETENESS: does it address all aspects of the question?
  0 = ignores most of what was asked
  5 = covers the main thrust but misses important angles
  10 = thoroughly addresses every part of the question

- PRECISION: how factually accurate, specific, and well-grounded is it?
  0 = mostly wrong, vague, or hedged into uselessness
  5 = mixed — some specifics, some hand-waving, possibly minor errors
  10 = accurate, specific, well-supported, no notable errors

QUESTION:
${question}

ANSWER:
${answer}

Output JSON only:
{"completeness": <int 0-10>, "precision": <int 0-10>, "reasoning": "<one or two sentence justification>"}`;
}

// ---------- re-judge existing answers ----------

async function rejudge(config, existingResults) {
  const results = existingResults.map(r =>
    r ? { ...r, answers: r.answers.map(a => ({ ...a })) } : null
  );

  const judgeTasks = [];
  let totalAnswers = 0;
  for (let qi = 0; qi < results.length; qi++) {
    if (!results[qi]) continue;
    for (let ci = 0; ci < results[qi].answers.length; ci++) {
      const ar = results[qi].answers[ci];
      if (ar.error || !ar.answer) continue;
      judgeTasks.push({ qi, ci, question: results[qi].question, ar });
      totalAnswers++;
    }
  }

  send("LOG", { level: "info", msg: `re-judging ${totalAnswers} answers across ${results.filter(Boolean).length} questions` });
  send("PHASE", { phase: "asking", done: 0, total: totalAnswers });
  let completed = 0;

  await runWithConcurrency(judgeTasks, 2, async (task) => {
    const { qi, ci, question, ar } = task;
    const [gScore, cScore] = await Promise.all([
      withRetry(() => judgeWithGemini(question, ar.answer, config.geminiKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
      withRetry(() => judgeWithClaude(question, ar.answer, config.claudeKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
    ]);
    await sleep(2000);
    send("LOG", { level: "debug", msg: `  Q${qi+1}/${ar.chatbot}: gemini=${fmtScore(gScore)} claude=${fmtScore(cScore)}` });
    results[qi].answers[ci] = { ...ar, scores: { gemini: gScore, claude: cScore } };
    completed++;
    send("PHASE", { phase: "asking", done: completed, total: totalAnswers });

    // Check if this question is fully re-judged
    const qResult = results[qi];
    const allDone = qResult.answers.every(a => a.error || !a.answer || a.scores);
    if (allDone) {
      send("PARTIAL_RESULT", { index: qi, result: qResult });
    }
  });

  send("RESULTS", { results: results.filter(Boolean) });
  send("LOG", { level: "ok", msg: "re-judging complete" });
}

// ---------- utils ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === maxRetries - 1) throw e;
      await sleep(2000 * (i + 1)); // Exponential-ish backoff
    }
  }
}

// Run an async function over an array of items, with at most `limit`
// in-flight at any time. Returns results in the same order as the input.
async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
