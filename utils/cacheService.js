/**
 * Simple In-Memory Cache Service
 * Zero-dependency implementation to avoid AWS/Infrastructure costs.
 */

class SimpleCache {
    constructor() {
        this.cache = new Map();
    }

    /**
     * Get a value from the cache
     * @param {string} key 
     * @returns {any | null}
     */
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    /**
     * Set a value in the cache
     * @param {string} key 
     * @param {any} value 
     * @param {number} ttlSeconds (Time To Live in seconds)
     */
    set(key, value, ttlSeconds = 300) {
        const expiry = Date.now() + (ttlSeconds * 1000);
        this.cache.set(key, {
            value,
            expiry
        });

        // Simple cleanup: If cache gets too big, clear it to prevent memory leaks
        // (basic protection since this is in-memory)
        if (this.cache.size > 1000) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
    }

    /**
     * Clear specific key
     * @param {string} key 
     */
    del(key) {
        this.cache.delete(key);
    }

    /**
     * Clear keys matching a pattern (string or regex)
     * @param {string|RegExp} pattern 
     */
    delPattern(pattern) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        for (const key of this.cache.keys()) {
            if (regex.test(key)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Clear entire cache
     */
    flush() {
        this.cache.clear();
    }
}

// Export as Singleton
module.exports = new SimpleCache();
