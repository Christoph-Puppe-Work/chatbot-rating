// background.js — orchestrator for the benchmark run.
//
// Lifecycle:
//   1. Dashboard sends START_BENCHMARK with config (API keys, source, count).
//   2. We fetch news headlines, turn each into a self-contained question (Gemini).
//   3. We open a fresh tab per (question, chatbot), ASK, capture the answer, close it.
//   4. We judge each answer with Gemini + Claude and stream results back.
//
// CHECKPOINTED (v1.0.1+): all run state lives in chrome.storage.local; the in-memory
// driver is disposable. A 1-minute alarm (+ onStartup / onInstalled / dashboard reconnect)
// rehydrates an interrupted run — so an MV3 service-worker death no longer loses the run.
// Every expensive unit of work (a generated question, an ask, a judge) is keyed and skipped
// if already recorded, so a resume never re-fires a paid Gemini/Claude call or re-asks a bot.
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

// ---------- dashboard ↔ background message bus + MV3 lifecycle ----------

let dashboardPort = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "dashboard") return;
  dashboardPort = port;
  port.onMessage.addListener(async msg => {
    if (msg.type === "START_BENCHMARK") {
      // Fire-and-forget: the checkpointed engine drives the run and emits DONE when it truly
      // finishes — which may be after this port (or even this worker) has come and gone.
      startBenchmark(msg.config).catch(e => send("ERROR", { message: String(e?.message || e) }));
    }
    if (msg.type === "CANCEL_BENCHMARK") {
      cancelBenchmark().catch(() => {});
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
  // On (re)connect: resume an interrupted run, or replay a finished one, to this dashboard.
  onConnectReattach();
});

// MV3 lifecycle — rehydrate an interrupted run even with no dashboard open.
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); resumeIfNeeded(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); resumeIfNeeded(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "cb-tick") resumeIfNeeded(); });
ensureAlarm();

function send(type, payload) {
  try { dashboardPort?.postMessage({ type, payload }); } catch {}
}

// ============================================================================
// Checkpointed run engine — survives MV3 service-worker death.
// ============================================================================

const K_RUN = "cb_run";
const kQ = id => "cb_q_" + id;         // during 'preparing': {origIndex: {question, article} | null}
const kAsk = id => "cb_ask_" + id;     // {"qi:chatbotId": {chatbot, answer, durationMs, error}}
const kJudge = id => "cb_judge_" + id; // {"qi:chatbotId": {gemini, claude, errored}}
const kTabs = id => "cb_tabs_" + id;   // {tabId: true} open ask-tabs (orphan cleanup)

const lget = async k => (await chrome.storage.local.get(k))[k];
const lset = (k, v) => chrome.storage.local.set({ [k]: v });

// Serialize read-modify-write on shared storage maps so concurrent tasks never lose an update.
let _writeChain = Promise.resolve();
function serialUpdate(key, mutate) {
  const p = _writeChain.then(async () => {
    const m = (await lget(key)) || {};
    mutate(m);
    await lset(key, m);
    return m;
  });
  _writeChain = p.catch(() => {});
  return p;
}
function patchRun(patch) { return serialUpdate(K_RUN, r => Object.assign(r, patch)); }

let driverLive = false;
let currentRunId = null;   // the run the live driver belongs to; a new run supersedes an old driver
const applySystem = (config, q) => config.systemMessage ? config.systemMessage + "\n\n" + q : q;
function ensureAlarm() { chrome.alarms.get("cb-tick").then(a => { if (!a) chrome.alarms.create("cb-tick", { periodInMinutes: 1 }); }); }

// ---------- MV3 keep-alive (getPlatformInfo backstop + tab ping) ----------
const activeTabs = new Set();
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    try { await chrome.runtime.getPlatformInfo(); } catch {}   // reset the 30s idle timer in every phase
    for (const tid of activeTabs) { try { await chrome.tabs.sendMessage(tid, { type: "PING" }); } catch {} }
    const r = await lget(K_RUN); if (!r || r.state !== "running") stopKeepAlive();
  }, 20000);
}
function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

