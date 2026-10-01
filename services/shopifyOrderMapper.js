// Common helper: maps raw Shopify order JSON → ShopifyOrder schema
// Used by both syncOrders() and webhook handlers (DRY principle)

function mapShopifyOrder(shopDomain, order) {
    const customerName = order.customer
        ? `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim()
        : (order.shipping_address?.name || order.billing_address?.name || '');

    const paymentType = order.financial_status === 'pending' ? 'COD' : 'PREPAID';

    return {
        shopDomain,
        shopifyOrderId: String(order.id),
        orderNumber: order.name,

        customerName,
        customerEmail: order.email || '',
        customerPhone: order.phone || order.shipping_address?.phone || '',

        shippingAddress: {
            name: order.shipping_address?.name || '',
            phone: order.shipping_address?.phone || '',
            address1: order.shipping_address?.address1 || '',
            address2: order.shipping_address?.address2 || '',
            city: order.shipping_address?.city || '',
            state: order.shipping_address?.province || '',
            country: order.shipping_address?.country || '',
            zip: order.shipping_address?.zip || '',
        },

        products: (order.line_items || []).map(item => ({
            productId: item.product_id?.toString() || '',
            variantId: item.variant_id?.toString() || '',
            title: item.title,
            sku: item.sku,
            quantity: item.quantity,
            price: parseFloat(item.price) || 0,
            weight: item.grams || 0,
            weightUnit: item.grams ? 'g' : '',
        })),

        totalPrice: parseFloat(order.total_price) || 0,
        currency: order.currency || 'INR',

        financialStatus: order.financial_status || '',
        fulfillmentStatus: order.fulfillment_status || 'unfulfilled',

        paymentType,
        rawData: order,
        shopifyCreatedAt: order.created_at,
    };
}

module.exports = { mapShopifyOrder };
