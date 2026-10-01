const crypto = require('crypto');
const DeveloperConfig = require('../../models/DeveloperConfig');
const CarrierConcurrencyLease = require('../../models/CarrierConcurrencyLease');

const normalizeCarrier = (carrier) => String(carrier || 'UNKNOWN').trim().toUpperCase();

const getConfiguredLimit = async (carrier) => {
    const config = await DeveloperConfig.getSingleton();
    const normalized = normalizeCarrier(carrier);
    const map = config.liveCarrierConcurrencyByCarrier;
    const fromConfig = typeof map?.get === 'function' ? map.get(normalized) : map?.[normalized];
    const fallback = Math.max(1, Number(config.liveCarrierWorkerConcurrency || 1));
    const limit = Number(fromConfig || fallback);
    return Math.max(1, Math.floor(limit));
};

const ensureCarrierRecord = async ({ carrier, limit }) => {
    try {
        await CarrierConcurrencyLease.findOneAndUpdate(
            { carrier },
            {
                $setOnInsert: {
                    carrier,
                    activeCount: 0,
                    leases: [],
                    leaseExpiresAt: new Date(0)
                },
                $set: { limit }
            },
            { upsert: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        if (!error || error.code !== 11000) throw error;
    }
};

const cleanupExpiredLeases = async (carrier, now = new Date()) => {
    await CarrierConcurrencyLease.collection.updateOne(
        { carrier },
        [
            {
                $set: {
                    leases: {
                        $filter: {
                            input: '$leases',
                            as: 'lease',
                            cond: { $gt: ['$$lease.expiresAt', now] }
                        }
                    }
                }
            },
            {
                $set: {
                    activeCount: { $size: '$leases' },
                    leaseExpiresAt: {
                        $ifNull: [
                            { $max: '$leases.expiresAt' },
                            now
                        ]
                    }
                }
            }
        ]
    );
};

const acquireCarrierPermit = async (carrier, options = {}) => {
    const normalized = normalizeCarrier(carrier);
    const limit = Math.max(1, Math.floor(Number(options.limit || await getConfiguredLimit(normalized))));
    const leaseMs = Math.max(1000, Number(options.leaseMs || process.env.LIVE_CARRIER_LEASE_MS || 120000));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const token = crypto.randomUUID();

    await ensureCarrierRecord({ carrier: normalized, limit });
    await cleanupExpiredLeases(normalized, now);

    const lease = await CarrierConcurrencyLease.findOneAndUpdate(
        {
            carrier: normalized,
            activeCount: { $lt: limit }
        },
        {
            $push: {
                leases: {
                    token,
                    expiresAt,
                    acquiredAt: now
                }
            },
            $inc: { activeCount: 1 },
            $set: { limit, leaseExpiresAt: expiresAt }
        },
        { new: true }
    );

    if (!lease) {
        return {
            acquired: false,
            carrier: normalized,
            limit,
            leaseMs,
            token: null
        };
    }

    return {
        acquired: true,
        carrier: normalized,
        limit,
        leaseMs,
        token,
        expiresAt
    };
};

const releaseCarrierPermit = async (permit) => {
    if (!permit?.acquired || !permit.carrier || !permit.token) return;
    await CarrierConcurrencyLease.findOneAndUpdate(
        {
            carrier: permit.carrier,
            'leases.token': permit.token
        },
        {
            $pull: { leases: { token: permit.token } },
            $inc: { activeCount: -1 }
        }
    );
    await cleanupExpiredLeases(permit.carrier);
};

const renewCarrierPermit = async (permit, options = {}) => {
    if (!permit?.acquired || !permit.carrier || !permit.token) return null;
    const leaseMs = Math.max(1000, Number(options.leaseMs || permit.leaseMs || process.env.LIVE_CARRIER_LEASE_MS || 120000));
    const expiresAt = new Date(Date.now() + leaseMs);
    const renewed = await CarrierConcurrencyLease.findOneAndUpdate(
        {
            carrier: permit.carrier,
            'leases.token': permit.token
        },
        {
            $set: {
                'leases.$.expiresAt': expiresAt,
                leaseExpiresAt: expiresAt
            }
        },
        { new: true }
    );
    return renewed ? { ...permit, leaseMs, expiresAt } : null;
};

const startCarrierPermitRenewal = (permit, options = {}) => {
    if (!permit?.acquired) return () => {};
    const leaseMs = Math.max(1000, Number(options.leaseMs || permit.leaseMs || process.env.LIVE_CARRIER_LEASE_MS || 120000));
    const intervalMs = Math.max(500, Math.floor(leaseMs / 2));
    const interval = setInterval(() => {
        renewCarrierPermit(permit, { leaseMs }).catch((error) => {
            console.error('Carrier concurrency lease renewal failed:', error.message);
        });
    }, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
    return () => clearInterval(interval);
};

module.exports = {
    acquireCarrierPermit,
    cleanupExpiredLeases,
    getConfiguredLimit,
    normalizeCarrier,
    releaseCarrierPermit,
    renewCarrierPermit,
    startCarrierPermitRenewal
};