async function trackTab(runId, tabId, on) {
  if (on) activeTabs.add(tabId); else activeTabs.delete(tabId);
  await serialUpdate(kTabs(runId), m => { if (on) m[tabId] = true; else delete m[tabId]; });
}
async function closeOrphanTabs(runId) {
  const m = (await lget(kTabs(runId))) || {};
  for (const tid of Object.keys(m)) { try { await chrome.tabs.remove(Number(tid)); } catch {} }
  await lset(kTabs(runId), {});
  activeTabs.clear();
}

// ---------- entry points ----------
async function startBenchmark(config) {
  const prev = await lget(K_RUN);
  if (prev && prev.runId) {   // reclaim storage from the previous run
    await chrome.storage.local.remove([kQ(prev.runId), kAsk(prev.runId), kJudge(prev.runId), kTabs(prev.runId)]);
  }
  const runId = "cb-" + Date.now().toString(36);
  currentRunId = runId;   // supersede any still-running driver from a previous run
  await lset(K_RUN, { runId, config, phase: "preparing", state: "running", articles: null, questions: null, started: new Date().toISOString() });
  await Promise.all([lset(kQ(runId), {}), lset(kAsk(runId), {}), lset(kJudge(runId), {}), lset(kTabs(runId), {})]);
  ensureAlarm();
  send("LOG", { level: "info", msg: `starting run · ${config.count} questions · source=${config.source}` });
  driveRun();
}

async function cancelBenchmark() {
  const r = await lget(K_RUN);
  if (r) { await closeOrphanTabs(r.runId); await patchRun({ state: "cancelled" }); }
  stopKeepAlive();
  send("LOG", { level: "warn", msg: "run cancelled" });
  send("DONE", {});
}

// alarm / startup: resume an interrupted run headlessly
async function resumeIfNeeded() {
  const run = await lget(K_RUN);
  if (run && run.state === "running" && !driverLive) {
    await closeOrphanTabs(run.runId);
    send("LOG", { level: "info", msg: "resuming interrupted run" });
    driveRun();
  }
}

// dashboard (re)connect: resume a running run, or replay a finished one to the fresh UI
async function onConnectReattach() {
  const run = await lget(K_RUN);
  if (!run) return;
  if (run.state === "running") resumeIfNeeded();
  else if (run.state === "done" && run.questions) {
    const askMap = (await lget(kAsk(run.runId))) || {};
    const judgeMap = (await lget(kJudge(run.runId))) || {};
    send("QUESTIONS_READY", { questions: run.questions.map(q => ({ question: q.question, article: q.article })) });
    send("RESULTS", { results: assembleResults(run.questions, askMap, judgeMap) });
    send("DONE", {});
  }
}

// ---------- the resumable driver ----------
async function driveRun() {
  if (driverLive) return;
  driverLive = true;
  startKeepAlive();
  ensureAlarm();
  try {
    let run = await lget(K_RUN);
    if (!run || run.state !== "running") return;
    const myRunId = run.runId;
    currentRunId = myRunId;
    const alive = () => run && run.state === "running" && run.runId === myRunId;

    if (run.phase === "preparing") {
      await prepareQuestions(run);
      run = await lget(K_RUN); if (!alive()) return;
    }

    const questions = run.questions || [];
    send("QUESTIONS_READY", { questions: questions.map(q => ({ question: q.question, article: q.article })) });

    // replay any already-complete questions to a (possibly reconnected) dashboard
    const emitted = new Set();
    for (let qi = 0; qi < questions.length; qi++) await maybeEmit(run.runId, qi, questions, emitted);

    if (run.phase === "asking") {
      await runAsking(run, questions);
      run = await lget(K_RUN); if (!alive()) return;
    }
    if (run.phase === "judging") {
      await runJudging(run, questions, emitted);
      run = await lget(K_RUN); if (!alive()) return;
    }
    await finishRun(run, questions);
  } catch (e) {
    // leave state 'running' so the 1-min alarm retries (resume); surface the error
    send("ERROR", { message: String(e?.message || e) });
    send("LOG", { level: "err", msg: "run error (will retry on next tick): " + String(e?.message || e) });
  } finally {
    driverLive = false;
  }
}

