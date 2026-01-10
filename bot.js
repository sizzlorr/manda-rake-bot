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

// --- Keyboards ---

const mainMenu = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📋 My List', callback_data: 'list' }, { text: '➕ Add Item', callback_data: 'add' }],
            [{ text: '▶️ Start All', callback_data: 'start_all' }, { text: '⏹️ Stop All', callback_data: 'stop_all' }],
            [{ text: '🔄 Check All', callback_data: 'check_all' }, { text: '❓ Help', callback_data: 'help' }]
        ]
    }
};

function getItemButtons(items, page = 0) {
    const ITEMS_PER_PAGE = 5;
    const start = page * ITEMS_PER_PAGE;
    const pageItems = items.slice(start, start + ITEMS_PER_PAGE);
    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

    const buttons = pageItems.map(it => ([
        { text: `${it.enabled ? '✅' : '❌'} ${it.name.slice(0, 20)}`, callback_data: `item_${it.id}` }
    ]));

    // Pagination row
    if (totalPages > 1) {
        const navRow = [];
        if (page > 0) {
            navRow.push({ text: '⬅️ Prev', callback_data: `page_${page - 1}` });
        }
        navRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'noop' });
        if (page < totalPages - 1) {
            navRow.push({ text: 'Next ➡️', callback_data: `page_${page + 1}` });
        }
        buttons.push(navRow);
    }

    // Back to menu
    buttons.push([{ text: '🔙 Back to Menu', callback_data: 'menu' }]);

    return { reply_markup: { inline_keyboard: buttons } };
}

function getItemActionButtons(itemId) {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🔍 Check Now', callback_data: `check_${itemId}` },
                    { text: '🔄 Toggle', callback_data: `toggle_${itemId}` }
                ],
                [
                    { text: '🗑️ Remove', callback_data: `confirmremove_${itemId}` },
                    { text: '🔙 Back to List', callback_data: 'list' }
                ]
            ]
        }
    };
}

// --- Commands ---

bot.onText(/\/menu/, (msg) => {
    bot.sendMessage(msg.chat.id, '🤖 Mandarake Watch Bot\n\nChoose an action:', mainMenu);
});

bot.onText(/\/start$/, (msg) => {
    bot.sendMessage(msg.chat.id, '👋 Welcome to Mandarake Watch Bot!\n\nI will notify you when items become available.\n\nChoose an action:', mainMenu);
});

bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const help = [
        '🤖 Mandarake Watch Bot',
        '',
        'Use /menu for button interface or commands:',
        '',
        '/add <name> <url> - add new watch item',
        '/remove <id_or_name> - remove item',
        '/list - show your watch list',
        '/start - enable alerts for all items',
        '/stop - disable alerts for all items',
        '/check <id_or_url> - force check item now',
        '/menu - show button menu',
        '/help - show this help'
    ].join('\n');
    bot.sendMessage(chatId, help, mainMenu);
});

// --- Callback Query Handler ---

