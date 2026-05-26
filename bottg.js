    safeText = safeText.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    safeText = safeText.replace(/`(.*?)`/g, '<code>$1</code>');
    return safeText;
}

async function makeRequest(url, method = 'POST', headers = {}, body = null) {
    return new Promise((resolve) => {
        const parsedUrl = new URL(url);
        const options = { hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, method: method, agent: keepAliveAgent, headers: { ...headers, 'Content-Type': 'application/json' } };
        const req = https.request(options, (res) => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { resolve(buf); } });
        });
        req.on('error', () => resolve(null));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function performSearch(query) {
    try {
        const html = await makeRequest(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, 'GET', { 'User-Agent': 'Mozilla/5.0' });
        const snippets = [];
        let match, regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = regex.exec(html)) !== null && snippets.length < 2) {
            snippets.push(match[1].replace(/<[^>]*>/g, '').trim());
        }
        return snippets.join(" | ");
    } catch (e) { return ""; }
}

async function getFileContent(fileId) {
    try {
        const fileInfo = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`, 'GET');
        if (!fileInfo.result?.file_path) return null;
        return new Promise((resolve) => {
            https.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => resolve(data));
            }).on('error', () => resolve(null));
        });
    } catch (e) { return null; }
}

async function loadHistoryFromSheet() {
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
        globalImportantFacts = facts.join(" | ");
    }
}

async function handleUpdate(upd) {
    if (!upd.message) return;
    try { await loadHistoryFromSheet(); } catch (e) {}

    const chatId = upd.message.chat.id.toString();
    const msgId = upd.message.message_id;
    let txt = upd.message.text || "";

    if (upd.message.document) {
        const content = await getFileContent(upd.message.document.file_id);
        if (content) txt = `[Файл]:\n${content}\n\n[Вопрос]: ${txt}`;
    }
    if (!txt) return;

    const searchResult = await performSearch(txt);
    
    const res = await makeRequest('https://api.deepseek.com/v1/chat/completions', 'POST', {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
    }, {
        model: 'deepseek-reasoner',
        messages: [
            { role: 'system', content: `Ты помощник Максима. Факты: ${globalImportantFacts}. Поиск: ${searchResult}` },
            { role: 'user', content: txt }
        ]
    });

    if (res?.choices) {
        const aiAnswer = res.choices[0].message.content;
        await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, 'POST', {}, { 
            chat_id: chatId, text: cleanMdToHtml(aiAnswer), parse_mode: "HTML"
        });

        if (/это важно/i.test(aiAnswer)) {
            await makeRequest(SHEETDB_URL, 'POST', {}, { data: [{ chatId, role: 'assistant', content: aiAnswer, important_fact: aiAnswer.substring(0, 50) }] });
        }
    }
}

async function poll() {
    const res = await makeRequest(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`, 'GET');
    if (res?.ok) { for (const u of res.result) { lastUpdateId = u.update_id; await handleUpdate(u); } }
    setTimeout(poll, 1000);
}

loadHistoryFromSheet().then(poll);
require('http').createServer((req, res) => res.end('OK')).listen(process.env.PORT || 3000);