// ---------- phase: news + question generation ----------
async function prepareQuestions(run) {
  const { runId, config } = run;
  send("PHASE", { phase: "news", done: 0, total: 1 });

  if (config.customQuestions && config.customQuestions.length) {
    const qMap = (await lget(kQ(runId))) || {};
    if (!Object.keys(qMap).length) {
      config.customQuestions.forEach((q, i) => { qMap[i] = { question: applySystem(config, q), article: null }; });
      await lset(kQ(runId), qMap);
    }
    send("PHASE", { phase: "news", done: 1, total: 1 });
    send("PHASE", { phase: "questions", done: Object.keys(qMap).length, total: Object.keys(qMap).length });
  } else {
    let articles = run.articles;
    if (!articles) {
      articles = await fetchNews(config.source, config.count);
      await patchRun({ articles });
      send("LOG", { level: "ok", msg: `fetched ${articles.length} articles` });
    }
    send("PHASE", { phase: "news", done: 1, total: 1 });
    const have0 = Object.keys((await lget(kQ(runId))) || {}).length;
    send("PHASE", { phase: "questions", done: have0, total: articles.length });
    await runWithConcurrency(articles.map((a, i) => ({ a, i })), 4, async ({ a, i }) => {
      const cur = (await lget(kQ(runId))) || {};
      if (i in cur) return;                        // already attempted (idempotent on resume)
      let entry = null;
      try {
        const q = await withRetry(() => generateQuestion(a, config.geminiKey, config.questionPrompt), 3);
        entry = { question: applySystem(config, q), article: a };
        send("LOG", { level: "debug", msg: `Q${i + 1}: ${q.slice(0, 80)}…` });
      } catch (e) {
        send("LOG", { level: "err", msg: `Q${i + 1} gen failed: ${e.message}` });
      }
      const m = await serialUpdate(kQ(runId), mm => { mm[i] = entry; });
      send("PHASE", { phase: "questions", done: Object.keys(m).length, total: articles.length });
    });
  }

  // compact to a contiguous, stable questions array, then transition to asking
  const finalMap = (await lget(kQ(runId))) || {};
  const questions = Object.keys(finalMap).map(Number).sort((a, b) => a - b).map(k => finalMap[k]).filter(Boolean);
  if (!questions.length) { await patchRun({ state: "error" }); throw new Error("no questions generated"); }
  await patchRun({ questions, phase: "asking" });
}

// ---------- phase: asking (fresh tab per question × chatbot) ----------
async function runAsking(run, questions) {
  const { runId, config } = run;
  const total = questions.length * CHATBOTS.length;
  const have = Object.keys((await lget(kAsk(runId))) || {}).length;
  send("PHASE", { phase: "asking", done: have, total });
  send("LOG", { level: "info", msg: `asking ${total} tasks (${questions.length} questions × ${CHATBOTS.length} chatbots)` });
  const concurrency = Math.max(1, Math.min(40, config.concurrency || 8));
  const tasks = [];
  for (let qi = 0; qi < questions.length; qi++)
    for (const cb of CHATBOTS) tasks.push({ qi, cb });
  await runWithConcurrency(tasks, concurrency, async ({ qi, cb }) => {
    if (currentRunId !== runId) return;                   // superseded by a newer run
    const key = qi + ":" + cb.id;
    if (((await lget(kAsk(runId))) || {})[key]) return;   // idempotent skip on resume
    const res = await askOne(runId, cb, questions[qi].question, config);
    const m = await serialUpdate(kAsk(runId), mm => { mm[key] = res; });
    send("LOG", { level: res.error ? "err" : "ok", msg: `Q${qi + 1}/${cb.label}: ${res.error || res.answer.length + " chars"}` });
    send("PHASE", { phase: "asking", done: Object.keys(m).length, total });
  });
  await patchRun({ phase: "judging" });
}

// one fresh-tab ask (open → PING → settle → ASK → close), tracked for orphan cleanup
async function askOne(runId, cb, question, config) {
  const t0 = performance.now();
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: cb.url, active: false });
    tabId = tab.id;
    await trackTab(runId, tabId, true);
    let alive = false; const tWait = Date.now();
    while (Date.now() - tWait < 30000) { await sleep(1000); alive = await pingTab(tabId); if (alive) break; }
    if (!alive) throw new Error("content script never became reachable");
    await sleep(2000);
    const resp = await chrome.tabs.sendMessage(tabId, { type: "ASK", question, maxWaitMs: config.maxWaitMs ?? 300000 });
    if (!resp?.ok) throw new Error(resp?.error || "no response");
    return { chatbot: cb.id, answer: resp.answer, durationMs: resp.durationMs ?? Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { chatbot: cb.id, answer: "", durationMs: Math.round(performance.now() - t0), error: String(e.message) };
  } finally {
    if (tabId != null) {
      if (config.autoclose !== false) { try { await chrome.tabs.remove(tabId); } catch {} }
      await trackTab(runId, tabId, false);
    }
  }
}

