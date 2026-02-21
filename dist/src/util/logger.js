import { mkdirSync, createWriteStream } from 'fs';
import { join } from 'path';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLevel = 'info';

// File logging — writes to logs/alpha-YYYY-MM-DD.log
const logDir = join(process.cwd(), 'logs');
try { mkdirSync(logDir, { recursive: true }); } catch {}

function getLogStream() {
    const date = new Date().toISOString().slice(0, 10);
    const key = `_stream_${date}`;
    if (getLogStream[key]) return getLogStream[key];
    const stream = createWriteStream(join(logDir, `alpha-${date}.log`), { flags: 'a' });
    getLogStream[key] = stream;
    return stream;
}

export function setLogLevel(level) {
    currentLevel = level;
}

function log(level, module, msg, data) {
    if (LEVELS[level] < LEVELS[currentLevel])
        return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${module}]`;
    const line = data !== undefined
        ? `${prefix} ${msg} ${typeof data === 'string' ? data : JSON.stringify(data)}`
        : `${prefix} ${msg}`;

    // Console
    console.log(line);

    // File
    try { getLogStream().write(line + '\n'); } catch {}
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
