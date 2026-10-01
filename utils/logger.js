const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

const logger = {
    info: (...args) => {
        if (!isProduction && !isTest) {
            console.log(`[INFO] [${new Date().toISOString()}]`, ...args);
        }
    },
    warn: (...args) => {
        if (!isTest) {
            console.warn(`[WARN] [${new Date().toISOString()}]`, ...args);
        }
    },
    error: (...args) => {
        if (!isTest) {
            console.error(`[ERROR] [${new Date().toISOString()}]`, ...args);
        }
    }
};

module.exports = logger;