// ---------- phase: judging (Gemini + Claude) ----------
async function runJudging(run, questions, emitted) {
  const { runId, config } = run;
  const askMap = (await lget(kAsk(runId))) || {};
  send("LOG", { level: "info", msg: "all answers in, judging…" });
  const tasks = [];
  for (let qi = 0; qi < questions.length; qi++)
    for (const cb of CHATBOTS) {
      const key = qi + ":" + cb.id;
      if (askMap[key]) tasks.push({ qi, key, ar: askMap[key], question: questions[qi].question });
    }
  await runWithConcurrency(tasks, 2, async ({ qi, key, ar, question }) => {
    if (currentRunId !== runId) return;                   // superseded by a newer run
    if (((await lget(kJudge(runId))) || {})[key]) { await maybeEmit(runId, qi, questions, emitted); return; }
    let scored;
    if (ar.error || !ar.answer) {
      scored = { gemini: null, claude: null, errored: true };
    } else {
      const [g, c] = await Promise.all([
        withRetry(() => judgeWithGemini(question, ar.answer, config.geminiKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
        withRetry(() => judgeWithClaude(question, ar.answer, config.claudeKey, config.judgePrompt), 3).catch(e => ({ error: e.message })),
      ]);
      await sleep(2000); // intentional throttle
      scored = { gemini: g, claude: c };
      send("LOG", { level: "debug", msg: `  Q${qi + 1}/${ar.chatbot}: gemini=${fmtScore(g)} claude=${fmtScore(c)}` });
    }
    await serialUpdate(kJudge(runId), m => { m[key] = scored; });
    await maybeEmit(runId, qi, questions, emitted);
  });
}

// emit a question's PARTIAL_RESULT once all its answers are judged (deduped per driver via `emitted`)
async function maybeEmit(runId, qi, questions, emitted) {
  if (emitted.has(qi)) return;
  const askMap = (await lget(kAsk(runId))) || {};
  const judgeMap = (await lget(kJudge(runId))) || {};
  const answers = [];
  for (const cb of CHATBOTS) {
    const key = qi + ":" + cb.id;
    const ar = askMap[key]; if (!ar) continue;
    const sc = judgeMap[key];
    if (!sc) return;                                 // not fully judged yet
    answers.push({ ...ar, scores: { gemini: sc.gemini, claude: sc.claude }, errored: sc.errored });
  }
  if (!answers.length) return;
  emitted.add(qi);
  send("PARTIAL_RESULT", { index: qi, result: { question: questions[qi].question, article: questions[qi].article, answers } });
}

function assembleResults(questions, askMap, judgeMap) {
  return questions.map((q, qi) => {
    const answers = [];
    for (const cb of CHATBOTS) {
      const key = qi + ":" + cb.id;
      const ar = askMap[key]; if (!ar) continue;
      const sc = judgeMap[key] || { gemini: null, claude: null };
      answers.push({ ...ar, scores: { gemini: sc.gemini, claude: sc.claude }, errored: sc.errored });
    }
    return { question: q.question, article: q.article, answers };
  });
}

async function finishRun(run, questions) {
  const askMap = (await lget(kAsk(run.runId))) || {};
  const judgeMap = (await lget(kJudge(run.runId))) || {};
  await patchRun({ state: "done", finished: new Date().toISOString() });
  send("RESULTS", { results: assembleResults(questions, askMap, judgeMap) });
  send("LOG", { level: "ok", msg: "run complete" });
  stopKeepAlive();
  send("DONE", {});
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

  // keep-alive: re-judging is tab-less and long; without it the MV3 worker can die mid-run.
  const keepAliveInterval = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 15000);
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

  clearInterval(keepAliveInterval);
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
