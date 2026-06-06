const https = require('https');
const http = require('http');
const fs = require('fs');
const url = require('url');
const initSqlJs = require('sql.js');
const ddg = require('duck-duck-scrape');
const chrono = require('chrono-node');
const { extract } = require('@extractus/article-extractor');
const FormData = require('form-data');

// ─── Переменные окружения ──────────────────────────────────────────────
const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || '/tmp/bot.db';

const REQUIRED = { TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY, RENDER_URL, ALLOWED_USER_ID };
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Логгер ────────────────────────────────────────────────────────────
const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = logLevels.INFO;
const log = (level, ...args) => {
  if (logLevels[level] >= currentLevel) {
    console.log(`[${new Date().toISOString()}] [${level}]`, ...args);
  }
};

// ─── HTTP‑агент с таймаутами ───────────────────────────────────────────
const keepAliveAgent = new https.Agent({ keepAlive: true, timeout: 15000 });
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── Глобальные in‑memory кеши ─────────────────────────────────────────
let factsStore = [];
const MAX_FACTS = 200;
const chatHistories = {};
const MAX_HISTORY_LENGTH = 30;

// ─── Инициализация SQL.js ──────────────────────────────────────────────
let db;
let insertReminder, getDueReminders, deleteReminder, getAllReminders;
let insertHistory, getHistory, clearHistory;
let insertFact, getAllFacts, deleteFactById, findFactsByText;

async function initDatabase() {
  const SQL = await initSqlJs();
  let buffer;
  try {
    if (fs.existsSync(DB_FILE)) {
      buffer = fs.readFileSync(DB_FILE);
    }
  } catch (e) {}
  db = new SQL.Database(buffer);

  db.run(`CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    important_fact TEXT DEFAULT '',
    timestamp INTEGER DEFAULT (strftime('%s','now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT UNIQUE NOT NULL,
    ts INTEGER DEFAULT (strftime('%s','now'))
  )`);

  insertReminder = db.prepare('INSERT INTO reminders (chat_id, message, remind_at) VALUES (?, ?, ?)');
  getDueReminders = db.prepare('SELECT * FROM reminders WHERE remind_at <= ?');
  deleteReminder = db.prepare('DELETE FROM reminders WHERE id = ?');
  getAllReminders = db.prepare('SELECT * FROM reminders ORDER BY remind_at');

  insertHistory = db.prepare('INSERT INTO history (chat_id, role, content, important_fact) VALUES (?, ?, ?, ?)');
  getHistory = db.prepare('SELECT * FROM history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?');
  clearHistory = db.prepare('DELETE FROM history WHERE chat_id = ?');

  insertFact = db.prepare('INSERT OR IGNORE INTO facts (text) VALUES (?)');
  getAllFacts = db.prepare('SELECT * FROM facts ORDER BY ts DESC');
  deleteFactById = db.prepare('DELETE FROM facts WHERE id = ?');
  findFactsByText = db.prepare('SELECT * FROM facts WHERE text LIKE ?');

  const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
  if (facts.length && facts[0].values) {
    factsStore = facts[0].values.map(row => ({ id: row[0], text: row[1], ts: row[2], _tokens: null }));
  }

  log('INFO', 'База данных SQL.js инициализирована');
}

function saveDatabase() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_FILE, buffer);
}

// ─── Миграция из SheetDB (если указан) ─────────────────────────────────
async function migrateFromSheetDB() {
  if (!SHEETDB_URL) return;
  try {
    const data = await makeRequest(SHEETDB_URL, 'GET');
    if (!Array.isArray(data)) return;
    for (const row of data) {
      if (row.chatId && row.role && row.content) {
        db.run('INSERT OR IGNORE INTO history (chat_id, role, content, important_fact) VALUES (?, ?, ?, ?)', [row.chatId, row.role, row.content, row.important_fact || '']);
      }
      if (row.important_fact) {
        db.run('INSERT OR IGNORE INTO facts (text) VALUES (?)', [row.important_fact]);
      }
    }
    saveDatabase();
    const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
    if (facts.length && facts[0].values) {
      factsStore = facts[0].values.map(row => ({ id: row[0], text: row[1], ts: row[2], _tokens: null }));
    }
    log('INFO', 'Миграция из SheetDB завершена');
  } catch (e) { log('ERROR', 'Ошибка миграции:', e.message); }
}

// ─── Rate limiting ─────────────────────────────────────────────────────
const userRateLimit = new Map();
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── Вспомогательные функции ───────────────────────────────────────────
function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function formatAiResponse(thinking, answer) {
  let res = '';
  if (thinking && thinking.trim()) {
    res += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${escapeHtml(thinking.trim())}</i></blockquote>\n\n`;
  }
  let ans = escapeHtml(answer).replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/`(.*?)`/g, '<code>$1</code>');
  return res + ans;
}
function formatStreamingPreview(thinking, answer) {
  let out = '';
  if (thinking && thinking.trim()) out += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${escapeHtml(thinking.trim())}</i></blockquote>\n\n`;
  if (answer && answer.trim()) out += escapeHtml(answer.trim());
  else if (!thinking) out += '…';
  return out || '🧠 <i>Думаю…</i>';
}

// ─── HTTP‑запросы ──────────────────────────────────────────────────────
function makeRequest(url, method = 'POST', headers = {}, body = null) {
  return new Promise((resolve) => {
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (e) { return resolve(null); }
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      agent: keepAliveAgent,
      timeout: 12000,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = https.request(options, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', (e) => { log('ERROR', e.message); resolve(null); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── DeepSeek stream с общим таймаутом ─────────────────────────────────
function streamDeepSeek(body, onDelta) {
  return new Promise((resolve) => {
    const url = new URL('https://api.deepseek.com/v1/chat/completions');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      agent: keepAliveAgent,
      timeout: 25000,   // общий таймаут 25 секунд
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      }
    };
    const req = https.request(options, (res) => {
      res.setEncoding('utf8');
      let buffer = '', reasoning = '', answer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith('data:')) continue;
          const data = s.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta || {};
            if (delta.reasoning_content) { reasoning += delta.reasoning_content; }
            if (delta.content) { answer += delta.content; }
            if (onDelta) onDelta(reasoning, answer);
          } catch (e) {}
        }
      });
      res.on('end', () => resolve({ reasoning, answer }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ reasoning: '', answer: '' }); });
    req.on('error', (e) => { log('ERROR', e.message); resolve({ reasoning: '', answer: '' }); });
    req.write(JSON.stringify({ ...body, stream: true }));
    req.end();
  });
}