bot.on('callback_query', async (query) => {
    const chatId = String(query.message.chat.id);
    const messageId = query.message.message_id;
    const data = query.data;
    const user = ensureUser(db, chatId);

    // Acknowledge button press
    await bot.answerCallbackQuery(query.id);

    // Menu
    if (data === 'menu') {
        await bot.editMessageText('🤖 Mandarake Watch Bot\n\nChoose an action:', {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu
        });
    }

    // List items
    else if (data === 'list' || data.startsWith('page_')) {
        const page = data.startsWith('page_') ? parseInt(data.replace('page_', '')) : 0;

        if (!user.items.length) {
            await bot.editMessageText('📋 Your watch list is empty.\n\nUse ➕ Add Item to start watching.', {
                chat_id: chatId,
                message_id: messageId,
                ...mainMenu
            });
            return;
        }

        const text = `📋 Your items (${user.items.length} total):\n\nTap an item to manage it:`;
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...getItemButtons(user.items, page)
        });
    }

    // View single item
    else if (data.startsWith('item_')) {
        const id = data.replace('item_', '');
        const item = user.items.find(i => i.id === id);
        if (!item) {
            await bot.answerCallbackQuery(query.id, { text: 'Item not found' });
            return;
        }

        const text = `✦ ${item.name}

🆔 ID: ${item.id}
🔗 ${item.url}
📊 Status: ${item.enabled ? '✅ Enabled' : '❌ Disabled'}
📦 Last check: ${item.lastStatus === 'in' ? '✅ In Stock' : '❌ Out of Stock'}
🕐 Checked: ${item.lastChecked ? readableDate(item.lastChecked) : 'Never'}`;

        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...getItemActionButtons(id)
        });
    }

    // Add item instruction
    else if (data === 'add') {
        await bot.editMessageText('➕ To add an item, send:\n\n`/add Item Name https://order.mandarake.co.jp/...`\n\nExample:\n`/add Gundam MG https://order.mandarake.co.jp/order/detailPage/item?itemCode=123456`', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'menu' }]]
            }
        });
    }

    // Start all
    else if (data === 'start_all') {
        user.enabled = true;
        user.items.forEach(i => i.enabled = true);
        persist();
        await bot.editMessageText('▶️ Alerts enabled for all items!', {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu
        });
    }

    // Stop all
    else if (data === 'stop_all') {
        user.enabled = false;
        user.items.forEach(i => i.enabled = false);
        persist();
        await bot.editMessageText('⏹️ Alerts disabled for all items.', {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu
        });
    }

    // Help
    else if (data === 'help') {
        const help = `🤖 Mandarake Watch Bot

📋 My List - View and manage watched items
➕ Add Item - Add new item to watch
▶️ Start All - Enable all alerts
⏹️ Stop All - Disable all alerts
🔄 Check All - Force check all items now

Each item can be:
• 🔍 Checked manually
• 🔄 Toggled on/off
• 🗑️ Removed

Bot checks items every ${cfg.checkIntervalSec || 300} seconds during Japan hours (5:00-23:00 JST).`;

        await bot.editMessageText(help, {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu
        });
    }

    // Toggle single item
    else if (data.startsWith('toggle_')) {
        const id = data.replace('toggle_', '');
        const item = user.items.find(i => i.id === id);
        if (item) {
            item.enabled = !item.enabled;
            persist();

            const text = `✦ ${item.name}

🆔 ID: ${item.id}
🔗 ${item.url}
📊 Status: ${item.enabled ? '✅ Enabled' : '❌ Disabled'}
📦 Last check: ${item.lastStatus === 'in' ? '✅ In Stock' : '❌ Out of Stock'}
🕐 Checked: ${item.lastChecked ? readableDate(item.lastChecked) : 'Never'}`;

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...getItemActionButtons(id)
            });
        }
    }

    // Confirm remove
    else if (data.startsWith('confirmremove_')) {
        const id = data.replace('confirmremove_', '');
        const item = user.items.find(i => i.id === id);
        if (item) {
            await bot.editMessageText(`⚠️ Remove "${item.name}"?\n\nThis cannot be undone.`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Yes, Remove', callback_data: `remove_${id}` },
                            { text: '❌ Cancel', callback_data: `item_${id}` }
                        ]
                    ]
                }
            });
        }
    }

    // Remove item
    else if (data.startsWith('remove_')) {
        const id = data.replace('remove_', '');
        const idx = user.items.findIndex(i => i.id === id);
        if (idx !== -1) {
            const [removed] = user.items.splice(idx, 1);
            persist();
            await bot.editMessageText(`🗑️ Removed: ${removed.name}`, {
                chat_id: chatId,
                message_id: messageId,
                ...mainMenu
            });
        }
    }

    // Check single item
    else if (data.startsWith('check_')) {
        const id = data.replace('check_', '');
        const item = user.items.find(i => i.id === id);
        if (item) {
            await bot.editMessageText(`🔍 Checking ${item.name}...`, {
                chat_id: chatId,
                message_id: messageId
            });

            try {
                const res = await checkMandarake(item.url, {
                    timeout: cfg.requestTimeoutMs,
                    userAgent: cfg.userAgent
                });

                item.lastStatus = res.isInStock ? 'in' : 'out';
                item.lastChecked = new Date().toISOString();
                persist();

                let text = `✦ ${res.itemName}

🆔 ID: ${item.id}
📦 In Stock: ${res.isInStock ? '✅ Yes' : '❌ No'}
🏪 Store: ${res.parentShopName}`;

                if (res.sameItemInOtherStores.length) {
                    const available = res.sameItemInOtherStores.filter(s => s.hasAdd && !s.soldOut);
                    if (available.length) {
                        text += `\n\n🏬 Other stores (${available.length} available):`;
                        available.slice(0, 5).forEach(s => {
                            text += `\n• ${s.shop}: ${s.price}${s.isDefective ? ' ⚠️' : ''}`;
                        });
                        if (available.length > 5) {
                            text += `\n...and ${available.length - 5} more`;
                        }
                    }
                }

                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    ...getItemActionButtons(id)
                });
            } catch (e) {
                logger.error('check error', e?.message);
                await bot.editMessageText(`❌ Error checking item:\n${e?.message}`, {
                    chat_id: chatId,
                    message_id: messageId,
                    ...getItemActionButtons(id)
                });
            }
        }
    }

    // Check all items
    else if (data === 'check_all') {
        if (!user.items.length) {
            await bot.editMessageText('📋 No items to check.', {
                chat_id: chatId,
                message_id: messageId,
                ...mainMenu
            });
            return;
        }

        await bot.editMessageText(`🔄 Checking ${user.items.length} items...`, {
            chat_id: chatId,
            message_id: messageId
        });

        let checked = 0;
        let inStock = 0;

        for (const item of user.items) {
            try {
                const res = await checkMandarake(item.url, {
                    timeout: cfg.requestTimeoutMs,
                    userAgent: cfg.userAgent
                });
                item.lastStatus = res.isInStock ? 'in' : 'out';
                item.lastChecked = new Date().toISOString();
                if (res.isInStock) inStock++;
                checked++;
            } catch (e) {
                logger.error('check_all error', item.url, e?.message);
            }
        }
        persist();

        await bot.editMessageText(`✅ Checked ${checked}/${user.items.length} items\n\n📦 In stock: ${inStock}\n❌ Out of stock: ${checked - inStock}`, {
            chat_id: chatId,
            message_id: messageId,
            ...mainMenu
        });
    }

    // No-op for pagination indicator
    else if (data === 'noop') {
        // Do nothing
    }
});

