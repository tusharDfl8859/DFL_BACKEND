/**
 * Envia Configuration
 * Centralized settings for Envia 3rd-Party Logistics integration.
 */

const enviaConfig = {
    token: process.env.ENVIA_API_TOKEN || '09512229f91fb3946f765336fac172305a6189638f0708d9a4aed9d3ae3fc131',
    apiUrl: process.env.ENVIA_API_URL || 'https://api.envia.com',
    queriesUrl: process.env.ENVIA_QUERIES_URL || 'https://queries.envia.com',
    company: {
        id: process.env.ENVIA_COMPANY_ID || '663303',
        name: process.env.ENVIA_COMPANY_NAME || 'Demira Freight Linkers India Pvt Ltd',
        email: process.env.ENVIA_EMAIL || 'courier@thedflgroup.com',
        phone: process.env.ENVIA_PHONE || '9355014363',
        country: process.env.ENVIA_COUNTRY_CODE || 'IN'
    },
    dflHub: {
        name: 'DFL Group Hub',
        company: 'Demira Freight Linkers India Pvt Ltd',
        email: 'courier@thedflgroup.com',
        phone: '9355014363',
        street: 'Logix Technova, Block B, Sector 132',
        number: 'A 111',
        city: 'Noida',
        state: 'UP',
        country: 'IN',
        postalCode: '201301'
    },
    defaultCarrier: 'delhivery',
    businessTimezone: process.env.BUSINESS_TIMEZONE || 'Asia/Kolkata',
    rateTtlMinutes: parseInt(process.env.ENVIA_RATE_TTL_MINUTES, 10) || 15,
    timeout: 30000,
    retries: 2
};

module.exports = enviaConfig;
