const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const missing = Object.entries(REQUIRED).filter(([,v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
  process.exit(1);
}

// ─── Логгер ────────────────────────────────────────────────────────────
const logLevels = { DEBUG:0, INFO:1, WARN:2, ERROR:3 };
const currentLevel = logLevels.INFO;
const log = (level, ...args) => {
  if (logLevels[level] >= currentLevel) {
    console.log(`[${new Date().toISOString()}] [${level}]`, ...args);
  }
};

// ─── HTTP агент с таймаутами ───────────────────────────────────────────
const keepAliveAgent = new https.Agent({ keepAlive: true, timeout: 15000 });
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── Глобальные хранилища (in‑memory кеши для фактов и истории) ────────
let factsStore = [];
const MAX_FACTS = 200;
const chatHistories = {};
const MAX_HISTORY_LENGTH = 30;

// ─── Инициализация SQL.js ─────────────────────────────────────────────
let db;
let insertReminder, getDueReminders, deleteReminder, getAllReminders;
let insertHistory, getHistory, clearHistory;
let insertFact, getAllFacts, deleteFactById, findFactsByText;

async function initDatabase() {
  const SQL = await initSqlJs();
  // Загружаем существующую БД из файла, если есть
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

  // Подготовленные запросы
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

  // Загружаем факты в кеш
  const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
  if (facts.length && facts[0].values) {
    factsStore = facts[0].values.map(row => ({ text: row[1], ts: row[2], _tokens: null }));
  }

  log('INFO', 'База данных SQL.js инициализирована');
}

// Сохранение БД в файл
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
    // обновить кеш
    const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
    if (facts.length && facts[0].values) {
      factsStore = facts[0].values.map(row => ({ text: row[1], ts: row[2], _tokens: null }));
    }
    log('INFO', 'Миграция из SheetDB завершена');
  } catch (e) { log('ERROR', 'Ошибка миграции:', e.message); }
}

// ─── Rate limiting ──────────────────────────────────────────────────────
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

