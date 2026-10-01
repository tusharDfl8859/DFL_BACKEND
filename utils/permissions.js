const ROLE_PERMISSIONS = {
    super_admin: ['*'], // Bypass key, gets all permissions dynamically
    admin: [
        'shipment:view',
        'shipment:book',
        'shipment:update_status',
        'shipment:update_tracking',
        'shipment:upload_stickers',
        'shipment:invoice',
        'customer:view',
        'customer:verify',
        'customer:assign',
        'customer:restrict',
        'customer:branch',
        'customer:tag',
        'customer:delete',
        'partner:view',
        'partner:manage',
        'partner:wallet',
        'team:view',
        'team:manage',
        'team:reassign',
        'reports:daily',
        'csb_report:generate',
        'commercial_invoice:bulk',
        'pickup_reports:manage',
        'rates:view',
        'rates:manage',
        'rates:refresh',
        'finance:view',
        'finance:otp',
        'wallet:view',
        'deductions:manage',
        'announcements:manage',
        'bulk_email:send',
        'bulk_whatsapp:send',
        'logs:view',
        'developer_hub:access',
        'integrations:manage',
        'box_packing:manage'
    ],
    member: [
        'shipment:view',
        'shipment:book',
        'customer:view',
        'customer:assign',
        'customer:restrict',
        'customer:branch',
        'rates:view'
    ],
    operation: [
        'shipment:view',
        'shipment:update_status',
        'shipment:update_tracking',
        'shipment:upload_stickers',
        'shipment:invoice',
        'rates:view',
        'manifest:manage',
        'pickup_reports:manage',
        'box_packing:manage'
    ],
    sales_manager: [
        'shipment:view',
        'customer:view',
        'customer:assign',
        'customer:restrict',
        'customer:branch',
        'partner:view',
        'team:view',
        'team:manage',
        'team:reassign',
        'reports:daily',
        'rates:view',
        'finance:view'
    ],
    customer_support: [
        'shipment:view',
        'shipment:book',
        'shipment:update_status',
        'shipment:update_tracking',
        'customer:view',
        'customer:verify',
        'shipping_bill:manage',
        'rates:view'
    ],
    franchise_manager: [
        'shipment:view',
        'shipment:book',
        'customer:view',
        'customer:assign',
        'customer:branch',
        'partner:view',
        'partner:manage',
        'partner:wallet',
        'team:view',
        'reports:daily',
        'rates:view',
        'finance:view'
    ]
};

/**
 * Calculates the final list of active permissions for an administrator member,
 * combining their role defaults and individual grants, and removing any revokes.
 * 
 * @param {Object} admin - Mongoose Admin document/object
 * @returns {string[]} List of computed permissions
 */
const getEffectivePermissions = (admin) => {
    if (!admin) return [];

    let defaultPerms = [];
    if (admin.role === 'super_admin') {
        const allPermissions = new Set();
        Object.values(ROLE_PERMISSIONS).forEach(perms => {
            perms.forEach(p => {
                if (p !== '*') allPermissions.add(p);
            });
        });
        allPermissions.add('data:export');
        allPermissions.add('finance:export');
        allPermissions.add('permissions:manage');
        allPermissions.add('reports:daily');
        allPermissions.add('csb_report:generate');
        allPermissions.add('commercial_invoice:bulk');
        allPermissions.add('shipping_bill:manage');
        allPermissions.add('careers:manage');
        defaultPerms = Array.from(allPermissions);
    } else {
        defaultPerms = ROLE_PERMISSIONS[admin.role] || [];
    }

    const overrides = admin.permissions || [];

    const grants = overrides.filter(p => p && !p.startsWith('-'));
    const revokes = overrides.filter(p => p && p.startsWith('-')).map(p => p.substring(1));

    // Combine default and positive overrides, then filter negative overrides
    const effective = Array.from(new Set([...defaultPerms, ...grants])).filter(
        p => !revokes.includes(p)
    );


    return effective;
};

module.exports = {
    ROLE_PERMISSIONS,
    getEffectivePermissions
};
