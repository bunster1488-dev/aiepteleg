const https = require('https');
const ddg = require('duck-duck-scrape');
const http = require('http');

const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID; // твой Telegram ID
const PORT = process.env.PORT || 3000;

// Проверка обязательных переменных
const REQUIRED = { SHEETDB_URL, TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY, RENDER_URL, ALLOWED_USER_ID };
const missing = Object.entries(REQUIRED).filter(([,v]) => !v).map(([k]) => k);
if (missing.length) {
    console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
    process.exit(1);
}

const keepAliveAgent = new https.Agent({ keepAlive: true });
let chatHistories = {};
let globalImportantFacts = "";
let historyLoaded = false;

// ─── Форматирование ответа для Telegram ──────────────────────────────────
function formatAiResponse(thinkingText, answerText) {
    let result = '';
    if (thinkingText && thinkingText.trim()) {
        const cleanThinking = thinkingText.trim()
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        result += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${cleanThinking}</i></blockquote>\n\n`;
    }
    let answer = answerText
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/`(.*?)`/g, '<code>$1</code>');
    result += answer;
    return result;
}

// ─── HTTP запросы ─────────────────────────────────────────────────────────
function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve) => {
        let parsedUrl;
        try { parsedUrl = new URL(url); } catch(e) { console.error('Bad URL:', url); return resolve(null); }
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            agent: keepAliveAgent,
            headers: { 'Content-Type': 'application/json', ...headers }
        };
        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', (e) => { console.error('Request error:', e.message); resolve(null); });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ─── Поиск через duck-duck-scrape ─────────────────────────────────────────
async function searchWeb(query) {
    try {
        const results = await ddg.search(query, { safeSearch: ddg.SafeSearchType.MODERATE });
        if (!results || !results.results || results.results.length === 0) return null;
        return results.results.slice(0, 4)
            .map(r => `📌 ${r.title}\n${r.description}`)
            .join('\n\n');
    } catch(e) {
        console.error('Search error:', e.message);
        return null;
    }
}

function needsSearch(text) {
    const triggers = [
        'найди', 'поищи', 'погугли', 'что такое', 'кто такой', 'кто такая',
        'расскажи про', 'расскажи о', 'узнай', 'сколько стоит', 'где находится',
        'последние новости', 'новости про', 'что случилось',
        'курс ', 'погода', 'price', 'search', 'find', 'what is', 'who is'
    ];
    return triggers.some(t => text.toLowerCase().includes(t));
}

// ─── Notion: создание красивой страницы ───────────────────────────────────
async function formatForNotion(userText) {
    // Просим DeepSeek красиво оформить содержимое в JSON для Notion
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
                    content: `Ты оформляешь заметки для Notion. Получаешь текст от пользователя и возвращаешь ТОЛЬКО валидный JSON без markdown-обёртки.
Формат ответа:
{
  "title": "Краткий заголовок страницы",
  "emoji": "подходящий эмодзи",
  "blocks": [
    { "type": "heading_2", "text": "Раздел" },
    { "type": "paragraph", "text": "Текст абзаца" },
    { "type": "bulleted_list_item", "text": "Пункт списка" },
    { "type": "callout", "text": "Важная заметка", "emoji": "💡" },
    { "type": "quote", "text": "Цитата или ключевая мысль" },
    { "type": "divider" }
  ]
}
Используй разные типы блоков для красивого оформления. Структурируй информацию логично.`
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
    } catch(e) {
        console.error('Notion JSON parse error:', e.message);
        return null;
    }
}

function buildNotionBlocks(blocks) {
    return blocks.map(b => {
        const richText = (text) => [{ type: 'text', text: { content: text || '' } }];

        switch(b.type) {
            case 'heading_1':
                return { object: 'block', type: 'heading_1', heading_1: { rich_text: richText(b.text) } };
            case 'heading_2':
                return { object: 'block', type: 'heading_2', heading_2: { rich_text: richText(b.text) } };
            case 'heading_3':
                return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(b.text) } };
            case 'bulleted_list_item':
                return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(b.text) } };
            case 'numbered_list_item':
                return { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: richText(b.text) } };
            case 'callout':
                return { object: 'block', type: 'callout', callout: { rich_text: richText(b.text), icon: { type: 'emoji', emoji: b.emoji || '💡' } } };
            case 'quote':
                return { object: 'block', type: 'quote', quote: { rich_text: richText(b.text) } };
            case 'divider':
                return { object: 'block', type: 'divider', divider: {} };
            default: // paragraph
                return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(b.text) } };
        }
    });
}

async function saveToNotion(userText) {
    if (!NOTION_TOKEN || !NOTION_DATABASE_ID) {
        return '❌ Notion не настроен. Добавь NOTION_TOKEN и NOTION_DATABASE_ID в переменные Render.';
    }

    const formatted = await formatForNotion(userText);
    if (!formatted) return '❌ Не удалось оформить заметку.';

    const body = {
        parent: { database_id: NOTION_DATABASE_ID },
        icon: { type: 'emoji', emoji: formatted.emoji || '📝' },
        properties: {
            title: {
                title: [{ type: 'text', text: { content: formatted.title || 'Заметка' } }]
            }
        },
        children: buildNotionBlocks(formatted.blocks || [])
    };

    const result = await makeRequest(
        'https://api.notion.com/v1/pages',
        'POST',
        {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28'
        },
        body
    );

    if (result?.id) {
        return `✅ Сохранено в Notion!\n📄 <b>${formatted.title}</b>\n🔗 ${result.url}`;
    } else {
        console.error('Notion error:', JSON.stringify(result));
        return '❌ Ошибка сохранения в Notion. Проверь токен и ID базы данных.';
    }
}

// ─── История из SheetDB ───────────────────────────────────────────────────
async function loadHistoryFromSheet() {
    if (historyLoaded) return;
    console.log('Загружаю историю из SheetDB...');
    const data = await makeRequest(SHEETDB_URL, 'GET');
    if (Array.isArray(data)) {
        let facts = [];
        data.forEach(row => {
            if (row.chatId && row.role && row.content) {
                if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                chatHistories[row.chatId].push({ role: row.role, content: row.content });
            }
            if (row.important_fact) facts.push(row.important_fact);
        });
        globalImportantFacts = facts.join(' | ');
        historyLoaded = true;
        console.log(`✅ История загружена. Чатов: ${Object.keys(chatHistories).length}`);
    }
}

async function extractImportantFact(userText, aiAnswer) {
    const res = await makeRequest(
        'https://api.deepseek.com/v1/chat/completions',
        'POST',
        { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        {
            model: 'deepseek-chat',
            max_tokens: 80,
            messages: [
                {
                    role: 'system',
                    content: `Анализируй диалог. Есть ли важная информация о пользователе для постоянного запоминания?
Важное: имя, возраст, город, работа, семья, интересы, цели, планы, важные даты, предпочтения.
Если есть — напиши ТОЛЬКО краткий факт до 80 символов. Например: "Зовут Максим, 30 лет, живёт в Риме"
Если важного нет — ответь одним словом: НЕТ`
                },
                { role: 'user', content: `Пользователь: ${userText}\nБот: ${aiAnswer.substring(0, 300)}` }
            ]
        }
    );
    if (res?.choices) {
        const fact = res.choices[0].message.content.trim();
        if (fact && fact.toUpperCase() !== 'НЕТ' && !fact.toUpperCase().startsWith('НЕТ')) {
            console.log(`💾 Важный факт: ${fact}`);
            return fact;
        }
    }
    return '';
}

async function saveToSheet(chatId, userText, aiAnswer) {
    const importantInfo = await extractImportantFact(userText, aiAnswer);
    await makeRequest(SHEETDB_URL, 'POST', {}, {
        data: [
            { chatId, role: 'user', content: userText },
            { chatId, role: 'assistant', content: aiAnswer, important_fact: importantInfo }
        ]
    });
}

// ─── Отправка сообщения частями ───────────────────────────────────────────
async function sendMessage(chatId, text) {
    for (let i = 0; i < text.length; i += 4000) {
        await makeRequest(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            'POST', {},
            { chat_id: chatId, text: text.slice(i, i + 4000), parse_mode: 'HTML' }
        );
    }
}

// ─── Обработка сообщения ──────────────────────────────────────────────────
async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;

    const userId = upd.message.from.id.toString();
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    // 🔒 Проверка доступа — только твой аккаунт
    if (userId !== ALLOWED_USER_ID) {
        console.log(`⛔ Отклонён пользователь: ${userId}`);
        await makeRequest(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            'POST', {},
            { chat_id: chatId, text: '⛔ У тебя нет доступа к этому боту.' }
        );
        return;
    }

    console.log(`[${chatId}] ${txt.substring(0, 60)}`);

    // Показываем "печатает..."
    await makeRequest(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
        'POST', {}, { chat_id: chatId, action: 'typing' }
    );

    // 📝 Команда /notion — сохранить в Notion
    if (txt.startsWith('/notion ') || txt.startsWith('/notion\n')) {
        const noteText = txt.replace(/^\/notion[\s\n]/, '').trim();
        if (!noteText) {
            await sendMessage(chatId, '✏️ Напиши что сохранить: <code>/notion твой текст или идея</code>');
            return;
        }
        await sendMessage(chatId, '⏳ Оформляю и сохраняю в Notion...');
        const result = await saveToNotion(noteText);
        await sendMessage(chatId, result);
        return;
    }

    // 📖 Команда /help
    if (txt === '/help' || txt === '/start') {
        await sendMessage(chatId,
            `👋 <b>Привет! Вот что я умею:</b>\n\n` +
            `💬 Просто пиши — я отвечу и запомню важное\n` +
            `🔍 Попроси найти что-то — поищу в интернете\n` +
            `📝 <code>/notion текст</code> — красиво сохраню в Notion\n` +
            `🧠 Помню последние 10 сообщений + важные факты всегда`
        );
        return;
    }

    // Поиск если нужен
    let searchContext = '';
    if (needsSearch(txt)) {
        console.log('Ищу в интернете:', txt);
        const searchResult = await searchWeb(txt);
        if (searchResult) {
            searchContext = `\n\nРезультаты поиска:\n${searchResult}`;
        }
    }

    // Запрос к DeepSeek
    const res = await makeRequest(
        'https://api.deepseek.com/v1/chat/completions',
        'POST',
        { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        {
            model: 'deepseek-reasoner',
            messages: [
                {
                    role: 'system',
                    content: `Ты — умный личный помощник в Telegram. Отвечай на русском языке.
Важные факты о пользователе (помни всегда): ${globalImportantFacts}
${searchContext ? 'Используй результаты поиска для ответа.' : ''}`
                },
                ...(chatHistories[chatId] || []).slice(-10),
                { role: 'user', content: txt + searchContext }
            ]
        }
    );

    if (res?.choices) {
        const msg = res.choices[0].message;
        const thinkingText = msg.reasoning_content || '';
        const answerText = msg.content || '';

        console.log(`Мысли: ${thinkingText.substring(0, 50)}...`);
        console.log(`Ответ: ${answerText.substring(0, 50)}...`);

        const formattedAnswer = formatAiResponse(thinkingText, answerText);

        if (!chatHistories[chatId]) chatHistories[chatId] = [];
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: answerText });

        await sendMessage(chatId, formattedAnswer);
        saveToSheet(chatId, txt, answerText).catch(console.error);
    } else {
        console.error('DeepSeek ошибка:', JSON.stringify(res));
        await sendMessage(chatId, '⚠️ Ошибка AI. Попробуй ещё раз.');
    }
}

// ─── Webhook ──────────────────────────────────────────────────────────────
async function setupWebhook() {
    const result = await makeRequest(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        'POST', {},
        { url: `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}` }
    );
    console.log('Webhook:', result?.description || JSON.stringify(result));
}

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
            try { await handleUpdate(JSON.parse(body)); }
            catch(e) { console.error('Webhook parse error:', e.message); }
        });
        return;
    }
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, async () => {
    console.log(`🚀 Сервер на порту ${PORT}`);
    await loadHistoryFromSheet();
    await setupWebhook();
    console.log('✅ Бот готов!');
    startSelfPing();
});

function startSelfPing() {
    setInterval(() => {
        makeRequest(`${RENDER_URL}/`, 'GET')
            .then(() => console.log('✅ Self-ping OK'))
            .catch(() => console.log('⚠️ Self-ping failed'));
    }, 8 * 60 * 1000);
}
