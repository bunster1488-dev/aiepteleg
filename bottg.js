const https = require('https');
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
// Сворачиваем <think>...</think> в красивый HTML блок
function formatAiResponse(text) {
    let formatted = text.replace(
        /<think>([\s\S]*?)<\/think>/gi,
        '🧠 <b>Мысли:</b>\n<blockquote expandable><i>$1</i></blockquote>'
    );
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    formatted = formatted.replace(/`(.*?)`/g, '<code>$1</code>');
    return formatted;
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

// ─── Поиск в интернете через DuckDuckGo ──────────────────────────────────
async function searchWeb(query) {
    const encoded = encodeURIComponent(query);
    const data = await makeRequest(
        `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
        'GET'
    );
    if (!data) return null;

    let results = [];

    // Главный ответ
    if (data.AbstractText) results.push(data.AbstractText);

    // Топ результаты
    if (Array.isArray(data.RelatedTopics)) {
        data.RelatedTopics.slice(0, 3).forEach(t => {
            if (t.Text) results.push(t.Text);
        });
    }

    return results.length > 0 ? results.join('\n\n') : null;
}

// Определяем — нужен ли поиск по тексту сообщения
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

async function saveToSheet(chatId, userText, aiAnswer) {
    const isImportant = /это важно\.?$/i.test(aiAnswer.trim());
    const importantInfo = isImportant ? aiAnswer.substring(0, 100) : '';
    await makeRequest(SHEETDB_URL, 'POST', {}, {
        data: [
            { chatId, role: 'user', content: userText },
            { chatId, role: 'assistant', content: aiAnswer, important_fact: importantInfo }
        ]
    });
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
        const aiAnswer = res.choices[0].message.content;
        const formattedAnswer = formatAiResponse(aiAnswer);

        // Обновляем кэш в памяти
        if (!chatHistories[chatId]) chatHistories[chatId] = [];
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: aiAnswer });

        // Telegram ограничивает сообщения до 4096 символов
        const chunks = [];
        for (let i = 0; i < formattedAnswer.length; i += 4000) {
            chunks.push(formattedAnswer.slice(i, i + 4000));
        }
        for (const chunk of chunks) {
            await makeRequest(
                `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                'POST', {},
                { chat_id: chatId, text: chunk, parse_mode: 'HTML' }
            );
        }

        // Сохраняем в SheetDB асинхронно
        saveToSheet(chatId, txt, aiAnswer).catch(console.error);
    } else {
        console.error('DeepSeek ошибка:', JSON.stringify(res));
        await makeRequest(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            'POST', {},
            { chat_id: chatId, text: '⚠️ Ошибка при обращении к AI. Попробуй ещё раз.' }
        );
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
});
