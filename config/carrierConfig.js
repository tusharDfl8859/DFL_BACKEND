/**
 * Carrier Configuration
 * 
 * Centralized configuration for all carrier API integrations.
 * Credentials are loaded from environment variables.
 */

module.exports = {
    SKYNET: {
        name: 'Skynet',
        bookingUrl: 'https://skylink.skynetww.com/docket_api/create_docket',
        trackingUrl: 'https://api.skynetww.com/api/Client/ShipmentTracking',
        manifestUrl: 'https://api.skynetww.com/api/Client/CustomerManifest',
        credentials: {
            email: process.env.SKYNET_EMAIL,
            token: process.env.SKYNET_TOKEN,
            clientCode: process.env.SKYNET_CLIENT_CODE,
            userId: process.env.SKYNET_USER_ID,
            password: process.env.SKYNET_PASSWORD
        },
        timeout: 60000,
        retries: 2
    },

    RSA: {
        name: 'RSAXB',
        bookingUrl: process.env.RSAXB_BASE_URL ? `${process.env.RSAXB_BASE_URL}/shipment/v1/create` : '', // Placeholder endpoint
        trackingUrl: process.env.RSAXB_BASE_URL ? `${process.env.RSAXB_BASE_URL}/lastmiledelivery/api/client/tracking-details` : '',
        credentials: {
            clientKey: process.env.RSAXB_CLIENT_KEY,
            subscriptionKey: process.env.RSAXB_SUBSCRIPTION_AUTH_VALUE
        },
        timeout: 30000,
        retries: 2
    },

    TPL: {
        name: 'TPL',
        countryUrl: 'https://transitpl.com/api/location/country',
        zipcodeUrl: 'https://transitpl.com/api/location/zipcode',
        rateUrl: 'https://transitpl.com/api/rates/check',
        bookingUrl: process.env.TPL_LABEL_URL || 'https://transitpl.com/api/labels/create',
        trackingUrl: process.env.TPL_TRACKING_URL || 'https://transitpl.com/api/track',
        labelUrl: process.env.TPL_LABEL_URL || 'https://transitpl.com/api/labels/create',
        credentials: {
            apiKey: process.env.TPL_API_KEY,
            username: process.env.TPL_USERNAME,
            password: process.env.TPL_PASSWORD
        },
        timeout: 30000,
        retries: 2
    },

    UNITED: {
        name: 'United Courier',
        bookingUrl: 'http://198.38.81.111:9002/api/Shipping/AddShipment',
        trackingUrl: 'http://198.38.81.111:9002/api/Track/GetTrackings',
        manifestUrl: 'http://198.38.81.111:9002/api/Manifest/CreateManifest',
        credentials: {
            accountCode: process.env.UNITED_COURIER_ACCOUNT_CODE,
            username: process.env.UNITED_COURIER_USERNAME,
            password: process.env.UNITED_COURIER_PASSWORD,
            accessKey: process.env.UNITED_COURIER_ACCESS_KEY
        },
        timeout: 30000,
        retries: 2
    },
    'SKYNET-ECOMMERCE': {
        name: 'SkynetEcommerce',
        bookingUrl: 'https://api.skynetww.com/api/Client/CreateShipment',
        trackingUrl: 'https://api.skynetww.com/api/Client/ShipmentTracking',
        manifestUrl: 'https://api.skynetww.com/api/Client/CustomerManifest',
        credentials: {
            token: process.env.SKYNET_ECOMMERCE_TOKEN,
            clientCode: process.env.SKYNET_ECOMMERCE_CLIENT_CODE,
            userId: process.env.SKYNET_ECOMMERCE_USER_ID,
            password: process.env.SKYNET_ECOMMERCE_PASSWORD
        },
        timeout: 60000,
        retries: 2
    },
    SPEEDBOX: {
        name: 'Speedbox',
        rateUrl: process.env.SPEEDBOX_API_URL,
        credentials: {
            token: process.env.SPEEDBOX_API_KEY
        },
        timeout: 30000,
        retries: 1
    },
    ENVIA: {
        name: 'Envia',
        apiUrl: process.env.ENVIA_API_URL || 'https://api.envia.com',
        queriesUrl: process.env.ENVIA_QUERIES_URL || 'https://queries.envia.com',
        credentials: {
            token: process.env.ENVIA_API_TOKEN || '09512229f91fb3946f765336fac172305a6189638f0708d9a4aed9d3ae3fc131',
            companyId: process.env.ENVIA_COMPANY_ID || '663303',
            companyName: process.env.ENVIA_COMPANY_NAME || 'Demira Freight Linkers India Pvt Ltd',
            email: process.env.ENVIA_EMAIL || 'courier@thedflgroup.com',
            phone: process.env.ENVIA_PHONE || '9355014363',
            country: process.env.ENVIA_COUNTRY_CODE || 'IN'
        },
        timeout: 30000,
        retries: 2
    }
};
