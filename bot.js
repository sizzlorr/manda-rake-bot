// bot.js
const path = require('path');
const { load, save, ensureUser, nextId } = require('./storage');
const { checkMandarake } = require('./scraper');
const { readableDate } = require('./helper');
const TelegramBot = require('node-telegram-bot-api');
const { DateTime } = require('luxon');
const pLimit = require('p-limit');
const logger = require('./logger');

const cfg = require('./config.json');
if (!cfg.botToken || cfg.botToken.includes('1234')) {
    logger.error('Put your BOT token into config.json -> botToken');
    process.exit(1);
}
const bot = new TelegramBot(cfg.botToken, { polling: true });

const DB_FILE = path.resolve(__dirname, 'data.json');
let db = load();

// helper: persist
function persist() {
    save(db);
}

// utilities
function findItemByIdOrName(user, q) {
    const byId = user.items.find(i => i.id === q);
    if (byId) return byId;
    return user.items.find(i => i.name.toLowerCase() === q.toLowerCase());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Commands ---

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const help = [
        'Mandarake Watch Bot commands:',
        '/add <name> <url> - add new watch item (name can include spaces)',
        '/remove <id_or_name> - remove item',
        '/list - show your watch list',
        '/start - enable alerts for all your items',
        '/stop - disable alerts for all your items',
        '/start <id_or_name> - enable single item',
        '/stop <id_or_name> - disable single item',
        '/check <id_or_url> - force check item now',
        '/help - show this help'
    ].join('\n');
    void bot.sendMessage(chatId, help);
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const payload = match[1].trim();
    // url is last token
    const tokens = payload.split(/\s+/);
    const url = tokens[tokens.length - 1];
    const name = tokens.slice(0, tokens.length - 1).join(' ');
    if (!url || !/^https?:\/\//.test(url) || !name) {
        return bot.sendMessage(chatId, 'Usage: /add <name> <url>');
    }

    const user = ensureUser(db, chatId);
    const id = nextId();
    const item = { id, name, url, enabled: true, lastStatus: 'unknown', lastChecked: null };
    user.items.push(item);
    persist();
    void bot.sendMessage(chatId, `Added item:\n[${id}] ${name}\n${url}`);
});

bot.onText(/\/list/, (msg) => {
    const chatId = String(msg.chat.id);
    const user = ensureUser(db, chatId);
    if (!user.items.length) return bot.sendMessage(chatId, 'Your watch list is empty. Use /add');
    let out = 'Your items:\n';
    user.items.forEach(it => {
        out += `
        \n${it.name}\n[${it.id}]\n
        ${it.url}\n
        Enabled: ${it.enabled}\n
        Last status: ${it.lastStatus === 'in' ? '✅ in' : '❌ out'}\n
        Last Checked: ${it.lastChecked ? readableDate(it.lastChecked) : '-'}\n
        `;
    });
    bot.sendMessage(chatId, out);
});

bot.onText(/\/remove (.+)/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const q = match[1].trim();
    const user = ensureUser(db, chatId);
    const idx = user.items.findIndex(i => i.id === q || i.name.toLowerCase() === q.toLowerCase());
    if (idx === -1) return bot.sendMessage(chatId, 'Item not found');
    const [removed] = user.items.splice(idx, 1);
    persist();
    void bot.sendMessage(chatId, `Removed ${removed.name}`);
});

bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg = match[1];
    const user = ensureUser(db, chatId);
    if (!arg) {
        user.enabled = true;
        user.items.forEach(i => i.enabled = true);
        persist();
        return bot.sendMessage(chatId, 'Alerts enabled for all items.');
    }
    const item = findItemByIdOrName(user, arg.trim());
    if (!item) return bot.sendMessage(chatId, 'Item not found');
    item.enabled = true;
    persist();
    void bot.sendMessage(chatId, `Enabled alerts for ${item.name}`);
});

