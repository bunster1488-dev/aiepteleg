const https = require('https');
const ddg = require('duck-duck-scrape');
const http = require('http');

const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RENDER_URL = process.env.RENDER_URL;
const PORT = process.env.PORT || 3000;

// Проверка переменных
const REQUIRED = { SHEETDB_URL, TELEGRAM_BOT_TOKEN, DEEPSEEK_API_KEY, RENDER_URL };
const missing = Object.entries(REQUIRED).filter(([,v]) => !v).map(([k]) => k);
if (missing.length) {
    console.error(`❌ Не заданы переменные: ${missing.join(', ')}`);
    process.exit(1);
}

const keepAliveAgent = new https.Agent({ keepAlive: true });
let chatHistories = {};
let globalImportantFacts = "";
let historyLoaded = false;

// ─── Форматирование ответа ────────────────────────────────────────────────
function formatAiResponse(thinkingText, answerText) {
    let result = '';

    // Мысли — в сворачиваемую цитату (если есть)
    if (thinkingText && thinkingText.trim()) {
        const cleanThinking = thinkingText.trim()
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        result += `🧠 <b>Мысли:</b>\n<blockquote expandable><i>${cleanThinking}</i></blockquote>\n\n`;
    }

    // Основной ответ — форматируем markdown
    let answer = answerText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
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

// ─── Поиск в интернете через duck-duck-scrape ────────────────────────────
async function searchWeb(query) {
    try {
        const results = await ddg.search(query, {
            safeSearch: ddg.SafeSearchType.MODERATE
        });
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
        'когда', 'последние новости', 'новости про', 'что случилось',
        'курс ', 'погода', 'price', 'search', 'find', 'what is', 'who is'
    ];
    const lower = text.toLowerCase();
    return triggers.some(t => lower.includes(t));
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

// ─── ИИ сам решает что важно записать в колонку E ───────────────────────
async function extractImportantFact(userText, aiAnswer) {
    const res = await makeRequest(
        'https://api.deepseek.com/v1/chat/completions',
        'POST',
        { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        {
            model: 'deepseek-chat', // быстрая модель только для этой задачи
            max_tokens: 80,
            messages: [
                {
                    role: 'system',
                    content: `Ты анализируешь диалог и решаешь — есть ли здесь важная информация о пользователе, которую нужно помнить ВСЕГДА.
Важное: имя, возраст, город, работа, семья, интересы, цели, планы, важные даты, предпочтения, здоровье.
Если есть важное — напиши ТОЛЬКО краткий факт до 80 символов. Например: "Зовут Максим, 30 лет, живёт в Риме, любит книги"
Если важного нет — ответь одним словом: НЕТ`
                },
                {
                    role: 'user',
                    content: `Пользователь написал: ${userText}\nБот ответил: ${aiAnswer.substring(0, 300)}`
                }
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
    // Telegram лимит 4096 символов
    for (let i = 0; i < text.length; i += 4000) {
        const chunk = text.slice(i, i + 4000);
        await makeRequest(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            'POST', {},
            { chat_id: chatId, text: chunk, parse_mode: 'HTML' }
        );
    }
}

// ─── Обработка сообщения ──────────────────────────────────────────────────
async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;
    console.log(`[${chatId}] ${txt.substring(0, 60)}`);

    // Показываем "печатает..."
    await makeRequest(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`,
        'POST', {}, { chat_id: chatId, action: 'typing' }
    );

    // Поиск если нужен
    let searchContext = '';
    if (needsSearch(txt)) {
        console.log('Ищу в интернете:', txt);
        const searchResult = await searchWeb(txt);
        if (searchResult) {
            searchContext = `\n\nРезультаты поиска в интернете:\n${searchResult}`;
            console.log('Найдено:', searchResult.substring(0, 100));
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
                    content: `Ты — умный помощник в Telegram. Отвечай на русском языке.
Вечные факты о пользователе: ${globalImportantFacts}
${searchContext ? 'Если есть результаты поиска — используй их для ответа.' : ''}`
                },
                ...(chatHistories[chatId] || []).slice(-10),
                { role: 'user', content: txt + searchContext }
            ]
        }
    );

    if (res?.choices) {
        const msg = res.choices[0].message;

        // ВОТ ГЛАВНОЕ ИСПРАВЛЕНИЕ:
        // deepseek-reasoner возвращает мысли в reasoning_content, а ответ в content
        const thinkingText = msg.reasoning_content || '';
        const answerText = msg.content || '';

        console.log(`Мысли: ${thinkingText.substring(0, 50)}...`);
        console.log(`Ответ: ${answerText.substring(0, 50)}...`);

        const formattedAnswer = formatAiResponse(thinkingText, answerText);

        // Обновляем кэш в памяти
        if (!chatHistories[chatId]) chatHistories[chatId] = [];
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: answerText });

        await sendMessage(chatId, formattedAnswer);

        // Сохраняем в SheetDB асинхронно
        saveToSheet(chatId, txt, answerText).catch(console.error);
    } else {
        console.error('DeepSeek ошибка:', JSON.stringify(res));
        await sendMessage(chatId, '⚠️ Ошибка при обращении к AI. Попробуй ещё раз.');
    }
}

// ─── Webhook ──────────────────────────────────────────────────────────────
async function setupWebhook() {
    const webhookUrl = `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}`;
    const result = await makeRequest(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        'POST', {},
        { url: webhookUrl }
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
            try {
                const update = JSON.parse(body);
                await handleUpdate(update);
            } catch(e) {
                console.error('Webhook parse error:', e.message);
            }
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

// Self-ping каждые 8 минут чтобы Render не засыпал
function startSelfPing() {
    setInterval(() => {
        makeRequest(`${RENDER_URL}/`, 'GET')
            .then(() => console.log('✅ Self-ping OK'))
            .catch(() => console.log('⚠️ Self-ping failed'));
    }, 8 * 60 * 1000);
}