// ─── RAG‑lite факты ────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так',
  'его','но','да','ты','к','у','же','вы','за','бы','по','только','ее','мне','было',
  'вот','от','меня','еще','нет','о','из','ему','теперь','когда','даже','ну','вдруг',
  'ли','если','уже','или','быть','был','него','до','вас','нибудь','опять','уж','вам'
]);

function normalizeToken(w) {
  w = w.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  if (w.length <= 4) return w;
  return w.replace(/(ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ам|ям|ой|ей|ую|юю|ие|ые|ий|ый|ая|яя|ть|ешь|ет|ут|ют|ла|ло|ли|на|ка)$/i, '');
}

function tokenize(text) {
  return (text || '').split(/\s+/).map(normalizeToken).filter(t => t && t.length > 2 && !STOPWORDS.has(t));
}

function embedText(text) { return tokenize(text); }

function scoreFact(qTokens, fTokens) {
  if (!qTokens.length || !fTokens.length) return 0;
  const qset = new Set(qTokens);
  let overlap = 0;
  for (const t of new Set(fTokens)) if (qset.has(t)) overlap++;
  const union = new Set([...qTokens, ...fTokens]).size;
  return overlap / Math.sqrt(union || 1);
}

function retrieveRelevantFacts(query, limit = 6) {
  if (!factsStore.length) return '';
  const qTokens = embedText(query);
  const ranked = factsStore.map(f => {
    if (!f._tokens) f._tokens = embedText(f.text);
    return { f, score: scoreFact(qTokens, f._tokens) };
  }).sort((a, b) => b.score - a.score);
  let chosen = ranked.filter(r => r.score > 0).slice(0, limit).map(r => r.f.text);
  if (chosen.length === 0) chosen = factsStore.slice(-limit).map(f => f.text);
  return chosen.join(' | ');
}

function addFact(text) {
  const clean = (text || '').trim();
  if (!clean) return false;
  const norm = clean.toLowerCase();
  if (factsStore.some(f => f.text.toLowerCase() === norm)) return false;
  factsStore.push({ id: null, text: clean, ts: Date.now(), _tokens: embedText(clean) });
  while (factsStore.length > MAX_FACTS) factsStore.shift();
  db.run('INSERT OR IGNORE INTO facts (text) VALUES (?)', [clean]);
  saveDatabase();
  return true;
}

// ─── Реакции вместо ответа ─────────────────────────────────────────────
function decideReaction(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t || t.length > 60 || t.startsWith('/') || /[?？]/.test(t) || needsSearch(t)) return null;
  const rules = [
    { test: /(я дома|дома уже|доехал|добрался|приехал|я на месте|вернулся)/, set: ['👍', '🤗', '❤️'] },
    { test: /(я рад|рад|ура|круто|здорово|класс|супер|отлично|победа|получилось|сдал|успех|топ)/, set: ['🎉', '🥰', '🔥', '👏', '😍'] },
    { test: /(люблю|любовь|скучаю|целую|обнимаю)/, set: ['❤️', '😘', '🥰', '❤️‍🔥'] },
    { test: /(спасибо|благодарю|thx|thanks|пасиб)/, set: ['🙏', '👍', '🤝'] },
    { test: /(устал|вымотан|спать|сплю|ложусь|выдохся|спокойной ночи)/, set: ['🫡', '😴', '🤝'] },
    { test: /(грустно|плохо|печаль|расстроен|обидно|болею|заболел)/, set: ['❤️', '😭', '🙏'] },
    { test: /(смешно|ахах|хаха|лол|ржу|🤣|😂|😅)/, set: ['🤣', '😁'] },
    { test: /^(ок|окей|окей\.|хорошо|понял|поняла|принято|договорились|ладно|идёт|идет|плюс|\+)$/, set: ['👍', '👌', '🫡'] },
    { test: /(доброе утро|добрый вечер|добрый день|привет|здарова|хай)/, set: ['🤗', '😁', '👌'] },
    { test: /(работаю|занят|в пути|еду|выехал|на работе)/, set: ['🫡', '👍', '⚡️'] },
  ];
  for (const r of rules) if (r.test.test(t)) return r.set[Math.floor(Math.random() * r.set.length)];
  return null;
}

async function setReaction(chatId, messageId, emoji) {
  return makeRequest(`${TG_API}/setMessageReaction`, 'POST', {}, { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }] });
}

// ─── Поиск в интернете ─────────────────────────────────────────────────
function needsSearch(text) {
  const triggers = ['найди','поищи','погугли','что такое','кто такой','кто такая','расскажи про','расскажи о','узнай','сколько стоит','где находится','последние новости','новости про','что случилось','курс ','погода','price','search','find','what is','who is'];
  return triggers.some(t => text.toLowerCase().includes(t));
}

async function searchWeb(query) {
  try {
    const results = await ddg.search(query, { safeSearch: ddg.SafeSearchType.MODERATE });
    if (!results || !results.results || !results.results.length) return null;
    return results.results.slice(0, 4).map(r => `📌 ${r.title}\n${r.description}`).join('\n\n');
  } catch (e) { log('ERROR', 'Search error:', e.message); return null; }
}

