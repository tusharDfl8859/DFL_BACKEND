const Redis = require('ioredis');
const EventEmitter = require('events');

const redisConfig = {
    port: parseInt(process.env.REDIS_PORT) || 6379,
    host: process.env.REDIS_HOST || '127.0.0.1',
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required for BullMQ
};

// Simple Mock Redis for local development when Redis is not available
class RedisMock extends EventEmitter {
    constructor(sharedData) {
        super();
        this.data = sharedData || new Map();
        this.status = 'ready';
        console.log('Using Redis Mock (In-Memory)');

        // Simulate connection events
        setTimeout(() => {
            this.emit('ready');
            this.emit('connect');
        }, 10);
    }

    duplicate() {
        // Return a new instance sharing the same data store
        return new RedisMock(this.data);
    }

    async get(key) { return this.data.get(key) || null; }

    async set(key, value, mode, duration) {
        this.data.set(key, value);
        if (mode === 'EX' && duration) {
            setTimeout(() => this.data.delete(key), duration * 1000);
        }
        return 'OK';
    }

    async del(key) { return this.data.delete(key); }

    async quit() {
        this.emit('end');
        return 'OK';
    }

    async disconnect() {
        this.emit('end');
        return 'OK';
    }

    // Add other methods as needed by BullMQ
    async client() { return 'OK'; }
    async info() { return 'redis_version:99.9.9'; }
    async ping() { return 'PONG'; }

    on(event, callback) { super.on(event, callback); return this; }
    once(event, callback) { super.once(event, callback); return this; }
}

let redisConnection;

const getRedisConnection = () => {
    if (!redisConnection) {
        // Explicitly bypass if requested
        if (process.env.BYPASS_REDIS === 'true') {
            console.log('BYPASS_REDIS is true. Using Mock (In-Memory).');
            redisConnection = new RedisMock();
        } else {
            console.log('Attempting to connect to Redis...');
            // In development/test, fallback to mock if real fails is handled by user logic,
            // but pure "Bypass" mode is safer for local without redis.
            redisConnection = new Redis(redisConfig);

            redisConnection.on('error', (err) => {
                console.error('Redis Connection Error:', err.message);
            });
        }
    }
    return redisConnection;
};

const closeRedisConnection = async () => {
    if (!redisConnection) return;
    const client = redisConnection;
    redisConnection = null;
    if (typeof client.quit === 'function') {
        await client.quit().catch(() => {
            if (typeof client.disconnect === 'function') {
                client.disconnect();
            }
        });
        return;
    }
    if (typeof client.disconnect === 'function') {
        await client.disconnect();
    }
};

const checkHealth = async () => {
    try {
        const client = getRedisConnection();
        if (!client) {
            return { ok: false, message: 'Redis client connection failed' };
        }
        const res = await client.ping();
        if (res === 'PONG') {
            return { ok: true, message: 'Connected' };
        }
        return { ok: false, message: `Unexpected response: ${res}` };
    } catch (err) {
        return { ok: false, message: err.message };
    }
};

module.exports = {
    redisConfig,
    getRedisConnection,
    closeRedisConnection,
    checkHealth
};
