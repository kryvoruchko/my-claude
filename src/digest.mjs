// Upwork Hub daily digest pipeline
// Node 20+, no dependencies (native fetch)

import { readFileSync, writeFileSync } from "node:fs";

const ANTHROPIC_API_KEY = required("ANTHROPIC_API_KEY");
const TELEGRAM_BOT_TOKEN = required("TELEGRAM_BOT_TOKEN");
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "-1003941247545";

const STATE_FILE = new URL("../state/covered.json", import.meta.url);
const MODEL = "claude-sonnet-4-6";
const MAX_COVERED = 120; // keep last N covered topics in state

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------- 1. Raw sources (best-effort, non-fatal) ----------

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "upwork-hub-digest/1.0 (news research bot)", ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getRedditPosts() {
  const subs = ["Upwork", "freelance"];
  const posts = [];
  for (const sub of subs) {
    try {
      const data = await fetchJson(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=15`);
      for (const { data: p } of data?.data?.children ?? []) {
        if (!p || p.stickied) continue;
        posts.push({
          sub,
          title: p.title,
          score: p.score,
          comments: p.num_comments,
          url: `https://www.reddit.com${p.permalink}`,
          text: (p.selftext || "").slice(0, 600),
        });
      }
    } catch (e) {
      console.warn(`Reddit r/${sub} unavailable: ${e.message}`);
    }
  }
  // Keep the most discussed posts only
  return posts.sort((a, b) => b.comments - a.comments).slice(0, 20);
}

// ---------- 2. Claude API with web search ----------

const SYSTEM_PROMPT = `Ти - контент-ресьорчер для Telegram-каналу "Upwork Hub"
(українською, аудиторія - фрілансери на Upwork, стиль: "Upwork без води",
коротко, по суті, без корпоративщини, можна легкий гумор).

Твоя задача: знайти новини за останні 24-48 годин і підготувати чернетки постів.

Джерела для web search:
- офіційний блог Upwork (upwork.com/blog), release notes, community.upwork.com
- згадки Upwork у tech-медіа: зміни політик, Connects, комісії, AI-фічі
- тренди фрілансу, якщо прямо стосуються Upwork-фрілансерів

Додатково отримаєш сирі дані з Reddit (r/Upwork, r/freelance) - використовуй їх
як сигнал, що зараз обговорює спільнота.

Критерії відбору: тільки те, що реально впливає на фрілансерів або викликає
жваве обговорення. Ігноруй рекламу, загальні поради новачкам, усе старіше
48 годин, і теми зі списку "вже покрито".

ФОРМАТ ВІДПОВІДІ: поверни ТІЛЬКИ валідний JSON без markdown-огорток,
без тексту до чи після:
{
  "has_news": true|false,
  "items": [
    {
      "title": "коротка назва теми (для дедуплікації)",
      "summary": "суть у 2-3 реченнях",
      "source_url": "https://...",
      "post_html": "готова чернетка поста українською. Дозволені HTML-теги: <b>, <i>, <a href=\\"...\\">, <code>. Без <br> - переноси рядків через \\n. До 1500 символів."
    }
  ]
}
Максимум 3 items, відсортовані за важливістю. Якщо нічого вартого - has_news: false і порожній items.`;

async function runResearch(redditPosts, coveredTopics) {
  const userContent = [
    `Сьогодні: ${new Date().toISOString().slice(0, 10)}.`,
    ``,
    `Вже покриті теми (пропускай їх та близькі до них):`,
    coveredTopics.length ? coveredTopics.map((t) => `- ${t}`).join("\n") : "- (поки нічого)",
    ``,
    `Сирі дані з Reddit за добу:`,
    redditPosts.length
      ? JSON.stringify(redditPosts, null, 1)
      : "(Reddit недоступний цього разу - працюй тільки з web search)",
    ``,
    `Зроби ресьорч через web search і поверни JSON.`,
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    }),
    signal: AbortSignal.timeout(300000),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${JSON.stringify(data)}`);

  // Concatenate all text blocks (web search responses contain mixed block types)
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return parseDigestJson(text);
}

function parseDigestJson(text) {
  // Model is told to return raw JSON, but be defensive: strip fences,
  // then take the outermost {...}
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON in model output:\n${text}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ---------- 3. Telegram delivery ----------

async function sendTelegram(text, parseMode = "HTML") {
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!data.ok) {
    // Bad HTML entities -> retry as plain text instead of failing the run
    if (parseMode && data.description?.includes("can't parse entities")) {
      console.warn("HTML parse failed, retrying as plain text");
      return sendTelegram(text.replace(/<[^>]+>/g, ""), null);
    }
    throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  }
}

function chunk(text, size = 3900) {
  if (text.length <= size) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

// ---------- 4. State ----------

function loadCovered() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveCovered(topics) {
  writeFileSync(STATE_FILE, JSON.stringify(topics.slice(-MAX_COVERED), null, 2) + "\n");
}

// ---------- main ----------

const covered = loadCovered();
const reddit = await getRedditPosts();
console.log(`Reddit posts collected: ${reddit.length}, covered topics: ${covered.length}`);

const digest = await runResearch(reddit, covered);

if (!digest.has_news || !digest.items?.length) {
  console.log("No news today.");
  await sendTelegram("Сьогодні тихо - нічого вартого поста за останню добу.", null);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
await sendTelegram(`<b>Upwork Hub - дайджест ${date}</b>\nТем: ${digest.items.length}`);

for (const item of digest.items) {
  const message =
    `${item.post_html}\n\n` +
    `<i>Джерело:</i> ${item.source_url}\n` +
    `<i>Суть: ${escapeHtml(item.summary)}</i>`;
  for (const part of chunk(message)) {
    await sendTelegram(part);
    await new Promise((r) => setTimeout(r, 1100)); // Telegram rate limit courtesy
  }
}

saveCovered([...covered, ...digest.items.map((i) => `${date}: ${i.title}`)]);
console.log(`Done. Sent ${digest.items.length} item(s), state updated.`);

function escapeHtml(s = "") {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