// --- Text Commands (keep for backwards compatibility) ---

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const payload = match[1].trim();
    const tokens = payload.split(/\s+/);
    const url = tokens[tokens.length - 1];
    const name = tokens.slice(0, tokens.length - 1).join(' ');
    if (!url || !/^https?:\/\//.test(url) || !name) {
        return bot.sendMessage(chatId, 'Usage: /add <name> <url>', mainMenu);
    }

    const user = ensureUser(db, chatId);
    const id = nextId();
    const item = { id, name, url, enabled: true, lastStatus: 'unknown', lastChecked: null };
    user.items.push(item);
    persist();
    bot.sendMessage(chatId, `✅ Added item:\n\n✦ ${name}\n🆔 ${id}\n🔗 ${url}`, mainMenu);
});

bot.onText(/\/remove (.+)/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const q = match[1].trim();
    const user = ensureUser(db, chatId);
    const idx = user.items.findIndex(i => i.id === q || i.name.toLowerCase() === q.toLowerCase());
    if (idx === -1) return bot.sendMessage(chatId, 'Item not found', mainMenu);
    const [removed] = user.items.splice(idx, 1);
    persist();
    bot.sendMessage(chatId, `🗑️ Removed: ${removed.name}`, mainMenu);
});

bot.onText(/\/list/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = ensureUser(db, chatId);
    if (!user.items.length) return bot.sendMessage(chatId, '📋 Your watch list is empty.', mainMenu);

    const text = `📋 Your items (${user.items.length} total):\n\nTap an item to manage it:`;
    bot.sendMessage(chatId, text, getItemButtons(user.items, 0));
});

