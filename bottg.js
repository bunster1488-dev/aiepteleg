const https = require('https');
const fs = require('fs');
const path = require('path');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const HISTORY_FILE = path.join(__dirname, 'history.json');
const MAX_HISTORY = 10;

let chatHistories = {};
if (fs.existsSync(HISTORY_FILE)) {
    try { chatHistories = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) {}
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistories, null, 2), 'utf8');
}

function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, { method, headers }, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

// Функция поиска через DuckDuckGo (без внешних библиотек)
async function searchWeb(query) {
    console.log(`🔍 Ищу в интернете: ${query}`);
    try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        const html = await response.text();
        return html.substring(0, 3000); 
    } catch (e) { return "Ошибка поиска."; }
}

async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const txt = upd.message.text;

    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    try {
        // 1. Проверяем, нужен ли поиск
        const checkRes = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-chat',
            messages: [{ role: 'system', content: 'Если вопрос требует поиска в интернете, напиши только короткий поисковый запрос. Если нет — верни "НЕТ".' }, { role: 'user', content: txt }]
        });

        let searchResult = "";
        const query = checkRes.choices[0].message.content.trim();
        if (query !== "НЕТ" && query.length < 100) {
            searchResult = await searchWeb(query);
        }

        // 2. Основной запрос к DeepSeek
        const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: `Контекст интернета: ${searchResult}. Ты — Максим, ассистент.` },
                ...chatHistories[chatId],
                { role: 'user', content: txt }
            ]
        });
// 2. Формируем текст
        const msg = res.choices[0].message;
        let finalMessage = "";
        
        if (msg.reasoning_content) {
            // Используем обычный Markdown, он менее прихотлив к спецсимволам
            finalMessage = `🧠 *Размышления:* \n\n${msg.reasoning_content}\n\n*Ответ:*\n\n`;
        }
        finalMessage += msg.content;
        
        // ВАЖНО: используем "Markdown", а не "MarkdownV2"
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', 
            { 'Content-Type': 'application/json' }, 
            { chat_id: chatId, text: finalMessage, parse_mode: "Markdown" });
        // ----------------------------------------
        
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: finalMessage });
        if (chatHistories[chatId].length > MAX_HISTORY * 2) chatHistories[chatId] = chatHistories[chatId].slice(-MAX_HISTORY * 2);
        saveHistory();
        console.log("✅ Ответ успешно отправлен.");
    } catch (e) { console.error("Ошибка:", e); }
}

let lastUpdateId = 0;
async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, 'POST', { 'Content-Type': 'application/json' }, { offset: lastUpdateId + 1, timeout: 30 });
        if (res?.ok && res.result.length > 0) {
            lastUpdateId = res.result[res.result.length - 1].update_id;
            for (const u of res.result) await handleUpdate(u);
        }
    } catch (e) {}
    setTimeout(poll, 1000);
}

console.log("🚀 Бот запущен и готов к работе!");
poll();
// Добавь это в конец файла bot.js
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Бот работает!');
    res.end();
}).listen(process.env.PORT || 3000);