// ─── Суммаризация ссылок ───────────────────────────────────────────────
async function summarizeUrl(url) {
  try {
    const article = await extract(url);
    if (!article?.content) return 'Не удалось извлечь текст статьи.';
    const text = article.content.replace(/<[^>]+>/g, '').substring(0, 3000);
    const res = await makeRequest(
      'https://api.deepseek.com/v1/chat/completions',
      'POST',
      { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      {
        model: 'deepseek-chat',
        max_tokens: 250,
        messages: [
          { role: 'system', content: 'Сократи текст до 3-4 предложений на русском, передавая суть.' },
          { role: 'user', content: text }
        ]
      }
    );
    if (res?.choices?.[0]?.message?.content) {
      return `📄 <b>Сводка:</b>\n${escapeHtml(res.choices[0].message.content.trim())}`;
    }
    return 'Не удалось получить сводку.';
  } catch (e) { log('ERROR', 'Summarize error:', e.message); return '⚠️ Ошибка при обработке ссылки.'; }
}

// ─── Notion функции ─────────────────────────────────────────────────────
function formatNotionId(id) {
  const clean = id.replace(/-/g, '');
  if (clean.length !== 32) return null;
  return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
}

async function formatForNotion(userText) {
  const res = await makeRequest(
    'https://api.deepseek.com/v1/chat/completions',
    'POST',
    { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
    {
      model: 'deepseek-chat',
      max_tokens: 1000,
      messages: [
        {
          role: 'system',
          content: `Ты оформляешь заметки для Notion. Получаешь текст и возвращаешь ТОЛЬКО валидный JSON без markdown. Формат: { "title": "...", "emoji": "...", "blocks": [ { "type": "heading_2", "text": "Раздел" }, { "type": "paragraph", "text": "Текст" }, ... ] } Используй разные типы блоков.`
        },
        { role: 'user', content: userText }
      ]
    }
  );
  if (!res?.choices) return null;
  try {
    const raw = res.choices[0].message.content.trim()
      .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '');
    return JSON.parse(raw);
  } catch (e) { log('ERROR', 'Notion JSON parse:', e.message); return null; }
}

function buildNotionBlocks(blocks) {
  return blocks.map(b => {
    const richText = (text) => [{ type: 'text', text: { content: text || '' } }];
    switch (b.type) {
      case 'heading_1': return { object: 'block', type: 'heading_1', heading_1: { rich_text: richText(b.text) } };
      case 'heading_2': return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(b.text) } };
      case 'heading_3': return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(b.text) } };
      case 'bulleted_list_item': return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(b.text) } };
      case 'numbered_list_item': return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: richText(b.text) } };
      case 'to_do': return { object: 'block', type: 'to_do', to_do: { rich_text: richText(b.text), checked: !!b.checked } };
      case 'callout': return { object: 'block', type: 'callout', callout: { rich_text: richText(b.text), icon: { type: 'emoji', emoji: b.emoji || '💡' } } };
      case 'quote': return { object: 'block', type: 'quote', quote: { rich_text: richText(b.text) } };
      case 'divider': return { object: 'block', type: 'divider', divider: {} };
      default: return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(b.text) } };
    }
  });
}

async function readNotionPages(query = '') {
  if (!NOTION_TOKEN) return [];
  const notionHeaders = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' };
  const searchBody = { page_size: 30, filter: { value: 'page', property: 'object' } };
  if (query) searchBody.query = query;
  const result = await makeRequest('https://api.notion.com/v1/search', 'POST', notionHeaders, searchBody);
  if (!result?.results) return [];
  return result.results.map(page => {
    const titleArr = page.properties?.title?.title || page.properties?.Name?.title || page.title || [];
    const title = titleArr.map(t => t.plain_text).join('') || 'Без названия';
    return { id: page.id, title, url: page.url };
  });
}

async function readNotionPageContent(pageId, depth = 0) {
  if (depth > 3) return '';
  const notionHeaders = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' };
  const result = await makeRequest(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, 'GET', notionHeaders);
  if (!result?.results) return '';
  const getText = (arr) => arr?.map(t => t.plain_text).join('') || '';
  const indent = '  '.repeat(depth);
  const lines = [];
  for (const block of result.results) {
    let line = '';
    switch (block.type) {
      case 'paragraph': line = getText(block.paragraph?.rich_text); break;
      case 'heading_1': line = '# ' + getText(block.heading_1?.rich_text); break;
      case 'heading_2': line = '## ' + getText(block.heading_2?.rich_text); break;
      case 'heading_3': line = '### ' + getText(block.heading_3?.rich_text); break;
      case 'bulleted_list_item': line = '• ' + getText(block.bulleted_list_item?.rich_text); break;
      case 'numbered_list_item': line = '→ ' + getText(block.numbered_list_item?.rich_text); break;
      case 'callout': line = '💡 ' + getText(block.callout?.rich_text); break;
      case 'quote': line = '❝ ' + getText(block.quote?.rich_text); break;
      case 'toggle': line = '▶ ' + getText(block.toggle?.rich_text); break;
      case 'to_do': line = (block.to_do?.checked ? '✅' : '☐') + ' ' + getText(block.to_do?.rich_text); break;
      case 'code': line = getText(block.code?.rich_text); break;
      default: line = '';
    }
    if (line) lines.push(indent + line);
    if (block.has_children) {
      const children = await readNotionPageContent(block.id, depth + 1);
      if (children) lines.push(children);
    }
  }
  return lines.filter(Boolean).join('\n');
}

