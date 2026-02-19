declare const LEVELS: {
    readonly debug: 0;
    readonly info: 1;
    readonly warn: 2;
    readonly error: 3;
};
type LogLevel = keyof typeof LEVELS;
export declare function setLogLevel(level: LogLevel): void;
export declare function createLogger(module: string): {
    debug: (msg: string, data?: any) => void;
    info: (msg: string, data?: any) => void;
    warn: (msg: string, data?: any) => void;
    error: (msg: string, data?: any) => void;
    warnOnce: (key: string, msg: string, data?: any) => void;
    clearOnce: (key: string) => void;
};
export {};
