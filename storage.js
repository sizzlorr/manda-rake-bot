// storage.js
const fs = require('fs');
const path = require('path');
const DB = path.resolve(__dirname, 'data.json');
const logger = require('./logger');

function load() {
    try {
        if (!fs.existsSync(DB)) return { users: {}, settings: {} };
        return JSON.parse(fs.readFileSync(DB, 'utf8'));
    } catch (e) {
        logger.error('Failed to load DB:', e);
        return { users: {}, settings: {} };
    }
}

function save(db) {
    const tmp = DB + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB);
}

function ensureUser(db, chatId) {
    if (!db.users[chatId]) {
        db.users[chatId] = { enabled: true, items: [] };
    }
    return db.users[chatId];
}

function nextId() {
    return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1000);
}

module.exports = {
    load,
    save,
    ensureUser,
    nextId
};