async function createNotionPage(userText) {
  const formatted = await formatForNotion(userText);
  if (!formatted) return '❌ Не удалось оформить заметку.';
  const pageId = formatNotionId(NOTION_PAGE_ID);
  if (!pageId) return '❌ Неверный формат NOTION_PAGE_ID (должен быть 32 символа).';
  const result = await makeRequest(
    'https://api.notion.com/v1/pages',
    'POST',
    { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    {
      parent: { page_id: pageId },
      icon: { type: 'emoji', emoji: formatted.emoji || '📝' },
      properties: { title: { title: [{ type: 'text', text: { content: formatted.title || 'Заметка' } }] } },
      children: buildNotionBlocks(formatted.blocks || [])
    }
  );
  if (result?.id) return `✅ Сохранено в Notion!\n📄 <b>${formatted.title}</b>\n🔗 ${result.url}`;
  const errMsg = result?.message || result?.code || JSON.stringify(result);
  log('ERROR', 'Notion create error:', errMsg);
  if (errMsg?.includes('object_not_found') || errMsg?.includes('restricted'))
    return `❌ Нет доступа. Открой страницу в Notion → ... → Connections → добавь интеграцию.`;
  if (errMsg?.includes('Unauthorized') || errMsg?.includes('token'))
    return `❌ Неверный токен. NOTION_TOKEN должен начинаться с secret_`;
  return `❌ Ошибка Notion: ${errMsg}`;
}

async function appendBlocksToMainPage(blocks) {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return { ok: false, error: 'Notion не настроен.' };
  const pageId = formatNotionId(NOTION_PAGE_ID);
  if (!pageId) return { ok: false, error: 'Неверный NOTION_PAGE_ID.' };
  const res = await makeRequest(
    `https://api.notion.com/v1/blocks/${pageId}/children`,
    'PATCH',
    { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    { children: blocks }
  );
  if (res?.results || res?.object === 'list') return { ok: true };
  return { ok: false, error: res?.message || JSON.stringify(res) };
}

async function quickAddTodo(text) {
  const res = await appendBlocksToMainPage([{ object: 'block', type: 'to_do', to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked: false } }]);
  return res.ok ? `✅ Задача добавлена:\n☐ ${escapeHtml(text)}` : `❌ Не удалось: ${res.error}`;
}

async function quickAddNote(text) {
  const res = await appendBlocksToMainPage([{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: text } }] } }]);
  return res.ok ? `✅ Заметка добавлена:\n📝 ${escapeHtml(text)}` : `❌ Не удалось: ${res.error}`;
}

