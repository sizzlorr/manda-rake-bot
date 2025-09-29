// logger.js
const { createLogger, format, transports } = require('winston');

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
    ),
    transports: [
        new transports.Console(),
        new transports.File({ filename: 'logs/bot.log', maxsize: 5_000_000, maxFiles: 3 })
    ]
});

module.exports = logger;