bot.onText(/\/stop(?:\s+(.+))?/, (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg = match[1];
    const user = ensureUser(db, chatId);
    if (!arg) {
        user.enabled = false;
        user.items.forEach(i => i.enabled = false);
        persist();
        return bot.sendMessage(chatId, '⏹️ Alerts disabled for all items.', mainMenu);
    }
    const item = findItemByIdOrName(user, arg.trim());
    if (!item) return bot.sendMessage(chatId, 'Item not found', mainMenu);
    item.enabled = false;
    persist();
    bot.sendMessage(chatId, `⏹️ Disabled alerts for ${item.name}`, mainMenu);
});

bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg = match[1].trim();
    const user = ensureUser(db, chatId);

    let item = findItemByIdOrName(user, arg);
    let url = arg;
    if (item) url = item.url;
    if (!/^https?:\/\//.test(url)) return bot.sendMessage(chatId, 'Provide a valid URL or item id/name', mainMenu);

    bot.sendMessage(chatId, `🔍 Checking: ${item?.name || url}...`);
    try {
        const res = await checkMandarake(url, {
            timeout: cfg.requestTimeoutMs,
            userAgent: cfg.userAgent
        });

        if (item) {
            item.lastStatus = res.isInStock ? 'in' : 'out';
            item.lastChecked = new Date().toISOString();
            persist();
        }

        let msgOut = `✦ ${res.itemName}

📦 In Stock: ${res.isInStock ? '✅ Yes' : '❌ No'}
🏪 Store: ${res.parentShopName}`;

        if (res.sameItemInOtherStores.length) {
            const available = res.sameItemInOtherStores.filter(s => s.hasAdd && !s.soldOut);
            if (available.length) {
                msgOut += `\n\n🏬 Other stores:`;
                available.slice(0, 5).forEach(s => {
                    msgOut += `\n• ${s.shop}: ${s.price}${s.isDefective ? ' ⚠️' : ''}`;
                });
            }
        }

        bot.sendMessage(chatId, msgOut, mainMenu);
    } catch (e) {
        logger.error('check error', e?.message);
        bot.sendMessage(chatId, '❌ Error: ' + e?.message, mainMenu);
    }
});

// --- Polling ---

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
        const limit = pLimit(2);

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
                                let body = `🔥 Item now IN STOCK!

✦ ${res.itemName}
🔗 ${item.url}
`;
                                if (res.isInMainInStock) body += `🏪 Available in ${res.parentShopName}\n`;
                                if (res.sameItemInOtherStores?.length) {
                                    const availableShops = res.sameItemInOtherStores
                                        .filter(s => s.hasAdd && !s.soldOut)
                                        .map(s => `${s.shop} (${s.price || 'No price'})`);
                                    if (availableShops.length) {
                                        body += `\n🏬 Other stores:\n${availableShops.join(', ')}\n`;
                                    }
                                }
                                await bot.sendMessage(chatId, body, mainMenu);
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

            await Promise.allSettled(tasks);
        }
    } finally {
        running = false;
    }
}

// start periodic polling
const intervalMs = (cfg.checkIntervalSec || 300) * 1000;
logger.info(`Starting poll every ${intervalMs / 1000} sec`);
setInterval(pollAll, intervalMs);
void pollAll();

// graceful shutdown
process.on('SIGINT', () => {
    logger.info('Shutting down...');
    persist();
    process.exit(0);
});