// ─── Загрузка файлов в Notion ───────────────────────────────────────────
async function getTelegramFileUrl(fileId) {
  const res = await makeRequest(`${TG_API}/getFile?file_id=${fileId}`, 'GET');
  if (res?.result?.file_path) {
    return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${res.result.file_path}`;
  }
  return null;
}

function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function uploadFileToNotion(fileBuffer, fileName, contentType) {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) throw new Error('Notion не настроен');
  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName, contentType });
  form.append('parent', JSON.stringify({ page_id: formatNotionId(NOTION_PAGE_ID) }));

  return new Promise((resolve, reject) => {
    const parsed = new URL('https://api.notion.com/v1/files');
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.file && json.file.url) {
            resolve({ url: json.file.url, id: json.id });
          } else {
            reject(new Error(data));
          }
        } catch (e) { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

async function addBlockToNotionPage(type, url, fileName) {
  const pageId = formatNotionId(NOTION_PAGE_ID);
  if (!pageId) return;
  let block;
  if (type === 'image') {
    block = {
      object: 'block',
      type: 'image',
      image: {
        type: 'file',
        file: { url, caption: [{ type: 'text', text: { content: fileName } }] }
      }
    };
  } else {
    block = {
      object: 'block',
      type: 'file',
      file: {
        type: 'file',
        file: { url, name: fileName }
      }
    };
  }
  await makeRequest(
    `https://api.notion.com/v1/blocks/${pageId}/children`,
    'PATCH',
    { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    { children: [block] }
  );
}

// ─── Напоминания ────────────────────────────────────────────────────────
function parseReminderTime(text) {
  const clean = text.replace(/^\/remind\s+/, '');
  const results = chrono.parse(clean, new Date(), { forwardDate: true });
  if (results.length > 0) {
    const start = results[0].start;
    const date = start.date();
    let message = clean.substring(results[0].index + results[0].text.length).trim() || 'Напоминание';
    if (date > new Date()) return { date, message };
  }
  return null;
}

async function processReminders() {
  const now = Math.floor(Date.now() / 1000);
  const due = db.exec(`SELECT * FROM reminders WHERE remind_at <= ${now}`);
  if (due.length && due[0].values) {
    for (const row of due[0].values) {
      try {
        await sendMessage(row[1], `⏰ <b>Напоминание:</b>\n${escapeHtml(row[2])}`);
      } catch (e) { log('ERROR', 'Reminder send:', e.message); }
      db.run('DELETE FROM reminders WHERE id = ?', [row[0]]);
    }
    saveDatabase();
  }
}

// ─── Обработка фактов с кнопками ───────────────────────────────────────
async function handleFactsCommand(chatId, text) {
  if (text === '/facts') {
    if (!factsStore.length) return { text: '🗒 Память пуста.', buttons: null };
    const keyboard = factsStore.slice(0, 10).map(f => ([{ text: `❌ ${f.text.substring(0, 30)}`, callback_data: `fact_del_${f.id}` }]));
    keyboard.push([{ text: '➕ Добавить', callback_data: 'fact_add_prompt' }]);
    return {
      text: `🧠 <b>Факты (${factsStore.length}):</b>\n` + factsStore.map((f, i) => `${i+1}. ${escapeHtml(f.text)}`).join('\n'),
      buttons: { inline_keyboard: keyboard }
    };
  }
  if (text.startsWith('/facts add ')) {
    const fact = text.slice(11).trim();
    if (addFact(fact)) return { text: `💾 Факт сохранён:\n${escapeHtml(fact)}`, buttons: null };
    return { text: '⚠️ Пустой или дублирующий факт.', buttons: null };
  }
  if (text.startsWith('/facts find ')) {
    const query = text.slice(12).trim();
    const found = factsStore.filter(f => f.text.toLowerCase().includes(query.toLowerCase()));
    if (!found.length) return { text: '🔍 Ничего не найдено.', buttons: null };
    return { text: `🔍 <b>Результаты поиска:</b>\n` + found.map(f => `• ${escapeHtml(f.text)}`).join('\n'), buttons: null };
  }
  return { text: 'Неизвестная команда. Используйте /facts, /facts add, /facts find, /facts delete <номер>', buttons: null };
}

// ─── Отправка сообщений с кнопками ──────────────────────────────────────
async function sendMessage(chatId, text, replyMarkup = null) {
  let lastId = null;
  for (let i = 0; i < text.length; i += 4000) {
    try {
      const r = await makeRequest(`${TG_API}/sendMessage`, 'POST', {}, {
        chat_id: chatId,
        text: text.slice(i, i+4000),
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      });
      if (r && r.ok) lastId = r.result?.message_id || lastId;
      else log('WARN', 'sendMessage ответ не ok:', JSON.stringify(r).slice(0,100));
    } catch (e) {
      log('ERROR', 'sendMessage исключение:', e.message);
    }
  }
  return lastId;
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
  return makeRequest(`${TG_API}/editMessageText`, 'POST', {}, {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
}

// ─── Обработка файлов ──────────────────────────────────────────────────
async function handleFileUpload(chatId, message) {
  let fileId, fileName = 'file', mimeType = 'application/octet-stream';
  if (message.photo) {
    const photo = message.photo[message.photo.length - 1];
    fileId = photo.file_id;
    mimeType = 'image/jpeg';
    fileName = 'photo.jpg';
  } else if (message.document) {
    fileId = message.document.file_id;
    fileName = message.document.file_name || 'document';
    mimeType = message.document.mime_type || 'application/octet-stream';
  } else if (message.video) {
    fileId = message.video.file_id;
    fileName = message.video.file_name || 'video.mp4';
    mimeType = message.video.mime_type || 'video/mp4';
  } else if (message.audio) {
    fileId = message.audio.file_id;
    fileName = message.audio.file_name || 'audio.ogg';
    mimeType = message.audio.mime_type || 'audio/ogg';
  } else if (message.voice) {
    fileId = message.voice.file_id;
    fileName = 'voice.ogg';
    mimeType = 'audio/ogg';
  } else return;

  try {
    await sendMessage(chatId, '📤 Загружаю файл в Notion...');
    const fileUrl = await getTelegramFileUrl(fileId);
    if (!fileUrl) { await sendMessage(chatId, '❌ Не удалось получить файл из Telegram.'); return; }
    const fileBuffer = await downloadFile(fileUrl);
    const { url } = await uploadFileToNotion(fileBuffer, fileName, mimeType);
    const blockType = message.photo ? 'image' : 'file';
    await addBlockToNotionPage(blockType, url, fileName);
    await sendMessage(chatId, `✅ Файл загружен в Notion:\n${fileName}`);
  } catch (e) {
    log('ERROR', 'File upload:', e.message);
    await sendMessage(chatId, '⚠️ Ошибка при загрузке в Notion.');
  }
}

// ─── Основной обработчик обновлений ────────────────────────────────────
async function handleUpdate(upd) {
  if (upd.callback_query) {
    const q = upd.callback_query;
    const chatId = q.message.chat.id.toString();
    const data = q.data;
    await makeRequest(`${TG_API}/answerCallbackQuery`, 'POST', {}, { callback_query_id: q.id });
    if (data.startsWith('fact_del_')) {
      const id = parseInt(data.slice('fact_del_'.length));
      db.run('DELETE FROM facts WHERE id = ?', [id]);
      saveDatabase();
      const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
      factsStore = facts[0]?.values?.map(row => ({ id: row[0], text: row[1], ts: row[2], _tokens: null })) || [];
      await editMessage(chatId, q.message.message_id, '🗑 Факт удалён.');
    } else if (data === 'fact_add_prompt') {
      await sendMessage(chatId, '✏️ Используйте /facts add <текст> для добавления.');
    }
    return;
  }

  if (!upd.message) return;
  const userId = upd.message.from.id.toString();
  const chatId = upd.message.chat.id.toString();
  const messageId = upd.message.message_id;
  const text = (upd.message.text || '').trim();

  if (userId !== ALLOWED_USER_ID) {
    await sendMessage(chatId, '⛔ Доступ запрещён.');
    return;
  }

  // Rate limit
  const now = Date.now();
  const entry = userRateLimit.get(userId);
  if (entry && now < entry.resetTime && entry.count >= RATE_LIMIT_MAX) {
    await sendMessage(chatId, '⚠️ Слишком много сообщений. Подожди минуту.');
    return;
  }
  if (!entry || now > entry.resetTime) {
    userRateLimit.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
  } else { entry.count++; }

  // Нетекстовые сообщения
  if (!text) {
    if (upd.message.photo || upd.message.document || upd.message.video || upd.message.audio || upd.message.voice) {
      await handleFileUpload(chatId, upd.message);
    } else {
      await sendMessage(chatId, '🤖 Я понимаю только текст или файлы.');
    }
    return;
  }

  log('INFO', `[${chatId}] ${text}`);

  // Реакция (без команд)
  if (!text.startsWith('/')) {
    const emoji = decideReaction(text);
    if (emoji) {
      await setReaction(chatId, messageId, emoji);
      if (!chatHistories[chatId]) chatHistories[chatId] = [];
      const hist = chatHistories[chatId];
      hist.push({ role: 'user', content: text });
      if (hist.length > MAX_HISTORY_LENGTH) hist.shift();
      db.run('INSERT INTO history (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'user', text]);
      saveDatabase();
      return;
    }
  }

  // Ссылка
  const urlRegex = /https?:\/\/[^\s]+/;
  if (urlRegex.test(text) && !text.startsWith('/')) {
    const url = text.match(urlRegex)[0];
    await sendMessage(chatId, '🔍 Читаю статью...');
    const summary = await summarizeUrl(url);
    await sendMessage(chatId, summary);
    return;
  }

  // ================= КОМАНДЫ (строго с return) =================
  if (text === '/help' || text === '/start') {
    const panelUrl = `${RENDER_URL}/panel?token=bunst-8524-588`;
    const helpText = `👋 Я — твой умный помощник!\n\n` +
      `💬 Общение: просто пиши, я отвечу и запомню важное.\n` +
      `⚡️ Реакции: на короткие фразы («я дома», «спасибо») ставлю эмодзи.\n` +
      `🔍 Поиск: спроси «найди что-то» – поищу в интернете.\n` +
      `📋 Команды:\n` +
      `/notion [текст] – поиск или создание заметки в Notion.\n` +
      `/todo [текст] – добавить задачу в Notion (без ИИ).\n` +
      `/note [текст] – добавить заметку в Notion (без ИИ).\n` +
      `/remind [время] [текст] – установить напоминание.\n` +
      `/facts – показать/управлять фактами памяти (кнопки).\n` +
      `/facts add [текст] – сохранить факт.\n` +
      `/facts find [запрос] – найти факты.\n` +
      `/clear – очистить историю диалога.\n` +
      `🔗 Ссылки: отправь URL — я сделаю краткую сводку.\n` +
      `📎 Файлы: отправь фото или документ — загружу в Notion.\n` +
      `⏰ Автономные задачи: утром (09:00) план дня, вечером (19:00) напоминание о задачах из Notion.\n` +
      `🌐 Веб-панель: ${panelUrl}`;

    try {
      const msgId = await sendMessage(chatId, helpText);
      log('INFO', '/help отправлено успешно, msgId:', msgId);
    } catch (e) {
      log('ERROR', 'Ошибка отправки /help:', e.message);
      await sendMessage(chatId, '⚠️ Не удалось отправить справку.');
    }
    return;  // ⬅️ ВАЖНО
  }

  if (text.startsWith('/remind ')) {
    const parsed = parseReminderTime(text);
    if (parsed) {
      db.run('INSERT INTO reminders (chat_id, message, remind_at) VALUES (?, ?, ?)', [chatId, parsed.message, Math.floor(parsed.date.getTime() / 1000)]);
      saveDatabase();
      await sendMessage(chatId, `⏰ Напоминание установлено на ${parsed.date.toLocaleString('ru-RU')}:\n${escapeHtml(parsed.message)}`);
    } else {
      await sendMessage(chatId, '⚠️ Не удалось распознать время. Пример: /remind через 30 минут проверить почту');
    }
    return;
  }

  if (text === '/todo' || text.startsWith('/todo ')) {
    const t = text.replace(/^\/todo\s*/, '').trim();
    if (!t) { await sendMessage(chatId, '✏️ /todo текст задачи'); return; }
    await sendMessage(chatId, await quickAddTodo(t));
    return;
  }

  if (text === '/note' || text.startsWith('/note ')) {
    const t = text.replace(/^\/note\s*/, '').trim();
    if (!t) { await sendMessage(chatId, '✏️ /note текст заметки'); return; }
    await sendMessage(chatId, await quickAddNote(t));
    return;
  }

  if (text.startsWith('/facts')) {
    const res = await handleFactsCommand(chatId, text);
    await sendMessage(chatId, res.text, res.buttons);
    return;
  }

  if (text.startsWith('/notion')) {
    const noteText = text.replace(/^\/notion[\s\n]?/, '').trim();
    if (!noteText) {
      await sendMessage(chatId, '✏️ /notion твой текст или идея');
      return;
    }
    const pageText = await createNotionPage(noteText);
    await sendMessage(chatId, pageText);
    return;
  }

  if (text === '/clear') {
    clearHistory.run(chatId);
    delete chatHistories[chatId];
    saveDatabase();
    await sendMessage(chatId, '🧹 История диалога очищена.');
    return;
  }

  // Основной диалог (только если не команда)
  await makeRequest(`${TG_API}/sendChatAction`, 'POST', {}, { chat_id: chatId, action: 'typing' });

  let searchContext = '';
  if (needsSearch(text)) {
    const sr = await searchWeb(text);
    if (sr) searchContext = `\n\nРезультаты поиска:\n${sr}`;
  }

  const relevant = retrieveRelevantFacts(text);
  const messages = [
    {
      role: 'system',
      content: `Ты — личный помощник. Сейчас: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', dateStyle: 'full', timeStyle: 'short' })}. Факты о пользователе: ${relevant || '(нет)'} ${searchContext ? 'Используй результаты поиска для ответа.' : ''}`
    },
    ...loadHistoryFromDB(chatId, 10),
    { role: 'user', content: text + searchContext }
  ];

  const { messageId: streamMsgId, reasoning, answer } = await streamAnswer(chatId, messages);
  if (answer || reasoning) {
    const formatted = formatAiResponse(reasoning, answer);
    if (!chatHistories[chatId]) chatHistories[chatId] = [];
    const hist = chatHistories[chatId];
    hist.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
    while (hist.length > MAX_HISTORY_LENGTH) hist.shift();
    db.run('INSERT INTO history (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'user', text]);
    db.run('INSERT INTO history (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'assistant', answer]);
    saveDatabase();
    await finalizeMessage(chatId, streamMsgId, formatted);
  } else {
    if (streamMsgId) await editMessage(chatId, streamMsgId, '⚠️ Ошибка AI.');
    else await sendMessage(chatId, '⚠️ Ошибка AI.');
  }
}

async function streamAnswer(chatId, messages) {
  const init = await makeRequest(`${TG_API}/sendMessage`, 'POST', {}, { chat_id: chatId, text: '🧠 <i>Думаю…</i>', parse_mode: 'HTML' });
  const messageId = init?.result?.message_id || null;

  let lastEditAt = 0, lastShown = '';
  const tryEdit = async (reasoning, answer) => {
    if (!messageId) return;
    const now = Date.now();
    if (now - lastEditAt < 1500) return;
    let text = formatStreamingPreview(reasoning, answer);
    if (text.length > 4000) text = text.slice(0, 4000) + '…';
    if (text === lastShown) return;
    lastEditAt = now;
    lastShown = text;
    await editMessage(chatId, messageId, text).catch(() => {});
  };

  const { reasoning, answer } = await streamDeepSeek(
    { model: 'deepseek-reasoner', messages },
    (r, a) => { tryEdit(r, a); }
  );
  return { messageId, reasoning, answer };
}

async function finalizeMessage(chatId, messageId, fullText) {
  const chunks = [];
  for (let i = 0; i < fullText.length; i += 4000) chunks.push(fullText.slice(i, i+4000));
  if (chunks.length === 0) chunks.push('…');
  if (messageId) await editMessage(chatId, messageId, chunks[0]);
  else await sendMessage(chatId, chunks[0]);
  for (let i = 1; i < chunks.length; i++) {
    await sendMessage(chatId, chunks[i]);
  }
}

function loadHistoryFromDB(chatId, limit = 30) {
  const rows = db.exec(`SELECT * FROM history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ${limit}`, { chatId });
  if (!rows.length || !rows[0].values) return [];
  const reversed = rows[0].values.reverse();
  return reversed.map(row => ({ role: row[2], content: row[3] }));
}

// ─── Веб‑панель ────────────────────────────────────────────────────────
const PANEL_TOKEN = process.env.PANEL_TOKEN || 'bunst-8524-588';

function getFactsJSON() {
  const facts = db.exec('SELECT id, text, ts FROM facts ORDER BY ts DESC');
  if (!facts.length || !facts[0].values) return [];
  return facts[0].values.map(row => ({ id: row[0], text: row[1], ts: row[2] }));
}

function getRemindersJSON() {
  const reminders = db.exec('SELECT id, chat_id, message, remind_at FROM reminders ORDER BY remind_at');
  if (!reminders.length || !reminders[0].values) return [];
  return reminders[0].values.map(row => ({
    id: row[0],
    chat_id: row[1],
    message: row[2],
    remind_at: row[3],
    date: new Date(row[3] * 1000).toLocaleString('ru-RU')
  }));
}

function getHistoryJSON(chatId, limit = 50) {
  const rows = db.exec(`SELECT id, chat_id, role, content, timestamp FROM history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ${limit}`, { chatId });
  if (!rows.length || !rows[0].values) return [];
  return rows[0].values.map(row => ({
    id: row[0],
    role: row[2],
    content: row[3],
    timestamp: row[4],
    date: new Date(row[4] * 1000).toLocaleString('ru-RU')
  }));
}

function servePanel(req, res) {
  const parsed = url.parse(req.url, true);
  const token = parsed.query.token;
  if (token !== PANEL_TOKEN) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Доступ запрещён. Добавьте ?token=...');
    return;
  }

  if (parsed.pathname === '/panel') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getPanelHTML());
    return;
  }

  if (parsed.pathname === '/api/facts') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getFactsJSON()));
    } else if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { text } = JSON.parse(body);
          if (!text || !text.trim()) throw new Error('Пустой текст');
          const success = addFact(text.trim());
          if (!success) throw new Error('Дубликат');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    } else if (req.method === 'DELETE') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          db.run('DELETE FROM facts WHERE id = ?', [id]);
          saveDatabase();
          const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
          factsStore = facts[0]?.values?.map(row => ({ id: row[0], text: row[1], ts: row[2], _tokens: null })) || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
    return;
  }

  if (parsed.pathname === '/api/reminders') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRemindersJSON()));
    } else if (req.method === 'DELETE') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { id } = JSON.parse(body);
          db.run('DELETE FROM reminders WHERE id = ?', [id]);
          saveDatabase();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    }
    return;
  }

  if (parsed.pathname === '/api/history') {
    const chatId = parsed.query.chat_id || ALLOWED_USER_ID;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getHistoryJSON(chatId)));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function getPanelHTML() {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Панель бота</title>
  <style>
    :root {
      --bg: #1e1e2e;
      --surface: #2a2a3c;
      --text: #e0e0e0;
      --text-secondary: #a0a0b0;
      --accent: #7c8cf8;
      --danger: #e74c3c;
      --border: #3a3a4e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      min-height: 100vh;
    }
    h1 { font-size: 1.8rem; margin-bottom: 1rem; color: #fff; }
    .tabs { display: flex; gap: 5px; margin-bottom: 20px; }
    .tab {
      padding: 10px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px 8px 0 0;
      cursor: pointer;
      color: var(--text-secondary);
      font-weight: 500;
      transition: 0.2s;
    }
    .tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }
    .content {
      background: var(--surface);
      padding: 20px;
      border-radius: 0 8px 8px 8px;
      border: 1px solid var(--border);
      min-height: 300px;
    }
    .hidden { display: none; }
    .item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
    }
    .item span { flex: 1; margin-right: 10px; }
    .item button {
      background: var(--danger);
      color: white;
      border: none;
      padding: 4px 12px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .add-form {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }
    .add-form input {
      flex: 1;
      padding: 10px 15px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 1rem;
    }
    .add-form button {
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      background: var(--accent);
      color: white;
      font-weight: bold;
      cursor: pointer;
      transition: 0.2s;
    }
    .add-form button:hover { opacity: 0.9; }
    .empty { color: var(--text-secondary); text-align: center; padding: 40px 0; }
    .history-item { padding: 8px 0; border-bottom: 1px solid var(--border); }
    .history-role { font-weight: bold; color: var(--accent); text-transform: capitalize; }
    .history-content { margin: 4px 0 0 10px; color: var(--text); }
    .history-date { font-size: 0.8rem; color: var(--text-secondary); }
  </style>
</head>
<body>
  <h1>🤖 Панель управления</h1>
  <div class="tabs">
    <div class="tab active" onclick="showTab('facts')">Факты</div>
    <div class="tab" onclick="showTab('reminders')">Напоминания</div>
    <div class="tab" onclick="showTab('history')">История</div>
  </div>
  <div id="facts" class="content">
    <div class="add-form">
      <input id="factInput" type="text" placeholder="Новый факт...">
      <button onclick="addFact()">➕ Добавить</button>
    </div>
    <div id="factList"></div>
  </div>
  <div id="reminders" class="content hidden"></div>
  <div id="history" class="content hidden"></div>

  <script>
    const token = new URLSearchParams(location.search).get('token');
    const BASE = '/api';

    function showTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelector(\`.tab:nth-child(\${['facts','reminders','history'].indexOf(name)+1})\`).classList.add('active');
      document.querySelectorAll('.content').forEach(c => c.classList.add('hidden'));
      document.getElementById(name).classList.remove('hidden');
      if (name === 'facts') loadFacts();
      if (name === 'reminders') loadReminders();
      if (name === 'history') loadHistory();
    }

    async function addFact() {
      const input = document.getElementById('factInput');
      const text = input.value.trim();
      if (!text) return;
      try {
        const res = await fetch(\`\${BASE}/facts?token=\${token}\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (!res.ok) { const err = await res.json(); alert(err.error || 'Ошибка'); return; }
        input.value = '';
        await loadFacts();
      } catch (e) { alert('Ошибка сети'); }
    }

    async function loadFacts() {
      try {
        const res = await fetch(\`\${BASE}/facts?token=\${token}\`);
        const facts = await res.json();
        const container = document.getElementById('factList');
        if (!facts.length) {
          container.innerHTML = '<div class="empty">🧠 Фактов пока нет</div>';
          return;
        }
        container.innerHTML = facts.map(f =>
          \`<div class="item"><span>\${escapeHtml(f.text)}</span><button onclick="deleteFact(\${f.id})">🗑</button></div>\`
        ).join('');
      } catch (e) { console.error(e); }
    }

    async function deleteFact(id) {
      await fetch(\`\${BASE}/facts?token=\${token}\`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadFacts();
    }

    async function loadReminders() {
      const res = await fetch(\`\${BASE}/reminders?token=\${token}\`);
      const rems = await res.json();
      const container = document.getElementById('reminders');
      if (!rems.length) {
        container.innerHTML = '<div class="empty">⏰ Напоминаний нет</div>';
        return;
      }
      container.innerHTML = rems.map(r =>
        \`<div class="item"><span>\${escapeHtml(r.message)} – \${r.date}</span><button onclick="deleteReminder(\${r.id})">🗑</button></div>\`
      ).join('');
    }

    async function deleteReminder(id) {
      await fetch(\`\${BASE}/reminders?token=\${token}\`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadReminders();
    }

    async function loadHistory() {
      try {
        const res = await fetch(\`\${BASE}/history?token=\${token}\`);
        const items = await res.json();
        const container = document.getElementById('history');
        if (!items.length) {
          container.innerHTML = '<div class="empty">📭 История пуста</div>';
          return;
        }
        container.innerHTML = items.map(i =>
          \`<div class="history-item">
            <span class="history-role">\${i.role}:</span>
            <div class="history-content">\${escapeHtml(i.content).substring(0,150)}</div>
            <div class="history-date">\${i.date}</div>
          </div>\`
        ).join('');
      } catch (e) { console.error(e); }
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    showTab('facts');
  </script>
</body>
</html>`;
}

// ─── Планировщик ──────────────────────────────────────────────────────
async function getOpenTodosFromNotion(limit = 10) {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return [];
  const pageId = formatNotionId(NOTION_PAGE_ID);
  if (!pageId) return [];
  try {
    const content = await readNotionPageContent(pageId);
    return content.split('\n').filter(l => l.trim().startsWith('☐')).map(l => l.replace(/^☐\s*/, '')).filter(Boolean).slice(0, limit);
  } catch (e) { return []; }
}

async function runMorning() {
  try {
    const todos = await getOpenTodosFromNotion(10);
    const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', dateStyle: 'full' });
    let text = `☀️ <b>Доброе утро!</b>\n${escapeHtml(dateStr)}\n\n`;
    text += todos.length ? `📋 <b>Задачи на сегодня:</b>\n` + todos.map(t => `☐ ${escapeHtml(t)}`).join('\n') : `📭 Открытых задач в Notion нет. Чистый день 🙌`;
    await sendMessage(ALLOWED_USER_ID, text);
  } catch (e) { log('ERROR', 'Morning:', e.message); }
}

async function runEvening() {
  try {
    const todos = await getOpenTodosFromNotion(10);
    if (!todos.length) return;
    const text = `🌆 <b>Напоминание о задачах</b>\n\n` + todos.map(t => `☐ ${escapeHtml(t)}`).join('\n');
    await sendMessage(ALLOWED_USER_ID, text);
  } catch (e) { log('ERROR', 'Evening:', e.message); }
}

function startScheduledTasks() {
  const tz = 'Europe/Chisinau';
  const nowInTz = () => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const o = {};
    for (const p of parts) o[p.type] = p.value;
    let hour = parseInt(o.hour, 10);
    if (hour === 24) hour = 0;
    return { hour, minute: parseInt(o.minute, 10) };
  };

  setInterval(async () => {
    await processReminders();
    const { hour, minute } = nowInTz();
    if (hour === 9 && minute === 0) await runMorning();
    if (hour === 19 && minute === 0) await runEvening();
  }, 30_000);
  log('INFO', 'Планировщик запущен');
}

