const https = require('https');
const http = require('http');
const ddg = require('duck-duck-scrape');
const Database = require('better-sqlite3');
const chrono = require('chrono-node');
const { extract } = require('@extractus/article-extractor');

// ─── Переменные окружения ──────────────────────────────────────────────────
const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || '/tmp/bot.db';

// Проверка обязательных переменных
const REQUIRED = { TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY, RENDER_URL, ALLOWED_USER_ID };
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
    console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
    process.exit(1);
}

// ─── Логгер ────────────────────────────────────────────────────────────────
const logLevels = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const currentLevel = logLevels.INFO;
const log = (level, ...args) => {
    if (logLevels[level] >= currentLevel) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] [${level}]`, ...args);
    }
};

// ─── HTTP‑агент с таймаутами ──────────────────────────────────────────────
const keepAliveAgent = new https.Agent({
    keepAlive: true,
    timeout: 15000,
    keepAliveMsecs: 1000,
});
const TG_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ─── База данных SQLite ──────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    message TEXT NOT NULL,
    remind_at INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    important_fact TEXT DEFAULT '',
    timestamp INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT UNIQUE NOT NULL,
    ts INTEGER DEFAULT (strftime('%s','now'))
  );
`);

const insertReminder = db.prepare('INSERT INTO reminders (chat_id, message, remind_at) VALUES (?, ?, ?)');
const getDueReminders = db.prepare('SELECT * FROM reminders WHERE remind_at <= ?');
const deleteReminder = db.prepare('DELETE FROM reminders WHERE id = ?');
const getAllReminders = db.prepare('SELECT * FROM reminders ORDER BY remind_at');

const insertHistory = db.prepare('INSERT INTO history (chat_id, role, content, important_fact) VALUES (?, ?, ?, ?)');
const getHistory = db.prepare('SELECT * FROM history WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?');
const clearHistory = db.prepare('DELETE FROM history WHERE chat_id = ?');

const insertFact = db.prepare('INSERT OR IGNORE INTO facts (text) VALUES (?)');
const getAllFacts = db.prepare('SELECT * FROM facts ORDER BY ts DESC');
const deleteFactById = db.prepare('DELETE FROM facts WHERE id = ?');
const findFactsByText = db.prepare('SELECT * FROM facts WHERE text LIKE ?');

const loadFactsFromDB = () => {
    const rows = db.prepare('SELECT * FROM facts ORDER BY ts DESC').all();
    return rows.map(r => ({ text: r.text, ts: r.ts, _tokens: null }));
};

let factsStore = loadFactsFromDB();
const MAX_FACTS = 200;

const loadHistoryFromDB = (chatId, limit = 30) => {
    const rows = getHistory.all(chatId, limit);
    return rows.reverse().map(r => ({ role: r.role, content: r.content }));
};

// Инициализация истории в памяти
const chatHistories = {};
const MAX_HISTORY_LENGTH = 30;

// ─── Миграция данных из SheetDB (если указан) ────────────────────────────
async function migrateFromSheetDB() {
    if (!SHEETDB_URL) return;
    try {
        const data = await makeRequest(SHEETDB_URL, 'GET');
        if (!Array.isArray(data)) return;

        const insertRow = db.prepare('INSERT OR IGNORE INTO history (chat_id, role, content, important_fact) VALUES (?, ?, ?, ?)');
        const insertFactStmt = db.prepare('INSERT OR IGNORE INTO facts (text) VALUES (?)');

        for (const row of data) {
            if (row.chatId && row.role && row.content) {
                insertRow.run(row.chatId, row.role, row.content, row.important_fact || '');
            }
            if (row.important_fact) {
                insertFactStmt.run(row.important_fact);
            }
        }
        log('INFO', 'Миграция из SheetDB завершена');
        // Обновим кеш фактов
        factsStore = loadFactsFromDB();
    } catch (e) {
        log('ERROR', 'Ошибка миграции из SheetDB:', e.message);
    }
}

// ─── Rate limiting ────────────────────────────────────────────────────────
const userRateLimit = new Map();
const RATE_LIMIT_MAX = 15;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── Вспомогательные функции ─────────────────────────────────────────────
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

