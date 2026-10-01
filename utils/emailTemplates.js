const generateOrderConfirmationEmail = (shipment) => {
    const { shipperDetails, consigneeDetails, shipmentDetails, serviceDetails, shipmentId, createdAt } = shipment;
    const date = new Date(createdAt).toLocaleDateString('en-GB'); // DD/MM/YYYY

    // Parse price to ensure it's a number
    const priceString = serviceDetails.price || '0';
    const basePrice = parseFloat(priceString.replace(/[^0-9.]/g, ''));

    // Calculate taxes (assuming 18% IGST is included or added - let's assume added for this template based on image)
    // Actually, typically the price in serviceDetails is the final price. 
    // Let's reverse calculate for the template breakdown if needed, or just show it as is.
    // The image shows: Rate, IGST, Amount. 
    // Let's assume the 'price' from serviceDetails is the Total Amount.
    // So Base = Total / 1.18
    // IGST = Base * 0.18

    const totalAmount = basePrice;
    const baseAmount = totalAmount / 1.18;
    const igstAmount = totalAmount - baseAmount;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Order Confirmation</title>
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; margin: 0; padding: 0; }
        .container { width: 100%; max-width: 800px; margin: 0 auto; padding: 20px; }
        
        /* Table resets */
        table { border-collapse: collapse; border-spacing: 0; }
        td { vertical-align: top; }
        
        .header-table { width: 100%; margin-bottom: 40px; }
        .logo { width: 120px; max-width: 120px; height: auto; }
        .invoice-title h1 { margin: 0; font-size: 32px; font-weight: bold; }
        .invoice-title p { margin: 5px 0 0; font-size: 14px; font-weight: bold; }
        
        .addresses-table { width: 100%; margin-bottom: 30px; }
        .address-block h3 { margin: 0 0 10px; font-size: 14px; font-weight: bold; }
        .address-text { font-size: 12px; line-height: 1.4; }
        
        .items-table { width: 100%; margin-bottom: 20px; font-size: 12px; border: 1px solid #eee; }
        .items-table th { background-color: #333; color: #fff; padding: 10px; text-align: left; }
        .items-table td { padding: 10px; border-bottom: 1px solid #eee; }
        .text-right { text-align: right; }
        
        .totals-table { width: 300px; font-size: 14px; margin-left: auto; }
        .totals-table td { padding: 5px 0; }
        .totals-row.total td { font-weight: bold; background-color: #f5f5f5; padding: 10px 5px; }
        
        .footer { margin-top: 50px; font-size: 10px; color: #666; border-top: 1px solid #ccc; padding-top: 10px; }
        .signature { margin-top: 40px; border-top: 1px solid #333; width: 200px; padding-top: 5px; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <table class="header-table">
            <tr>
                <td style="width: 50%;">
                    <div class="logo-section">
                        <img src="cid:dfl_logo" alt="The DFL Group" class="logo">
                    </div>
                </td>
                <td style="width: 50%; text-align: right;">
                    <div class="invoice-title">
                        <h1>Sales Order</h1>
                        <p>Sales Order# ${shipmentId}</p>
                    </div>
                </td>
            </tr>
        </table>

        <div class="address-text" style="margin-bottom: 30px;">
            <strong>M/S DELISHA INTERNATIONAL</strong><br>
            A 133-134 LOGIX TECHNOVA SEC 132 NOIDA<br>
            NOIDA Uttar Pradesh 201034<br>
            India<br>
            GSTIN 09AGFPT3528D1ZC<br>
            91-9999309839<br>
            dk@thedflgroup.com
        </div>

        <!-- Billing/Shipping Addresses -->
        <table class="addresses-table">
            <tr>
                <td class="address-block" style="width: 50%; padding-right: 20px;">
                    <h3>Bill To</h3>
                    <div class="address-text">
                        <strong>${shipperDetails.shipperName.toUpperCase()}</strong><br>
                        ${shipperDetails.companyName ? shipperDetails.companyName + '<br>' : ''}
                        ${shipperDetails.addressLine1}${shipperDetails.addressLine2 ? ', ' + shipperDetails.addressLine2 : ''}, ${shipperDetails.city}<br>
                        ${shipperDetails.state ? shipperDetails.state + ', ' : ''}${shipperDetails.pincode}<br>
                        GSTIN ${shipmentDetails?.gstinId || shipperDetails?.gstNo || shipment?.user?.kycData?.gstNumber || ''}
                    </div>
                </td>
                <td class="address-block" style="width: 50%;">
                    <h3>Ship To</h3>
                    <div class="address-text">
                        <strong>${consigneeDetails.consigneeName.toUpperCase()}</strong><br>
                        ${consigneeDetails.companyName ? consigneeDetails.companyName + '<br>' : ''}
                        ${consigneeDetails.addressLine1}${consigneeDetails.addressLine2 ? ', ' + consigneeDetails.addressLine2 : ''}<br>
                        ${consigneeDetails.city}, ${consigneeDetails.country}<br>
                        ${consigneeDetails.mobileNo}
                    </div>
                </td>
            </tr>
        </table>

        <div style="text-align: right; margin-bottom: 20px; font-size: 14px;">
            <span>Order Date : ${date}</span>
        </div>

        <!-- Items Table -->
        <table class="items-table">
            <thead>
                <tr>
                    <th style="width: 5%">#</th>
                    <th style="width: 40%">Item & Description</th>
                    <th style="width: 15%">HSN/SAC</th>
                    <th style="width: 10%">Qty</th>
                    <th style="width: 10%" class="text-right">Rate</th>
                    <th style="width: 10%" class="text-right">IGST</th>
                    <th style="width: 10%" class="text-right">Amount</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>1</td>
                    <td>
                        <strong>Courier Charges</strong><br>
                        <span style="color: #666; font-size: 11px;">AWB No. - ${shipmentId}</span>
                        <br>
                        <span style="color: #666; font-size: 11px;">Service: ${serviceDetails.serviceName}</span>
                        <br>
                        <span style="color: #666; font-size: 11px;">Contains: ${shipmentDetails.boxes.length} Box(es)</span>
                    </td>
                    <td>996812</td>
                    <td>${serviceDetails.chargeableWeight || '1.00'}<br>kg</td>
                    <td class="text-right">${baseAmount.toFixed(2)}</td>
                    <td class="text-right">${igstAmount.toFixed(2)}<br><span style="font-size: 10px;">18%</span></td>
                    <td class="text-right">${baseAmount.toFixed(2)}</td>
                </tr>
            </tbody>
        </table>

        <!-- Totals -->
        <table class="totals-table">
            <tr>
                <td>Sub Total</td>
                <td class="text-right">${baseAmount.toFixed(2)}</td>
            </tr>
            <tr>
                <td>IGST18 (18%)</td>
                <td class="text-right">${igstAmount.toFixed(2)}</td>
            </tr>
            <tr class="totals-row total">
                <td>Total</td>
                <td class="text-right">${totalAmount.toFixed(2)}</td>
            </tr>
        </table>

        <div style="clear: both; padding-top: 40px;">
            <div class="signature">
                Authorized Signature
            </div>
            <p style="font-size: 10px; color: #666; margin-top: 5px;">This sales order is electronically generated and does not require a signature</p>
        </div>

        <div class="footer">
            AXIS BANK LTD.<br>
            SECTOR 132 NOIDA UP NOIDA 201301<br>
            M/S DELISHA INTERNATIONAL<br>
            ACCOUNT NO: 923020024708210 IFSC CODE: UTIB0003734
        </div>
    </div>
</body>
</html>
    `;
};

const generateWelcomeEmail = (name) => {
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Welcome to DFL Group</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #4a4a4a; line-height: 1.6; margin: 0; padding: 0; background-color: #f0f2f5; }
        .container { width: 100%; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #0B4F6C 0%, #063d54 100%); padding: 50px 0; text-align: center; color: white; }
        .logo-text { font-size: 28px; font-weight: bold; letter-spacing: 1px; margin: 0; }
        .content { padding: 40px; text-align: center; }
        .welcome-icon { font-size: 48px; margin-bottom: 20px; display: block; }
        .title { color: #0B4F6C; font-size: 26px; margin-bottom: 15px; font-weight: 700; }
        .text { font-size: 16px; color: #555; margin-bottom: 25px; line-height: 1.8; }
        .highlight-box { background-color: #f8fafc; border-left: 4px solid #0B4F6C; padding: 15px; margin: 25px 0; text-align: left; border-radius: 4px; }
        .highlight-title { font-weight: bold; color: #0B4F6C; display: block; margin-bottom: 5px; }
        .btn { display: inline-block; background: linear-gradient(to right, #f97316, #ea580c); color: #ffffff; padding: 16px 36px; text-decoration: none; border-radius: 50px; font-weight: bold; font-size: 16px; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(249, 115, 22, 0.4); }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(249, 115, 22, 0.5); }
        .features { display: flex; justify-content: space-around; margin: 30px 0; text-align: center; }
        .feature-item { font-size: 12px; color: #777; width: 30%; }
        .feature-icon { font-size: 24px; margin-bottom: 10px; color: #0B4F6C; display: block; }
        .footer { background-color: #2d3748; color: #a0aec0; text-align: center; padding: 30px 20px; font-size: 13px; }
        .help-text { margin-top: 20px; font-size: 14px; color: #666; }
        .links a { color: #f97316; text-decoration: none; margin: 0 8px; transition: color 0.2s; }
        .links a:hover { color: #ea580c; text-decoration: underline; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <!-- Using text heavily styled if logo cid not guaranteed, or assuming cid:dfl_logo works as per other template -->
            <h1 class="logo-text">DFL GROUP</h1>
            <p style="margin: 5px 0 0; opacity: 0.8; font-size: 14px;">Global Logistics Simplified</p>
        </div>
        
        <div class="content">
            <span class="welcome-icon">👋</span>
            <h1 class="title">Welcome to the Family, ${name}!</h1>
            
            <p class="text">
                Thank you for choosing Demira Freight Linkers. We are absolutely thrilled to have you on board.
                You’ve just taken a major step towards faster, safer, and smarter logistics solutions.
            </p>

            <div class="highlight-box">
                <span class="highlight-title">✨ What to expect:</span>
                We are committed to providing you with premium service, real-time transparency, and a support team that truly cares about your business success.
            </div>

            <p class="text">
                Your dashboard is ready and waiting. You can now get instant quotes, book global shipments, and track everything in one place.
            </p>
            
            <a href="${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/dashboard" class="btn">Go toDashboard </a>

            <div class="features">
                <div class="feature-item">
                    <span class="feature-icon">⚡</span>
                    <strong>Fast</strong><br>Instant Quotes
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🛡️</span>
                    <strong>Secure</strong><br>Safe Handling
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🌍</span>
                    <strong>Global</strong><br>Worldwide Reach
                </div>
            </div>

            <p class="help-text">
                Need help getting started? <br>
                Our support team is just a reply away.
            </p>
        </div>

        <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Demira Freight Linkers. All rights reserved.</p>
            <div class="links">
                <a href="${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/terms-of-service">Terms & Conditions</a> •
                <a href="${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/privacy-policy">Privacy Policy</a>
            </div>
            <p style="margin-top: 20px; font-size: 11px; opacity: 0.6;">
                You received this email because you signed up for DFL Group services.<br>
                Made with <span style="color: #e53e3e;">&hearts;</span> for Logistics.
            </p>
        </div>
    </div>
</body>
</html>
    `;
};

const generateAdminNewOrderAlert = (shipment) => {
    const { shipperDetails, consigneeDetails, shipmentDetails, serviceDetails, shipmentId, createdAt, user } = shipment;
    const date = new Date(createdAt).toLocaleString('en-GB');

    // Create a summary description from keys items
    const allItems = shipmentDetails.boxes.flatMap(b => b.items || []);
    const descriptionSummary = allItems.length > 0 
        ? allItems.map(i => i.productName).join(', ').substring(0, 100) + (allItems.length > 3 ? '...' : '')
        : 'N/A';

    const boxesHtml = shipmentDetails.boxes.map((box, idx) => {
        // Calculate Volumetric Weight: (L x W x H) / 5000
        const l = parseFloat(box.length) || 0;
        const w = parseFloat(box.width) || 0;
        const h = parseFloat(box.height) || 0;
        const volWeight = ((l * w * h) / 5000).toFixed(2);

        // Generate Items HTML
        const itemsListHtml = (box.items || []).map(item => {
            return `
                <div style="margin-bottom: 8px; font-size: 11px; border-bottom: 1px dashed #eee; padding-bottom: 4px;">
                    <strong>${item.productName || 'N/A'}</strong><br>
                    <span style="color: #555;">HSN: ${item.hsnCode || '-'} | Qty: ${item.quantity} | Rate: ${item.unitPrice}</span><br>
                    <span style="color: #555;">IGST: ${item.igst || 'N/A'}</span>
                </div>
            `;
        }).join('');

        return `
        <tr>
            <td style="padding: 5px; border-bottom: 1px solid #eee;">Box ${idx + 1}</td>
            <td style="padding: 5px; border-bottom: 1px solid #eee;">${box.weight} kg</td>
            <td style="padding: 5px; border-bottom: 1px solid #eee;">${box.length} x ${box.width} x ${box.height} cm (Vol: ${volWeight} kg)</td>
            <td style="padding: 5px; border-bottom: 1px solid #eee;">
                ${itemsListHtml || '<span style="color: #999;">No Items Declared</span>'}
            </td>
        </tr>
    `;
    }).join('');

    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; color: #333; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; background: #fff; }
        .header { background: #0B4F6C; color: white; padding: 15px; text-align: center; }
        .section { margin-bottom: 20px; border: 1px solid #eee; padding: 15px; border-radius: 5px; }
        .section-title { font-weight: bold; margin-bottom: 10px; color: #0B4F6C; border-bottom: 2px solid #f97316; display: inline-block; }
        .table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .table td { vertical-align: top; padding: 5px 0; }
        .label { font-weight: bold; width: 140px; color: #555; }
        .box-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
        .box-table th { background: #f0f0f0; padding: 5px; text-align: left; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img src="cid:dfl_logo" alt="DFL Group" style="max-height: 50px; margin-bottom: 10px; display: block; margin-left: auto; margin-right: auto;">
            <h2>🚨 New Order Alert: ${shipmentId}</h2>
            <p style="margin:0">${date}</p>
        </div>

        <!-- Customer Info -->
        <div class="section">
            <div class="section-title">👤 Customer Details</div>
             <table class="table">
                <tr><td class="label">Customer Name:</td><td>${user ? user.name : 'N/A'}</td></tr>
                <tr><td class="label">Company:</td><td>${user ? user.companyName : 'N/A'}</td></tr>
                <tr><td class="label">Email:</td><td>${user ? user.email : 'N/A'}</td></tr>
                <tr><td class="label">Phone:</td><td>${user ? user.phone : 'N/A'}</td></tr>
                <tr><td class="label">Customer ID:</td><td>${user ? user.customerId : 'N/A'}</td></tr>
            </table>
        </div>

        <!-- Route Info -->
        <div class="section">
             <div class="section-title">📍 Route & Service</div>
             <table class="table">
                <tr><td class="label">Service:</td><td>${serviceDetails.serviceName}</td></tr>
                <tr><td class="label">Origin:</td><td>${shipperDetails.city}, ${shipperDetails.state}, ${shipperDetails.country}</td></tr>
                <tr><td class="label">Destination:</td><td>${consigneeDetails.city}, ${consigneeDetails.state}, ${consigneeDetails.country}</td></tr>
                <tr><td class="label">Est. Weight:</td><td><strong>${serviceDetails.chargeableWeight} kg</strong> (Billable)</td></tr>
                <tr><td class="label">Price:</td><td>₹${serviceDetails.price}</td></tr>
            </table>
        </div>

        <!-- Addresses -->
         <div class="section">
            <table style="width:100%">
                <tr>
                    <td style="width:50%; padding-right:10px;">
                        <div class="section-title">📤 Shipper</div><br>
                        <strong>${shipperDetails.shipperName}</strong><br>
                        ${shipperDetails.addressLine1}, ${shipperDetails.city}<br>
                        ${shipperDetails.state} - ${shipperDetails.pincode}<br>
                        Phone: ${shipperDetails.mobileNo}<br>
                        
                    </td>
                    <td style="width:50%; padding-left:10px; border-left:1px solid #eee;">
                        <div class="section-title">📥 Consignee</div><br>
                        <strong>${consigneeDetails.consigneeName}</strong><br>
                        ${consigneeDetails.addressLine1}, ${consigneeDetails.city}<br>
                        ${consigneeDetails.state} - ${consigneeDetails.pincode}<br>
                        ${consigneeDetails.country}<br>
                        Phone: ${consigneeDetails.mobileNo}<br>
                        
                    </td>
                </tr>
            </table>
        </div>

        <!-- Cargo Details -->
        <div class="section">
            <div class="section-title">📦 Cargo Details</div>
            <p style="margin:5px 0"><strong>Description:</strong> ${descriptionSummary}</p>
            <p style="margin:5px 0"><strong>Category:</strong> ${shipmentDetails.shipmentCategory}</p>
            
            <table class="box-table">
                <thead>
                    <tr><th style="width: 15%;">Box</th><th style="width: 15%;">Weight</th><th style="width: 25%;">Dims (Vol)</th><th style="width: 45%;">Content</th></tr>
                </thead>
                <tbody>
                    ${boxesHtml}
                </tbody>
            </table>
        </div>

        <div style="text-align:center; padding-top:20px; font-size:12px; color:#888;">
            Automated Alert triggered by DFL Admin System
        </div>
    </div>
</body>
</html>
    `;
};

const generateShipmentStatusUpdateEmail = ({ shipment, statusLabel, actionLabel }) => {
    const shipmentId = shipment?.shipmentId || 'N/A';
    const shipperName = shipment?.shipperDetails?.shipperName || 'Customer';
    const consigneeName = shipment?.consigneeDetails?.consigneeName || 'Consignee';
    const trackingId = shipment?.trackingId || shipment?.lastMileAWB || 'N/A';
    const date = new Date().toLocaleString('en-GB');

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Shipment Status Update</title>
    <style>
        body { font-family: Arial, sans-serif; color: #334155; margin: 0; padding: 0; background: #f8fafc; }
        .wrap { max-width: 640px; margin: 0 auto; padding: 24px; }
        .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; }
        .head { background: linear-gradient(135deg, #0B4F6C, #0f766e); color: white; padding: 24px; }
        .body { padding: 24px; }
        .badge { display: inline-block; padding: 6px 10px; border-radius: 999px; background: #e0f2fe; color: #0369a1; font-size: 12px; font-weight: 700; }
        .row { margin: 10px 0; font-size: 14px; }
        .label { color: #64748b; font-weight: 700; display: inline-block; min-width: 130px; }
        .cta { display: inline-block; margin-top: 16px; background: #0B4F6C; color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 10px; font-weight: 700; }
        .footer { padding: 16px 24px 24px; color: #94a3b8; font-size: 12px; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="card">
            <div class="head">
                <div class="badge">${statusLabel}</div>
                <h2 style="margin: 12px 0 0;">${actionLabel}</h2>
                <div style="margin-top: 6px; opacity: 0.9;">${date}</div>
            </div>
            <div class="body">
                <p>Hi ${shipperName},</p>
                <p>Your shipment status has been updated. Please find the latest details below.</p>
                <div class="row"><span class="label">Shipment ID:</span> ${shipmentId}</div>
                <div class="row"><span class="label">Tracking ID:</span> ${trackingId}</div>
                <div class="row"><span class="label">Consignee:</span> ${consigneeName}</div>
                <div class="row"><span class="label">Updated Status:</span> ${statusLabel}</div>
                <div style="margin-top: 20px;">
                    <a class="cta" href="${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipmentId}">Track Shipment</a>
                </div>
            </div>
            <div class="footer">
                This is an automated notification from DFL Group.
            </div>
        </div>
    </div>
</body>
</html>
    `;
};

const generateShipmentBookedEmail = (name, shipment) => {
    const origin = shipment.shipperDetails?.city || 'Origin';
    const destination = shipment.consigneeDetails?.city || 'Destination';
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>Thank you for booking with us! We have received your shipment request <strong>#${shipment.shipmentId}</strong>.</p>
    <p>Your order is currently <strong>Booked</strong>. Our logistics team is completing the final review and processing. Once verified, we will initiate the fulfillment process and provide you with further updates.</p>
    <ul>
        <li><strong>Shipment ID / Tracking No:</strong> ${shipment.shipmentId}</li>
        <li><strong>Route:</strong> ${origin} to ${destination}</li>
    </ul>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Your Shipment</a>
    </p>
    <p style="font-size: 12px; color: #666;">Or copy and paste this link in your browser: <br><a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentProcessingEmail = (name, shipment) => {
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>Great news! Your shipment <strong>#${shipment.shipmentId}</strong> is now actively being <strong>Processed</strong>.</p>
    <p>Our operations team is preparing your package, generating required documentation, and assigning a carrier for transport.</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Live Status</a>
    </p>
    <p style="font-size: 12px; color: #666;">Direct Tracking Link: <a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentReceivedEmail = (name, shipment, hubLocation) => {
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>Your package for shipment <strong>#${shipment.shipmentId}</strong> has successfully arrived at our central operations hub in <strong>${hubLocation}</strong>.</p>
    <p>Our warehouse team is conducting standard quality and weight inspections before dispatching it on the next leg of its journey.</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Live Status</a>
    </p>
    <p style="font-size: 12px; color: #666;">Direct Tracking Link: <a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentDisputeEmail = (name, shipment) => {
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>We have logged a <strong>Dispute</strong> regarding shipment <strong>#${shipment.shipmentId}</strong>.</p>
    <p>Our operations and compliance team is actively investigating the issue. A support ticket has been created, and a representative will update you within 24 hours.</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">View Shipment Details</a>
    </p>
    <p style="font-size: 12px; color: #666;">Direct Tracking Link: <a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>Best regards,<br><strong>DFL Group Customer Care</strong></p>
</body>
</html>
    `;
};

const generateShipmentDeliveredEmail = (name, shipment) => {
    // Format delivery date if available, else use current date
    const deliveryDateObj = shipment.trackingHistory?.find(t => t.status === 'Delivered')?.timestamp || new Date();
    const deliveryDate = new Date(deliveryDateObj).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #059669; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>We are pleased to inform you that shipment <strong>#${shipment.shipmentId}</strong> was successfully <strong>Delivered</strong> on ${deliveryDate}.</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">View Delivery Proof & Details</a>
    </p>
    <p>Thank you for choosing DFL Group for your shipping needs. We look forward to serving you again!</p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentInTransitEmail = (name, shipment) => {
    const origin = shipment.shipperDetails?.city || 'Origin';
    const destination = shipment.consigneeDetails?.city || 'Destination';
    const serviceName = shipment.serviceDetails?.serviceName || 'DFL Express';
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>Your shipment <strong>#${shipment.shipmentId}</strong> has departed our hub and is currently <strong>In Transit</strong> to ${destination}.</p>
    <ul>
        <li><strong>Tracking Number:</strong> ${shipment.shipmentId}</li>
        <li><strong>Current Status:</strong> In Transit</li>
        <li><strong>Service / Route:</strong> ${serviceName} | ${origin} to ${destination}</li>
    </ul>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Live Shipment</a>
    </p>
    <p style="font-size: 12px; color: #666;">Direct Tracking Link: <a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>We are closely monitoring its progress to ensure timely delivery.</p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentDisputeResolvedEmail = (name, shipment, resolutionDetails) => {
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>We are writing to let you know that the dispute regarding shipment <strong>#${shipment.shipmentId}</strong> has been <strong>Resolved</strong>.</p>
    <p><strong>Resolution Details:</strong> ${resolutionDetails || 'The issue has been verified and successfully resolved by our support team.'}</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Shipment</a>
    </p>
    <p>Thank you for your patience while we worked to resolve this matter.</p>
    <p>Best regards,<br><strong>DFL Group Support Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentOutForDeliveryEmail = (name, shipment) => {
    const trackingUrl = `${process.env.CLIENT_URL || 'https://express.thedflgroup.com'}/tracking?id=${shipment.shipmentId}`;
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: Arial, sans-serif; color: #333; line-height: 1.6; }
        .btn-track { display: inline-block; background-color: #0B4F6C; color: #ffffff !important; text-decoration: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; margin: 15px 0; }
    </style>
</head>
<body style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
    <p>Dear ${name},</p>
    <p>Great news! Your shipment <strong>#${shipment.shipmentId}</strong> is <strong>Out for Delivery</strong> and will reach you soon.</p>
    <p>Please ensure someone is available at the destination address to receive the package.</p>
    <p>
        <a href="${trackingUrl}" class="btn-track" style="color: #ffffff; text-decoration: none;">Track Live Delivery</a>
    </p>
    <p style="font-size: 12px; color: #666;">Direct Tracking Link: <a href="${trackingUrl}">${trackingUrl}</a></p>
    <p>Thank you for choosing DFL Group!</p>
    <p>Best regards,<br><strong>DFL Group Team</strong></p>
</body>
</html>
    `;
};

const generateShipmentDelayReportEmail = ({ pickupDelays = [], dispatchDelays = [], deliveryDelays = [] }) => {
    const reportDate = new Date().toLocaleDateString('en-GB', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });

    const renderTable = (items, type) => {
        if (!items || items.length === 0) {
            return `<p style="color: #64748b; font-size: 13px; font-style: italic;">No shipments in this delay category today.</p>`;
        }

        const rows = items.map((item, idx) => {
            const delayText = item.delayMetrics?.primaryText || item.delayMetrics?.pickupDelay?.delayText || item.delayMetrics?.dispatchDelay?.delayText || item.delayMetrics?.deliveryDelay?.delayText || 'Delayed';
            const customerName = item.user?.name || item.shipperDetails?.shipperName || 'N/A';
            const route = `${item.shipperDetails?.city || 'Origin'} -> ${item.consigneeDetails?.city || 'Destination'}`;

            return `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; font-weight: bold;">${idx + 1}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #0f172a; font-weight: 700;">${item.shipmentId || item.trackingId || 'N/A'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155;">${customerName}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155;">${route}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; color: #334155;">${item.status || 'Pending'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px; font-weight: 700; color: #dc2626;">${delayText}</td>
                </tr>
            `;
        }).join('');

        return `
            <table style="width: 100%; border-collapse: collapse; margin-top: 10px; font-family: Arial, sans-serif;">
                <thead>
                    <tr style="background-color: #f1f5f9; text-align: left;">
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 5%;">#</th>
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 25%;">Shipment ID</th>
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 25%;">Customer</th>
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 20%;">Route</th>
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 15%;">Status</th>
                        <th style="padding: 8px; font-size: 12px; color: #475569; width: 10%;">Delay</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;
    };

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>DFL Shipment Delay Summary Report</title>
</head>
<body style="font-family: Arial, sans-serif; color: #1e293b; background-color: #f8fafc; margin: 0; padding: 20px;">
    <div style="max-width: 800px; margin: 0 auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); color: #ffffff; padding: 20px; border-radius: 8px; margin-bottom: 24px;">
            <h2 style="margin: 0 0 6px 0; font-size: 20px;">⏰ DFL Daily Shipment Delay Alert Summary</h2>
            <p style="margin: 0; font-size: 13px; color: #94a3b8;">Report Date: <strong>${reportDate}</strong> | Target: Operations & Management</p>
        </div>

        <!-- Section 1: Pickup Delays -->
        <div style="margin-bottom: 24px; border: 1px solid #fecaca; background-color: #fff5f5; padding: 16px; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #991b1b; font-size: 16px;">⚠️ 1. Pickup Delays (Overdue Scheduled Pickup Date) [Total: ${pickupDelays.length}]</h3>
            ${renderTable(pickupDelays, 'pickup')}
        </div>

        <!-- Section 2: Hub Dispatch Delays -->
        <div style="margin-bottom: 24px; border: 1px solid #fed7aa; background-color: #fff7ed; padding: 16px; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #c2410c; font-size: 16px;">🏢 2. Hub Dispatch Delays (> 24 Hours at Hub Un-dispatched) [Total: ${dispatchDelays.length}]</h3>
            ${renderTable(dispatchDelays, 'dispatch')}
        </div>

        <!-- Section 3: Delivery Delays -->
        <div style="margin-bottom: 24px; border: 1px solid #e9d5ff; background-color: #faf5ff; padding: 16px; border-radius: 8px;">
            <h3 style="margin: 0 0 10px 0; color: #7e22ce; font-size: 16px;">🚚 3. Delivery Delays (Exceeded Service ETA + 2 Grace Days) [Total: ${deliveryDelays.length}]</h3>
            ${renderTable(deliveryDelays, 'delivery')}
        </div>

        <!-- Footer -->
        <div style="text-align: center; font-size: 11px; color: #64748b; margin-top: 20px; border-top: 1px solid #e2e8f0; padding-top: 12px;">
            This is an automated internal operational alert generated by DFL Operations Worker.<br>
            Recipient: kaushal.tech@thedflgroup.com
        </div>
    </div>
</body>
</html>
    `;
};

module.exports = { generateOrderConfirmationEmail, generateWelcomeEmail, generateAdminNewOrderAlert, generateShipmentStatusUpdateEmail, generateShipmentBookedEmail, generateShipmentProcessingEmail, generateShipmentReceivedEmail, generateShipmentDisputeEmail, generateShipmentDeliveredEmail, generateShipmentInTransitEmail, generateShipmentDisputeResolvedEmail, generateShipmentOutForDeliveryEmail, generateShipmentDelayReportEmail };