// ─── Настройка вебхука ────────────────────────────────────────────────
async function setupWebhook() {
  await makeRequest(`${TG_API}/setWebhook`, 'POST', {}, {
    url: `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}`,
    allowed_updates: ['message', 'callback_query']
  });
}

// ─── Сервер ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  if (parsedUrl.pathname.startsWith('/panel') || parsedUrl.pathname.startsWith('/api/')) {
    return servePanel(req, res);
  }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Бот активен!');
    return;
  }
  if (req.method === 'POST' && req.url === `/webhook/${TELEGRAM_BOT_TOKEN}`) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      res.writeHead(200);
      res.end('OK');
      try { await handleUpdate(JSON.parse(body)); } catch (e) { log('ERROR', e.message); }
    });
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, async () => {
  await initDatabase();
  await migrateFromSheetDB();
  await setupWebhook();
  startScheduledTasks();
  log('INFO', `Бот запущен на порту ${PORT}`);
  if (RENDER_URL && !RENDER_URL.includes('localhost')) startSelfPing();
});

function startSelfPing() {
  setInterval(() => {
    makeRequest(`${RENDER_URL}/`, 'GET')
      .then(() => log('INFO', 'Self-ping OK'))
      .catch(() => log('WARN', 'Self-ping failed'));
  }, 8 * 60 * 1000);
}