// ─── HTTP‑запросы ────────────────────────────────────────────────────────
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

// ─── DeepSeek stream ──────────────────────────────────────────────────────
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

// ─── RAG‑lite факты ──────────────────────────────────────────────────────
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
    insertFact.run(clean);
    return true;
}

// ─── Реакции ─────────────────────────────────────────────────────────────
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

// ─── Поиск в интернете ───────────────────────────────────────────────────
function needsSearch(text) {
    const triggers = ['найди','поищи','погугли','что такое','кто такой','кто такая','расскажи про','расскажи о','узнай','сколько стоит','где находится','последние новости','новости про','что случилось','курс ','погода','price','search','find','what is','who is'];
    return triggers.some(t => text.toLowerCase().includes(t));
}
async function searchWeb(query) {
    try {
        const results = await ddg.search(query, { safeSearch: ddg.SafeSearchType.MODERATE });
        if (!results?.results?.length) return null;
        return results.results.slice(0,4).map(r => `📌 ${r.title}\n${r.description}`).join('\n\n');
    } catch (e) { log('ERROR','Search error:', e.message); return null; }
}

// ─── Суммаризация ссылок ─────────────────────────────────────────────────
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
    } catch (e) {
        log('ERROR', 'Summarize error:', e.message);
        return '⚠️ Ошибка при обработке ссылки.';
    }
}

// ─── Notion (инлайн‑кнопки) ──────────────────────────────────────────────
function formatNotionId(id) {
    const clean = id.replace(/-/g, '');
    if (clean.length !== 32) return null;
    return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
}
async function formatForNotion(userText) { /* ... код без изменений ... */ }
function buildNotionBlocks(blocks) { /* ... код без изменений ... */ }