bot.onText(/\/stop(?:\s+(.+))?/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg = match[1];
    const user = ensureUser(db, chatId);
    if (!arg) {
        user.enabled = false;
        persist();
        return bot.sendMessage(chatId, 'Alerts disabled for all items.');
    }
    const item = findItemByIdOrName(user, arg.trim());
    if (!item) return bot.sendMessage(chatId, 'Item not found');
    item.enabled = false;
    persist();
    void bot.sendMessage(chatId, `Disabled alerts for ${item.name}`);
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg = match[1].trim();
    const user = ensureUser(db, chatId);

    // allow checking by id, name or raw url
    let item = findItemByIdOrName(user, arg);
    let url = arg;
    if (item) url = item.url;
    if (!/^https?:\/\//.test(url)) return bot.sendMessage(chatId, 'Provide a valid URL or item id/name');

    void bot.sendMessage(chatId, `Checking: ${url} ...`);
    try {
        // { url, isInStock, isInMainInStock, sameItemInOtherStores, itemName, parentShopName }
        const res = await checkMandarake(url, {
            timeout: cfg.requestTimeoutMs,
            userAgent: cfg.userAgent
        });
        let msgOut = `
        Result for ${item ? item.name : url}:\n
        ${res.itemName}\n
        In stock: ${res.isInStock ? '✅' : '❌'}\n
        Store: ${res.parentShopName}\n
        `;
        if (res.sameItemInOtherStores.length) {
            msgOut += '\nOther stores:\n' + res.sameItemInOtherStores.map(s => `${s.shop} - ${s.hasAdd ? '✅' : '❌'} - ${s.price} ${s.isDefective ? '(defective item)' : ''}`).join('\n');
        }
        void bot.sendMessage(chatId, msgOut);
    } catch (e) {
        logger.error('check error', e && e.message);
        void bot.sendMessage(chatId, 'Error checking URL: ' + (e && e.message));
    }
});

let running = false;

function isWithinWorkingHours() {
    const nowInJapan = DateTime.now().setZone('Asia/Tokyo');
    const hour = nowInJapan.hour;
    const start = cfg.workingHours?.start ?? 5;
    const end = cfg.workingHours?.end ?? 23;
    return hour >= start && hour < end;
}

async function pollAll() {
    if (!isWithinWorkingHours()) {
        logger.info("🌙 Outside Japan working hours (5:00–23:00 JST) — skipping checks.");
        return;
    }

    if (running) return;
    running = true;
    try {
        const users = db.users || {};
        const limit = pLimit(2); // <= only 2 concurrent checks

        for (const chatId of Object.keys(users)) {
            const user = users[chatId];
            if (!user || !user.items) continue;
            if (user.enabled === false) continue;

            const tasks = user.items
                .filter(item => item.enabled)
                .map(item =>
                    limit(async () => {
                        try {
                            const res = await checkMandarake(item.url, {
                                timeout: cfg.requestTimeoutMs,
                                userAgent: cfg.userAgent
                            });
                            const nowStatus = res.isInStock ? 'in' : 'out';

                            if (!item.lastStatus || item.lastStatus === 'unknown') {
                                item.lastStatus = nowStatus;
                                item.lastChecked = new Date().toISOString();
                                persist();
                                return;
                            }

                            if (item.lastStatus === 'out' && nowStatus === 'in') {
                                let body = `
🔥 Item now IN STOCK:\n
${res.itemName}\n
${item.url}\n
`;
                                if (res.isInMainInStock) body += `Available in ${res.parentShopName}\n`;
                                if (res.sameItemInOtherStores?.length) {
                                    const availableShops = res.sameItemInOtherStores
                                        .filter(s => s.hasAdd && !s.soldOut)
                                        .map(s => `${s.shop} (${s.price || 'No price'})`);
                                    if (availableShops.length) {
                                        body += `\nOther Store(s):\n${availableShops.join(', ')}\n`;
                                    }
                                }
                                await bot.sendMessage(chatId, body);
                            }

                            item.lastStatus = nowStatus;
                            item.lastChecked = new Date().toISOString();
                            persist();

                        } catch (e) {
                            logger.error('item check error', item.url, e?.message);
                            item.lastChecked = new Date().toISOString();
                            persist();
                        }
                    })
                );

            await Promise.allSettled(tasks); // run with concurrency cap
        }
    } finally {
        running = false;
    }
}

// start periodic polling
const intervalMs = (cfg.checkIntervalSec || 300) * 1000;
logger.info(`Starting poll every ${intervalMs / 1000} sec`);
setInterval(pollAll, intervalMs);
void pollAll(); // run immediately on start

// graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    persist();
    process.exit(0);
});
