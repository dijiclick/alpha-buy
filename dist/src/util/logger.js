const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = 'info';
export function setLogLevel(level) {
    currentLevel = level;
}
function log(level, module, msg, data) {
    if (LEVELS[level] < LEVELS[currentLevel])
        return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
    if (data !== undefined) {
        console.log(`${prefix} ${msg}`, data);
    }
    else {
        console.log(`${prefix} ${msg}`);
    }
}
const seenOnce = new Set();
export function createLogger(module) {
    return {
        debug: (msg, data) => log('debug', module, msg, data),
        info: (msg, data) => log('info', module, msg, data),
        warn: (msg, data) => log('warn', module, msg, data),
        error: (msg, data) => log('error', module, msg, data),
        warnOnce: (key, msg, data) => {
            if (seenOnce.has(key))
                return;
            seenOnce.add(key);
            log('warn', module, msg, data);
        },
        clearOnce: (key) => { seenOnce.delete(key); },
    };
}
//# sourceMappingURL=logger.js.map