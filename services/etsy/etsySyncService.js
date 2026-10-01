const axios = require('axios');
const MarketplaceAccount = require('../../models/MarketplaceAccount');
const EtsyOrder = require('../../models/EtsyOrder');
const MarketplaceLog = require('../../models/MarketplaceLog');
const { decryptToken, encryptToken } = require('../../utils/encryption');

class EtsySyncService {
    constructor() {
        this.baseUrl = process.env.ETSY_API_BASE_URL || 'https://api.etsy.com/v3';
        this.clientId = process.env.ETSY_CLIENT_ID;
        this.apiKey = `${process.env.ETSY_CLIENT_ID}:${process.env.ETSY_CLIENT_SECRET}`;
    }

    /**
     * Refreshes the Etsy OAuth token if it has expired or is about to expire
     */
    async refreshAccessTokenIfNeeded(account) {
        // If token expires in more than 5 minutes, it's still good
        if (account.tokenExpiry && new Date(account.tokenExpiry).getTime() > Date.now() + 5 * 60000) {
            return decryptToken(account.accessToken);
        }

        try {
            const refreshToken = decryptToken(account.refreshToken);
            const refreshParams = new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: this.clientId,
                refresh_token: refreshToken
            });

            const response = await axios.post(`${this.baseUrl}/public/oauth/token`, refreshParams.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;
            
            // Save new encrypted tokens
            account.accessToken = encryptToken(access_token);
            account.refreshToken = encryptToken(new_refresh_token);
            account.tokenExpiry = new Date(Date.now() + expires_in * 1000);
            await account.save();

            return access_token;
        } catch (error) {
            console.error(`[Etsy Sync] Failed to refresh token for shop ${account.shopId}:`, error.message);
            account.status = 'Error';
            await account.save();
            
            await MarketplaceLog.create({
                userId: account.userId,
                platform: 'Etsy',
                action: 'TokenRefresh',
                status: 'Error',
                message: `Failed to refresh token for shop ${account.shopName}. Re-authentication required.`,
                details: error.response?.data || error.message
            });
            throw new Error('Token refresh failed');
        }
    }

    /**
     * Fetch and sync orders for a specific Etsy shop
     */
    async syncOrdersForShop(accountId) {
        const account = await MarketplaceAccount.findById(accountId);
        if (!account || !account.isActive) return { success: false, message: 'Account not active' };

        try {
            const accessToken = await this.refreshAccessTokenIfNeeded(account);
            
            // Fetch unfulfilled receipts (orders) from Etsy
            // https://developers.etsy.com/documentation/reference/#operation/getShopReceipts
            const response = await axios.get(`${this.baseUrl}/application/shops/${account.shopId}/receipts`, {
                headers: {
                    'x-api-key': this.apiKey,
                    'Authorization': `Bearer ${accessToken}`
                },
                params: {
                    was_shipped: false,
                    limit: 50 // process in batches
                }
            });

            const receipts = response.data.results || [];
            let importedCount = 0;
            let duplicateCount = 0;
            let skippedCount = 0;

            for (const receipt of receipts) {
                console.log(`\n[Etsy Sync] --- Fetching Order ${receipt.receipt_id} ---`);
                console.log(`[Etsy Sync] Status: ${receipt.status}, Paid: ${receipt.is_paid}, Shipped: ${receipt.is_shipped}`);
                
                // 1. Skip if order is cancelled
                if (receipt.status === 'canceled' || receipt.status === 'Canceled') {
                    console.log(`[Etsy Sync] Order ${receipt.receipt_id} skipped because order is cancelled.`);
                    skippedCount++;
                    continue;
                }

                // 2. Skip if payment is not completed
                if (!receipt.is_paid || receipt.status === 'payment processing' || receipt.status === 'open') {
                    // Note: 'open' usually means unpaid in v3, but we rely on is_paid.
                    console.log(`[Etsy Sync] Order ${receipt.receipt_id} skipped because payment is not completed.`);
                    skippedCount++;
                    continue;
                }

                // Idempotency check: Does this order already exist in our DB?
                const existingOrder = await EtsyOrder.findOne({ etsyOrderId: receipt.receipt_id.toString() });
                
                if (existingOrder) {
                    // FIX: If the store was disconnected from Admin and connected to User, the order still belongs to Admin.
                    // We must update the ownership to the current active user so it shows up in their panel.
                    if (existingOrder.userId.toString() !== account.userId.toString()) {
                        existingOrder.userId = account.userId;
                        existingOrder.marketplaceAccountId = account._id;
                        await existingOrder.save();
                        console.log(`[Etsy Sync] Order ${receipt.receipt_id} ownership updated to new user.`);
                    }

                    duplicateCount++;
                    continue; // Skip already imported orders
                }

                console.log(`[Etsy Sync] Order ${receipt.receipt_id} is valid and paid. Importing...`);

                // Map Etsy Data to DFL Express schema
                const orderData = {
                    userId: account.userId,
                    marketplaceAccountId: account._id,
                    etsyOrderId: receipt.receipt_id.toString(),
                    receiptId: receipt.receipt_id.toString(),
                    orderDate: new Date(receipt.created_timestamp * 1000),
                    buyerName: receipt.name,
                    buyerEmail: receipt.buyer_email,
                    
                    shippingAddress: {
                        name: receipt.name,
                        firstLine: receipt.first_line,
                        secondLine: receipt.second_line,
                        city: receipt.city,
                        state: receipt.state,
                        zip: receipt.zip,
                        countryIso: receipt.country_iso
                    },
                    
                    items: receipt.transactions?.map(tx => ({
                        title: tx.title,
                        sku: tx.sku || '',
                        quantity: tx.quantity,
                        price: tx.price.amount / tx.price.divisor,
                        currency: tx.price.currency_code
                    })) || [],
                    
                    totalValue: receipt.grandtotal.amount / receipt.grandtotal.divisor,
                    currency: receipt.grandtotal.currency_code,
                    shippingAmount: receipt.total_shipping_cost.amount / receipt.total_shipping_cost.divisor,
                    
                    paymentStatus: 'Paid',
                    fulfillmentStatus: 'New',
                    syncStatus: 'Pending'
                };

                await EtsyOrder.create(orderData);
                console.log(`[Etsy Sync] Order ${receipt.receipt_id} imported successfully.`);
                importedCount++;
            }

            // Update sync timestamp
            account.lastSync = new Date();
            account.status = 'Connected';
            await account.save();

            await MarketplaceLog.create({
                userId: account.userId,
                platform: 'Etsy',
                action: 'OrderImport',
                status: 'Success',
                message: `Synced orders for ${account.shopName}. Imported: ${importedCount}, Skipped: ${skippedCount}, Duplicates: ${duplicateCount}`
            });

            return { success: true, imported: importedCount, duplicates: duplicateCount, skipped: skippedCount };

        } catch (error) {
            console.error(`[Etsy Sync] Order sync failed for shop ${account.shopId}:`, error.message);
            
            await MarketplaceLog.create({
                userId: account.userId,
                platform: 'Etsy',
                action: 'OrderImport',
                status: 'Error',
                message: `Order sync failed for ${account.shopName}`,
                details: error.response?.data || error.message
            });

            return { success: false, message: 'Sync failed' };
        }
    }

    /**
     * Push tracking information to Etsy and mark order as dispatched
     */
    async pushTrackingToEtsy(etsyOrderId, trackingCode, carrierName) {
        try {
            const order = await EtsyOrder.findById(etsyOrderId);
            if (!order) throw new Error('Etsy order not found');

            const account = await MarketplaceAccount.findById(order.marketplaceAccountId);
            if (!account || !account.isActive) throw new Error('Marketplace account inactive');

            const accessToken = await this.refreshAccessTokenIfNeeded(account);

            // Etsy API endpoint to add tracking and complete the order
            const url = `${this.baseUrl}/application/shops/${account.shopId}/receipts/${order.receiptId}/tracking`;
            
            const payload = {
                tracking_code: trackingCode,
                carrier_name: carrierName || 'Other',
                send_bcc: false
            };

            await axios.post(url, payload, {
                headers: {
                    'x-api-key': this.apiKey,
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            // Update local database
            order.fulfillmentStatus = 'Dispatched';
            order.syncStatus = 'Synced';
            order.awbNumber = trackingCode;
            await order.save();

            await MarketplaceLog.create({
                userId: account.userId,
                platform: 'Etsy',
                action: 'TrackingSync',
                status: 'Success',
                message: `Successfully pushed tracking ${trackingCode} for receipt ${order.receiptId}`
            });

            return { success: true };

        } catch (error) {
            console.error(`[Etsy Sync] Failed to push tracking to Etsy:`, error.message);
            
            // Log failure
            const order = await EtsyOrder.findById(etsyOrderId);
            if (order) {
                await MarketplaceLog.create({
                    userId: order.userId,
                    platform: 'Etsy',
                    action: 'TrackingSync',
                    status: 'Error',
                    message: `Failed to push tracking for receipt ${order.receiptId}`,
                    details: error.response?.data || error.message
                });
            }

            return { success: false, message: error.message };
        }
    }
}

module.exports = new EtsySyncService();
