const https = require('https');
const SHEETDB_URL = 'https://sheetdb.io/api/v1/1xa0d9drrl5r2';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

let chatHistories = {};
let lastProcessedMessage = new Map();

// Функция для безопасного экранирования HTML (чтобы код не ломал разметку Телеграма)
function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Универсальная функция для запросов
function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers }, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ЗАГРУЗКА ИСТОРИИ ИЗ ТАБЛИЦЫ
async function loadHistoryFromSheet() {
    try {
        const data = await makeRequest(SHEETDB_URL, 'GET', { 'Content-Type': 'application/json' });
        if (Array.isArray(data)) {
            data.forEach(row => {
                if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                chatHistories[row.chatId].push({ role: row.role, content: row.content });
            });
            console.log("История загружена из Google Таблицы!");
        }
    } catch (e) { console.error("Ошибка загрузки таблицы:", e); }
}

// МОЩНЫЙ ПОИСК В ИНТЕРНЕТЕ
async function performSearch(query) {
    // Используем расширенный поисковый HTML-интерфейс DuckDuckGo без JS, чтобы вытащить реальный текст сайтов
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const html = await makeRequest(url, 'GET', {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        });
        if (typeof html !== 'string') return "Поиск не дал результатов.";
        
        // Вырезаем куски текста из результатов поиска
        const snippets = [];
        let match;
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && snippets.length < 3) {
            snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
        }
        return snippets.length > 0 ? snippets.join(" | ") : "Ничего не найдено.";
    } catch (e) { return "Ошибка поиска в сети."; }
}

// ОБРАБОТКА ТЕКСТА БОТОМ
async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    const txt = upd.message.text;

    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    // 1. Запускаем поиск в фоне
    let context = "";
    const searchResult = await performSearch(txt);
    if (searchResult && !searchResult.includes("Ошибка")) {
        context = `Информация из интернета для справки: ${searchResult}\n`;
    }

    // 2. Запрос в DeepSeek (используем "reasoner", чтобы он выдавал блок мыслей)
    try {
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner', // <-- Оставляем думающую модель, как в твоем коде!
            messages: [
                { role: 'system', content: `Ты — личный умный помощник Максима. Отвечай дружелюбно, используй эмодзи. ${context}` },
                ...chatHistories[chatId].slice(-10),
                { role: 'user', content: txt }
            ]
        });

        const aiAnswer = res.choices[0].message.content;
        const reasoning = res.choices[0].message.reasoning_content; // Получаем мысли ИИ

        // 3. ОТПРАВКА МЫСЛЕЙ В РАЗВОРАЧИВАЕМОЙ ЦИТАТЕ
        if (reasoning) {
            const formattedReasoning = `<b>🧠 Процесс мышления (нажми, чтобы развернуть):</b>\n<blockquote expandable>${escapeHtml(reasoning)}</blockquote>`;
            await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
                { 'Content-Type': 'application/json' }, 
                { 
                    chat_id: chatId, 
                    text: formattedReasoning, 
                    parse_mode: "HTML", // Переключаем на HTML ради цитат!
                    reply_to_message_id: msgId 
                });
        }

        // 4. ОТПРАВКА ФИНАЛЬНОГО ОТВЕТА
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { 
                chat_id: chatId, 
                text: escapeHtml(aiAnswer), 
                parse_mode: "HTML",
                reply_to_message_id: msgId
            });

        // 5. СОХРАНЕНИЕ В GOOGLE ТАБЛИЦУ (чтобы бот никогда не забывал)
        await makeRequest(SHEETDB_URL, 'POST', { 'Content-Type': 'application/json' }, {
            data: [
                { chatId: chatId, role: 'user', content: txt }, 
                { chatId: chatId, role: 'assistant', content: aiAnswer }
            ]
        });
        
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: aiAnswer });

    } catch (e) { 
        console.error("Ошибка бота:", e);
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { chat_id: chatId, text: "Ошибка связи с DeepSeek.", reply_to_message_id: msgId });
    }
}

async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`, 'GET');
        if (res?.result) {
            for (const u of res.result) {
                lastUpdateId = u.update_id;
                await handleUpdate(u);
            }
        }
    } catch (e) {}
    setTimeout(poll, 2000);
}

let lastUpdateId = 0;
// Сначала загружаем бессмертную память, потом включаем чтение сообщений
loadHistoryFromSheet().then(() => poll());

// Веб-сервер для Render + UptimeRobot, чтобы бот не уходил в оффлайн
require('http').createServer((req, res) => res.end('Бот со сворачиваемыми цитатами и поиском активен!')).listen(process.env.PORT || 3000);
