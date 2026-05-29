const https = require('https');
const http = require('http');

const SHEETDB_URL = process.env.SHEETDB_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const PORT = process.env.PORT || 3000;
// ВАШ URL на Render, например: https://my-bot.onrender.com
const RENDER_URL = process.env.RENDER_URL;

const keepAliveAgent = new https.Agent({ keepAlive: true });

// Кэш истории — загружается один раз при старте, не на каждое сообщение
let chatHistories = {};
let globalImportantFacts = "";
let historyLoaded = false;

// ─── Утилиты ───────────────────────────────────────────────────────────────

function formatAiResponse(text) {
    let formatted = text.replace(
        /<think>([\s\S]*?)<\/think>/gi,
        '<details><summary><b>Подумал...</b></summary><i>$1</i></details>'
    );
    return formatted
        .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
        .replace(/`(.*?)`/g, '<code>$1</code>');
}

function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve) => {
        const parsedUrl = new URL(url);
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
            res.on('end', () => {
                try { resolve(JSON.parse(buf)); } catch (e) { resolve(buf); }
            });
        });
        req.on('error', (err) => {
            console.error('Request error:', err.message);
            resolve(null);
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ─── История ───────────────────────────────────────────────────────────────

async function loadHistoryFromSheet() {
    if (historyLoaded) return; // Загружаем только один раз
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
        console.log(`История загружена. Чатов: ${Object.keys(chatHistories).length}`);
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

// ─── Обработка сообщения ───────────────────────────────────────────────────

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;

    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    console.log(`[${chatId}] Сообщение: ${txt.substring(0, 50)}`);

    const res = await makeRequest(
        'https://api.deepseek.com/v1/chat/completions',
        'POST',
        { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: `Ты — помощник. Вечные факты: ${globalImportantFacts}` },
                ...(chatHistories[chatId] || []).slice(-10),
                { role: 'user', content: txt }
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

        // Отправляем ответ пользователю
        await makeRequest(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            'POST',
            {},
            { chat_id: chatId, text: formattedAnswer, parse_mode: 'HTML' }
        );

        // Сохраняем в таблицу асинхронно (не блокируем ответ)
        saveToSheet(chatId, txt, aiAnswer).catch(console.error);
    } else {
        console.error('DeepSeek ошибка:', JSON.stringify(res));
    }
}

// ─── Webhook сервер ────────────────────────────────────────────────────────

async function setupWebhook() {
    if (!RENDER_URL) {
        console.error('❌ Переменная RENDER_URL не задана! Установите её в настройках Render.');
        return;
    }
    const webhookUrl = `${RENDER_URL}/webhook/${TELEGRAM_BOT_TOKEN}`;
    const result = await makeRequest(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
        'POST',
        {},
        { url: webhookUrl }
    );
    console.log('Webhook установлен:', JSON.stringify(result));
}

const server = http.createServer(async (req, res) => {
    // Health check — Render и UptimeRobot пингуют сюда
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Бот активен!');
        return;
    }

    // Webhook от Telegram
    if (req.method === 'POST' && req.url === `/webhook/${TELEGRAM_BOT_TOKEN}`) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            res.writeHead(200); // Сразу отвечаем Telegram — важно!
            res.end('OK');
            try {
                const update = JSON.parse(body);
                await handleUpdate(update);
            } catch (e) {
                console.error('Ошибка обработки webhook:', e.message);
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

// ─── Старт ─────────────────────────────────────────────────────────────────

server.listen(PORT, async () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    await loadHistoryFromSheet();
    await setupWebhook();
    console.log('✅ Бот готов к работе!');
});