async function readNotionPages(query = '') {
    const notionHeaders = { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' };
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
async function readNotionPageContent(pageId, depth = 0) { /* ... код без изменений ... */ }

async function handleNotion(userText) {
    if (!NOTION_TOKEN || !NOTION_PAGE_ID) return { text: '❌ Notion не настроен.', buttons: null };
    const pages = await readNotionPages(userText.replace(/[?？!！]/g, '').trim());
    const isQuestion = /[?？]/.test(userText) || /^(что|когда|где|как|кто|сколько|почему|зачем|какой|какая|какие|есть ли|покажи|напомни|расскажи)/i.test(userText.trim());

    if (pages.length === 0 && !isQuestion) {
        const text = await createNotionPage(userText);
        return { text, buttons: null };
    }
    if (pages.length === 0 && isQuestion) {
        return { text: '📭 В Notion пока нет страниц по этой теме.', buttons: null };
    }

    // Предлагаем кнопки
    const keyboard = [
        [{ text: '📖 Показать', callback_data: `notion_show_${userText}` }],
        [{ text: '➕ Создать новую', callback_data: `notion_create_${userText}` }],
        [{ text: '🔙 Отмена', callback_data: 'notion_cancel' }]
    ];
    return {
        text: '🔍 <b>Найдены страницы:</b>\n' + pages.map(p => `• ${p.title}`).join('\n') + '\n\nЧто сделать?',
        buttons: { inline_keyboard: keyboard }
    };
}

async function createNotionPage(userText) { /* ... код без изменений ... */ }

// ─── Быстрые команды Notion ──────────────────────────────────────────────
async function appendBlocksToMainPage(blocks) {
    if (!NOTION_TOKEN || !NOTION_PAGE_ID) return { ok: false, error: 'Notion не настроен.' };
    const pageId = formatNotionId(NOTION_PAGE_ID);
    if (!pageId) return { ok: false, error: 'Неверный NOTION_PAGE_ID.' };
    const res = await makeRequest(`https://api.notion.com/v1/blocks/${pageId}/children`, 'PATCH', { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }, { children: blocks });
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

// ─── Напоминания ─────────────────────────────────────────────────────────
function parseReminderTime(text) {
    // удаляем команду
    const clean = text.replace(/^\/remind\s+/, '');
    // пробуем chrono
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
    const due = db.prepare('SELECT * FROM reminders WHERE remind_at <= ?').all(now);
    for (const rem of due) {
        try {
            await sendMessage(rem.chat_id, `⏰ <b>Напоминание:</b>\n${escapeHtml(rem.message)}`);
        } catch (e) { log('ERROR', 'Reminder send error:', e.message); }
        deleteReminder.run(rem.id);
    }
}

// ─── Управление фактами с кнопками ──────────────────────────────────────
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

// ─── Отправка сообщений с кнопками ───────────────────────────────────────
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

// ─── Обработка сообщений ─────────────────────────────────────────────────
async function handleUpdate(upd) {
    if (upd.callback_query) {
        const q = upd.callback_query;
        const chatId = q.message.chat.id.toString();
        const data = q.data;
        await makeRequest(`${TG_API}/answerCallbackQuery`, 'POST', {}, { callback_query_id: q.id });

        if (data.startsWith('notion_show_')) {
            const userText = data.slice('notion_show_'.length);
            const result = await handleNotion(userText); // тут будет показано
            await sendMessage(chatId, result.text, result.buttons);
        } else if (data.startsWith('notion_create_')) {
            const userText = data.slice('notion_create_'.length);
            const text = await createNotionPage(userText);
            await sendMessage(chatId, text);
        } else if (data === 'notion_cancel') {
            await editMessage(chatId, q.message.message_id, '❌ Отменено.');
        } else if (data.startsWith('fact_del_')) {
            const id = parseInt(data.slice('fact_del_'.length));
            deleteFactById.run(id);
            factsStore = loadFactsFromDB();
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
        await makeRequest(`${TG_API}/sendMessage`, 'POST', {}, { chat_id: chatId, text: '⛔ Доступ запрещён.' });
        return;
    }

    // Rate limit
    const now = Date.now();
    const entry = userRateLimit.get(userId);
    if (entry && now < entry.resetTime && entry.count >= RATE_LIMIT_MAX) {
        await sendMessage(chatId, '⚠️ Слишком много сообщений. Подождите минуту.');
        return;
    }
    if (!entry || now > entry.resetTime) {
        userRateLimit.set(userId, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    } else {
        entry.count++;
    }

    log('INFO', `[${chatId}] ${text.substring(0,60)}`);

    // Нетекстовые сообщения
    if (!text) {
        if (upd.message.photo || upd.message.document || upd.message.voice || upd.message.sticker) {
            await sendMessage(chatId, '🤖 Я понимаю только текст. Напиши словами.');
        }
        return;
    }

    // Реакция
    if (!text.startsWith('/')) {
        const emoji = decideReaction(text);
        if (emoji) {
            await setReaction(chatId, messageId, emoji);
            // добавим в историю
            if (!chatHistories[chatId]) chatHistories[chatId] = [];
            const hist = chatHistories[chatId];
            hist.push({ role: 'user', content: text });
            if (hist.length > MAX_HISTORY_LENGTH) hist.shift();
            insertHistory.run(chatId, 'user', text, '');
            return;
        }
    }

    // Ссылка (суммаризация)
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
            insertReminder.run(chatId, parsed.message, Math.floor(parsed.date.getTime() / 1000));
            await sendMessage(chatId, `⏰ Напоминание установлено на ${parsed.date.toLocaleString('ru-RU')}:\n${escapeHtml(parsed.message)}`);
        } else {
            await sendMessage(chatId, '⚠️ Не удалось распознать время. Примеры:\n/remind через 30 минут проверить почту\n/remind завтра в 10 утра позвонить');
        }
        return;
    }

    if (text === '/todo' || text.startsWith('/todo ')) { /* ... как раньше ... */ }
    if (text === '/note' || text.startsWith('/note ')) { /* ... как раньше ... */ }
    if (text.startsWith('/facts')) {
        const result = await handleFactsCommand(chatId, text);
        await sendMessage(chatId, result.text, result.buttons);
        return;
    }
    if (text.startsWith('/notion')) { /* ... с инлайн-кнопками ... */ }
    if (text === '/clear') {
        clearHistory.run(chatId);
        delete chatHistories[chatId];
        await sendMessage(chatId, '🧹 История диалога очищена.');
        return;
    }
    if (text === '/help' || text === '/start') {
        const helpText = `👋 <b>Я — твой умный помощник!</b>\n\n` +
            `💬 <b>Общение:</b> просто пиши, я отвечаю и запоминаю важное.\n` +
            `⚡️ <b>Реакции:</b> на короткие фразы («я дома», «спасибо») ставлю эмодзи.\n` +
            `🔍 <b>Поиск:</b> спроси «найди что-то» — поищу в интернете.\n\n` +
            `📋 <b>Команды:</b>\n` +
            `/notion [текст] – поиск или создание заметки в Notion.\n` +
            `/todo [текст] – добавить задачу в Notion (без ИИ).\n` +
            `/note [текст] – добавить заметку в Notion (без ИИ).\n` +
            `/remind [время] [текст] – установить напоминание.\n` +
            `/facts – показать/управлять фактами памяти (кнопки).\n` +
            `/facts add [текст] – сохранить факт.\n` +
            `/facts find [запрос] – найти факты.\n` +
            `/facts delete <номер> – удалить факт (через кнопки).\n` +
            `/clear – очистить историю диалога.\n` +
            `🔗 <b>Ссылки:</b> отправь URL — я сделаю краткую сводку.\n` +
            `⏰ <b>Автономные задачи:</b> утром (09:00) план дня, вечером (19:00) напоминание о незакрытых задачах из Notion.`;
        await sendMessage(chatId, helpText);
        return;
    }

    // Основной диалог
    await makeRequest(`${TG_API}/sendChatAction`, 'POST', {}, { chat_id: chatId, action: 'typing' });

    let searchContext = '';
    if (needsSearch(text)) {
        const sr = await searchWeb(text);
        if (sr) searchContext = `\n\nРезультаты поиска:\n${sr}`;
    }

    const relevant = retrieveRelevantFacts(text);
    const messages = [
        { role: 'system', content: `Ты — личный помощник. Сейчас: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Chisinau', dateStyle: 'full', timeStyle: 'short' })}. Факты: ${relevant || '(нет)'} ${searchContext ? 'Используй результаты поиска.' : ''}` },
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
        insertHistory.run(chatId, 'user', text, '');
        insertHistory.run(chatId, 'assistant', answer, '');
        await finalizeMessage(chatId, streamMsgId, formatted);
        // извлечение факта и сохранение в БД (опционально)
    } else {
        if (streamMsgId) await editMessage(chatId, streamMsgId, '⚠️ Ошибка AI.');
        else await sendMessage(chatId, '⚠️ Ошибка AI.');
    }
}

// Функция streamAnswer с редактированием (аналогично предыдущей версии)
async function streamAnswer(chatId, messages) { /* ... */ }

// ─── Планировщик ─────────────────────────────────────────────────────────
function startScheduledTasks() {
    const tz = 'Europe/Chisinau';
    const nowInTz = () => { /* ... */ };
    // утро/вечер как раньше
    // проверка напоминаний
    setInterval(() => {
        processReminders().catch(e => log('ERROR', e));
        // утренние/вечерние задачи
        const { hour, minute } = nowInTz();
        if (hour === 9 && minute === 0) { /* утро */ }
        if (hour === 19 && minute === 0) { /* вечер */ }
    }, 30_000);
}

// ─── Запуск сервера ──────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Бот активен!');
        return;
    }
    if (req.method === 'POST' && req.url === `/webhook/${TELEGRAM_BOT_TOKEN}`) {
        let body = '';
        req.on('data', chunk => body += chunk);
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
    log('INFO', `Сервер на порту ${PORT}`);
    await migrateFromSheetDB();
    await setupWebhook();
    startScheduledTasks();
    log('INFO', 'Бот готов!');
    if (RENDER_URL && !RENDER_URL.includes('localhost')) startSelfPing();
});

function startSelfPing() { /* ... */ }