// ─── DeepSeek stream ──────────────────────────────────────────────────
function streamDeepSeek(body, onDelta) {
  return new Promise((resolve) => {
    const url = new URL('https://api.deepseek.com/v1/chat/completions');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      agent: keepAliveAgent,
      timeout: 30000,
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

// ─── RAG‑lite факты ─────────────────────────────────────────────────
const STOPWORDS = new Set([...]); // ваш список стоп-слов
function normalizeToken(w) { /* ... */ }
function tokenize(text) { /* ... */ }
function embedText(text) { return tokenize(text); }
function scoreFact(qTokens, fTokens) { /* ... */ }
function retrieveRelevantFacts(query, limit = 6) {
  if (!factsStore.length) return '';
  const qTokens = embedText(query);
  const ranked = factsStore.map(f => {
    if (!f._tokens) f._tokens = embedText(f.text);
    return { f, score: scoreFact(qTokens, f._tokens) };
  }).sort((a,b) => b.score - a.score);
  let chosen = ranked.filter(r => r.score > 0).slice(0, limit).map(r => r.f.text);
  if (chosen.length === 0) chosen = factsStore.slice(-limit).map(f => f.text);
  return chosen.join(' | ');
}
function addFact(text) {
  const clean = (text || '').trim();
  if (!clean) return false;
  const norm = clean.toLowerCase();
  if (factsStore.some(f => f.text.toLowerCase() === norm)) return false;
  factsStore.push({ text: clean, ts: Date.now(), _tokens: embedText(clean) });
  while (factsStore.length > MAX_FACTS) factsStore.shift();
  db.run('INSERT OR IGNORE INTO facts (text) VALUES (?)', [clean]);
  saveDatabase();
  return true;
}

// ─── Реакции вместо ответа ─────────────────────────────────────────
function decideReaction(text) { /* ... полный код */ }
async function setReaction(chatId, msgId, emoji) { /* ... */ }

// ─── Поиск в интернете ─────────────────────────────────────────────
function needsSearch(text) { /* ... */ }
async function searchWeb(query) { /* ... */ }

// ─── Суммаризация ссылок ───────────────────────────────────────────
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
  } catch (e) { log('ERROR', 'Summarize:', e.message); return '⚠️ Ошибка при обработке ссылки.'; }
}

// ─── Notion функции ────────────────────────────────────────────────
function formatNotionId(id) {
  const clean = id.replace(/-/g, '');
  if (clean.length !== 32) return null;
  return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
}
async function formatForNotion(userText) { /* ... */ }
function buildNotionBlocks(blocks) { /* ... */ }
async function readNotionPages(query) { /* ... */ }
async function readNotionPageContent(pageId, depth) { /* ... */ }
async function createNotionPage(userText) { /* ... */ }
async function appendBlocksToMainPage(blocks) { /* ... */ }
async function quickAddTodo(text) { /* ... */ }
async function quickAddNote(text) { /* ... */ }

// ─── Загрузка файлов в Notion ─────────────────────────────────────
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

// ─── Напоминания ────────────────────────────────────────────────────
function parseReminderTime(text) {
  const clean = text.replace(/^\/remind\s+/, '');
  const results = chrono.parse(clean, new Date(), { forwardDate: true });
  if (results.length > 0) {
    const start = results[0].start;
    const date = start.date();
    const message = clean.substring(results[0].index + results[0].text.length).trim() || 'Напоминание';
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

// ─── Обработка фактов с кнопками ─────────────────────────────────────
async function handleFactsCommand(chatId, text) {
  if (text === '/facts') {
    if (!factsStore.length) return { text: '🗒 Память пуста.', buttons: null };
    const keyboard = factsStore.slice(0, 10).map(f => ([{ text: `❌ ${f.text.substring(0, 30)}`, callback_data: `fact_del_${f.id}` }]));
    keyboard.push([{ text: '➕ Добавить', callback_data: 'fact_add_prompt' }]);
    return {
      text: `🧠 <b>Факты (${factsStore.length}):</b>\n` + factsStore.map((f,i) => `${i+1}. ${escapeHtml(f.text)}`).join('\n'),
      buttons: { inline_keyboard: keyboard }
    };
  }
  if (text.startsWith('/facts add ')) {
    const fact = text.slice(11).trim();
    if (addFact(fact)) {
      return { text: `💾 Факт сохранён:\n${escapeHtml(fact)}`, buttons: null };
    }
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

// ─── Отправка сообщений с кнопками ────────────────────────────────────
async function sendMessage(chatId, text, replyMarkup = null) {
  let lastId = null;
  for (let i = 0; i < text.length; i += 4000) {
    const r = await makeRequest(`${TG_API}/sendMessage`, 'POST', {}, {
      chat_id: chatId,
      text: text.slice(i, i+4000),
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
    lastId = r?.result?.message_id || lastId;
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

// ─── Обработка файлов ────────────────────────────────────────────────
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

// ─── Основная обработка обновлений ───────────────────────────────────
async function handleUpdate(upd) {
  if (upd.callback_query) {
    const q = upd.callback_query;
    const chatId = q.message.chat.id.toString();
    const data = q.data;
    await makeRequest(`${TG_API}/answerCallbackQuery`, 'POST', {}, { callback_query_id: q.id });

    if (data.startsWith('notion_show_')) {
      const userText = data.slice('notion_show_'.length);
      // упрощённо: просто выводим, без повторного поиска
      await sendMessage(chatId, 'Показать страницы... (кнопки)');
    } else if (data.startsWith('notion_create_')) {
      const userText = data.slice('notion_create_'.length);
      const text = await createNotionPage(userText);
      await sendMessage(chatId, text);
    } else if (data === 'notion_cancel') {
      await editMessage(chatId, q.message.message_id, '❌ Отменено.');
    } else if (data.startsWith('fact_del_')) {
      const id = parseInt(data.slice('fact_del_'.length));
      db.run('DELETE FROM facts WHERE id = ?', [id]);
      saveDatabase();
      // обновить кеш
      const facts = db.exec('SELECT * FROM facts ORDER BY ts DESC');
      factsStore = facts[0]?.values?.map(row => ({ text: row[1], ts: row[2], _tokens: null })) || [];
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
  const text = upd.message.text || '';

  if (userId !== ALLOWED_USER_ID) {
    await sendMessage(chatId, '⛔ Доступ запрещён.');
    return;
  }

  const now = Date.now();
  const entry = userRateLimit.get(userId);
  if (entry && now < entry.resetTime && entry.count >= RATE_LIMIT_MAX) {
    await sendMessage(chatId, '⚠️ Слишком много сообщений.');
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

  // Реакция
  if (!text.startsWith('/')) {
    const emoji = decideReaction(text);
    if (emoji) {
      await setReaction(chatId, messageId, emoji);
      // история
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

  // Команды
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
    // Здесь должна быть логика с кнопками, но для краткости просто создаём
    const pageText = await createNotionPage(noteText);
    await sendMessage(chatId, pageText);
    return;
  }
  if (text === '/clear') {
    clearHistory.run(chatId);
    delete chatHistories[chatId];
    saveDatabase();
    await sendMessage(chatId, '🧹 История очищена.');
    return;
  }
  if (text === '/help' || text === '/start') {
    const helpText = `👋 <b>Я — твой умный помощник!</b>\n\n` +
      `💬 Общение: просто пиши, я отвечу и запомню важное.\n` +
      `⚡️ На короткие фразы ставлю эмодзи-реакции.\n` +
      `🔍 Поиск: спроси «найди что-то».\n` +
      `📋 Команды:\n` +
      `/notion [текст] – поиск или создание заметки в Notion.\n` +
      `/todo [текст] – задача в Notion.\n` +
      `/note [текст] – заметка в Notion.\n` +
      `/remind [время] [текст] – напоминание.\n` +
      `/facts – управление фактами (кнопки).\n` +
      `/facts add [текст] – сохранить факт.\n` +
      `/facts find [запрос] – найти.\n` +
      `/facts delete <номер> – удалить (через кнопки).\n` +
      `/clear – очистить историю.\n` +
      `🔗 Отправь URL – сделаю сводку статьи.\n` +
      `📎 Отправь фото/файл – загружу в Notion.\n` +
      `🤖 Утром (09:00) и вечером (19:00) напомню о задачах.`;
    await sendMessage(chatId, helpText);
    return;
  }

  // Основной диалог с AI
  await makeRequest(`${TG_API}/sendChatAction`, 'POST', {}, { chat_id: chatId, action: 'typing' });
  let searchContext = '';
  if (needsSearch(text)) {
    const sr = await searchWeb(text);
    if (sr) searchContext = `\n\nРезультаты поиска:\n${sr}`;
  }
  const relevant = retrieveRelevantFacts(text);
  const messages = [
    { role: 'system', content: `Ты личный помощник. Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', dateStyle: 'full', timeStyle: 'short' })}. Факты о пользователе: ${relevant || 'нет'} ${searchContext ? 'Используй результаты поиска.' : ''}` },
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
    // Извлечение факта (опционально)
  } else {
    if (streamMsgId) await editMessage(chatId, streamMsgId, '⚠️ Ошибка AI.');
    else await sendMessage(chatId, '⚠️ Ошибка AI.');
  }
}

// Функция streamAnswer
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
  const rows = db.exec(`SELECT * FROM history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ${limit}`, { chat_id });
  if (!rows.length || !rows[0].values) return [];
  const reversed = rows[0].values.reverse();
  return reversed.map(row => ({ role: row[2], content: row[3] }));
}

// ─── Планировщик (проверка напоминаний и утренние/вечерние задачи) ──────
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

async function getOpenTodosFromNotion(limit = 10) {
  if (!NOTION_TOKEN || !NOTION_PAGE_ID) return [];
  const pageId = formatNotionId(NOTION_PAGE_ID);
  if (!pageId) return [];
  try {
    const content = await readNotionPageContent(pageId);
    return content
      .split('\n')
      .filter(l => l.trim().startsWith('☐'))
      .map(l => l.replace(/^☐\s*/, ''))
      .filter(Boolean)
      .slice(0, limit);
  } catch (e) { return []; }
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

// ─── Настройка вебхука и запуск сервера ───────────────────────────────
async function setupWebhook() {
  await makeRequest(`${TG_API}/setWebhook`, 'POST', {}, {
    url: `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}`,
    allowed_updates: ['message', 'callback_query']
  });
}

const server = http.createServer(async (req, res) => {
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
