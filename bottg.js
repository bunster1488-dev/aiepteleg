const https = require('https');
const SHEETDB_URL = process.env.SHEETDB_URL || 'https://sheetdb.io/api/v1/1xa0d9drrl5r2';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

// Использование Keep-Alive агента для ускорения сетевых запросов (устраняет лишний SSL-handshake)
const keepAliveAgent = new https.Agent({ 
    keepAlive: true, 
    keepAliveMsecs: 5000, 
    maxSockets: 50 
});

let chatHistories = {};
let lastProcessedMessage = new Map();
let lastUpdateId = 0;
const processingChats = new Set(); // Блокировка от гонки запросов (Race Condition)

// Безопасное экранирование спецсимволов HTML
function escapeHtml(text) {
    if (!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Защищенный перевод Markdown в HTML с экранированием содержимого блоков кода
function cleanMdToHtml(text) {
    if (!text) return "";
    
    // Экранируем сначала весь текст, чтобы избежать инъекций HTML
    let safeText = escapeHtml(text);
    
    // Безопасная обработка блоков кода ```js ... ```
    const codeBlockRegex = new RegExp('\\x60\\x60\\x60(?:[a-zA-Z]+)?\\n([\\s\\S]*?)\\x60\\x60\\x60', 'g');
    safeText = safeText.replace(codeBlockRegex, '<pre>$1</pre>');
    
    // Безопасная замена жирного текста (не жадная, устойчивая к зависаниям ReDoS)
    safeText = safeText.replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>');
    
    // Безопасная замена инлайнового кода `код`
    const inlineCodeRegex = new RegExp('\\x60([^\\x60\\n]+?)\\x60', 'g');
    safeText = safeText.replace(inlineCodeRegex, '<code>$1</code>');
    
    return safeText;
}

// Универсальная функция запросов с поддержкой Keep-Alive, таймаутов и обработки ошибок статуса
function makeRequest(url, method = 'POST', headers = {}, body = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        
        const options = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            agent: keepAliveAgent, // Подключаем Keep-Alive
            timeout: timeoutMs,    // Защита от зависания запроса
            headers: { ...headers }
        };

        if (body && method === 'POST') {
            body = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => {
                // Если API вернул ошибку авторизации или лимитов, передаем статус
                if (res.statusCode >= 400) {
                    return reject(new Error(`API Error: ${res.statusCode}. Response: ${buf.slice(0, 200)}`));
                }
                try { 
                    resolve(JSON.parse(buf)); 
                } catch(e) { 
                    resolve(buf); // Если вернулся не JSON (например, HTML от Cloudflare)
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Request timeout for ${url}`));
        });

        req.on('error', reject);
        
        if (body && method === 'POST') {
            req.write(body);
        }
        req.end();
    });
}

// Повторные попытки запроса (Retries) с экспоненциальной задержкой
async function makeRequestWithRetry(url, method = 'POST', headers = {}, body = null, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await makeRequest(url, method, headers, body);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`Запрос не удался (попытка ${i + 1}/${retries}). Повтор через ${delay}мс...`);
            await new Promise(res => setTimeout(res, delay));
            delay *= 2; // Экспоненциальное увеличение паузы
        }
    }
}

// Отправка статуса «ИИ думает...» ( typing ) в чат
async function sendTypingStatus(chatId) {
    try {
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`, 'POST', {}, {
            chat_id: chatId,
            action: 'typing'
        });
    } catch (e) {
        console.error("Не удалось отправить статус typing:", e.message);
    }
}

// Загрузка истории чата из таблицы SheetDB (только последние 50 строк для экономии RAM)
async function loadHistoryFromSheet() {
    try {
        // Лимитируем загрузку последних записей, чтобы избежать падения по лимиту памяти
        const data = await makeRequestWithRetry(`${SHEETDB_URL}?limit=100&sort_by=id&sort_order=desc`, 'GET');
        if (Array.isArray(data)) {
            chatHistories = {};
            // Заполняем историю в хронологическом порядке (так как получили по desc)
            data.reverse().forEach(row => {
                if (!row.chatId) return;
                if (!chatHistories[row.chatId]) chatHistories[row.chatId] = [];
                chatHistories[row.chatId].push({ role: row.role, content: row.content });
            });
            
            // Жестко ограничиваем локальный размер кэша
            Object.keys(chatHistories).forEach(chatId => {
                if (chatHistories[chatId].length > 20) {
                    chatHistories[chatId] = chatHistories[chatId].slice(-20);
                }
            });
            console.log("История успешно синхронизирована с Google Таблицей!");
        }
    } catch (e) { 
        console.error("Ошибка загрузки таблицы истории:", e.message); 
    }
}

// Надежный поиск без завязки на хрупкую верстку (извлекаем текстовые блоки безопаснее)
async function performSearch(query) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    try {
        const html = await makeRequestWithRetry(url, 'GET', {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        
        if (typeof html !== 'string') return "";
        
        const snippets = [];
        let match;
        // Универсальное регулярное выражение для поиска сниппетов ( DDG HTML )
        const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && snippets.length < 3) {
            const cleanText = match[1].replace(/<[^>]*>/g, '').trim();
            if (cleanText) snippets.push(cleanText);
        }
        return snippets.length > 0 ? snippets.join(" | ") : "";
    } catch (e) { 
        console.error("Ошибка поиска в сети:", e.message);
        return ""; 
    }
}

// Обработка входящих обновлений от Telegram
async function handleUpdate(upd) {
    if (!upd.message || !upd.message.text) return;
    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    const txt = upd.message.text;

    // Защита от дублирующейся обработки одного и того же обновления
    if (lastProcessedMessage.get(chatId) === msgId) return;
    lastProcessedMessage.set(chatId, msgId);

    // Защита от Race Condition: если предыдущий запрос этого чата еще обрабатывается ИИ
    if (processingChats.has(chatId)) {
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, {
            chat_id: chatId,
            text: "⚠️ Я ещё думаю над твоим прошлым вопросом, подожди немного!",
            reply_to_message_id: msgId
        });
        return;
    }

    processingChats.add(chatId);
    if (!chatHistories[chatId]) chatHistories[chatId] = [];

    // Отправляем первый статус "печатает"
    await sendTypingStatus(chatId);
    // Интервал для поддержки статуса "печатает" каждые 4 секунды, пока ИИ думает
    const typingInterval = setInterval(() => sendTypingStatus(chatId), 4000);

    let context = "";
    const searchResult = await performSearch(txt);
    if (searchResult) {
        context = `Информация из интернета для справки: ${searchResult}\n`;
    }

    try {
        // Запрос к DeepSeek Reasoner с повторными попытками при сбоях сети
        const res = await makeRequestWithRetry('https://api.deepseek.com/v1/chat/completions', 'POST', {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }, {
            model: 'deepseek-reasoner',
            messages: [
                { role: 'system', content: `Ты — личный умный помощник Максима. Отвечай дружелюбно, используй эмодзи. ${context}` },
                ...chatHistories[chatId].slice(-10), 
                { role: 'user', content: txt }
            ]
        });

        clearInterval(typingInterval); // Останавливаем индикатор печати

        if (!res.choices || !res.choices[0]) {
            throw new Error("Неверная структура ответа от API DeepSeek");
        }

        const aiAnswer = res.choices[0].message.content;
        const reasoning = res.choices[0].message.reasoning_content;

        // 1. Отправка процесса размышлений в свернутом блоке
        if (reasoning) {
            const formattedReasoning = `<b>🧠 Процесс мышления (нажми, чтобы развернуть):</b>\n<blockquote expandable>${escapeHtml(reasoning)}</blockquote>`;
            await makeRequestWithRetry(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
                chat_id: chatId, 
                text: formattedReasoning, 
                parse_mode: "HTML",
                reply_to_message_id: msgId 
            });
        }

        // 2. Отправка итогового ответа
        await makeRequestWithRetry(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, 
            text: cleanMdToHtml(aiAnswer), 
            parse_mode: "HTML",
            reply_to_message_id: msgId
        });

        // 3. Сохранение реплик в локальную историю чата
        chatHistories[chatId].push({ role: 'user', content: txt });
        chatHistories[chatId].push({ role: 'assistant', content: aiAnswer });
        
        if (chatHistories[chatId].length > 20) {
            chatHistories[chatId] = chatHistories[chatId].slice(-20);
        }

        // 4. Безопасное сохранение истории в Google Таблицу (фоновое, не блокирует чат)
        makeRequest(SHEETDB_URL, 'POST', {}, {
            data: [
                { chatId: chatId, role: 'user', content: txt }, 
                { chatId: chatId, role: 'assistant', content: aiAnswer }
            ]
        }).catch(err => console.error("Ошибка фоновой записи истории в SheetDB:", err.message));

    } catch (e) { 
        clearInterval(typingInterval);
        console.error("Ошибка во время обработки handleUpdate:", e);
        
        let errorText = "Ошибка связи с ИИ. Попробуй позже.";
        if (e.message.includes("401")) errorText = "❌ Ошибка авторизации: проверь API-ключ DeepSeek.";
        if (e.message.includes("402")) errorText = "💳 На балансе API DeepSeek закончились средства.";

        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, 
            text: errorText, 
            reply_to_message_id: msgId 
        }).catch(err => console.error("Не удалось отправить сообщение об ошибке:", err.message));
    } finally {
        processingChats.delete(chatId); // Разблокируем чат для новых сообщений
    }
}

// Стабильный цикл долгого опроса (Long Polling)
async function poll() {
    try {
        const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, 'GET', {}, null, 35000);
        if (res && res.ok && Array.isArray(res.result)) {
            for (const u of res.result) {
                lastUpdateId = u.update_id;
                await handleUpdate(u);
            }
        }
    } catch (e) {
        console.error("Системная ошибка сети во время пулинга:", e.message);
        // При сетевой ошибке увеличиваем паузу перед перезапуском, чтобы не спамить логи при отключении интернета
        await new Promise(res => setTimeout(res, 5000));
    }
    setTimeout(poll, 1000);
}

// Инициализация
loadHistoryFromSheet().then(() => poll());

// Веб-сервер заглушка для Render и UptimeRobot
const server = require('http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Бот со сворачиваемыми цитатами, памятью Google Sheets и поиском активен!');
});

server.on('error', (err) => console.error("Ошибка веб-сервера:", err.message));
server.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${process.env.PORT || 3000}`);
});
