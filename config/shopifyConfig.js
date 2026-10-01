// Shopify Configuration
// All values come from .env — never hardcode credentials here

const appUrl = process.env.SHOPIFY_APP_URL || process.env.APP_URL || process.env.BACKEND_URL || 'http://localhost:5001';
const redirectUri = process.env.SHOPIFY_REDIRECT_URI || `${appUrl}/api/shopify/callback`;

const config = {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    apiSecretOld: process.env.SHOPIFY_API_SECRET_OLD,
    scopes: process.env.SHOPIFY_SCOPES || 'read_orders,write_orders,read_fulfillments,write_fulfillments,read_products,write_products,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_third_party_fulfillment_orders,write_third_party_fulfillment_orders,read_assigned_fulfillment_orders,write_assigned_fulfillment_orders',
    redirectUri: redirectUri,
    appUrl: appUrl,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
};

module.exports = config;
