const Shipment = require('../../models/Shipment');
const User = require('../../models/User');

// Helper to calculate profit and other fields
const calculateFinancials = (shipment, userMarkup = 20) => {
    // 1. Extract raw values from serviceDetails
    const baseCost = shipment.serviceDetails?.cost || 0;
    const markup = shipment.serviceDetails?.markup || 0;
    const handling = shipment.serviceDetails?.handling || 0;
    const countrySurcharge = shipment.serviceDetails?.countrySurcharge || 0;
    const fuelSurcharge = shipment.serviceDetails?.fuelSurcharge || 0;

    // 2. Determine Total Price (The amount paid/debited)
    const priceString = String(shipment.serviceDetails?.price || '0');
    // For many shipments, price deducted from wallet is the base + markup + handling + surcharges
    const totalPrice = parseFloat(priceString.replace(/[^0-9.]/g, '')) || (baseCost + markup + handling + countrySurcharge + fuelSurcharge);

    // 3. Determine GST (Fallback to 18% calculation if not found in invoice)
    let gstAmount = shipment.invoice?.tax?.amount || 0;
    if (gstAmount === 0 && totalPrice > 0) {
        // Assume GST is inclusive in total price if not explicitly stored in invoice
        // Or if the price deducted from wallet was GST inclusive
        const taxRate = parseFloat(shipment.serviceDetails?.igstTaxPercentage) || 18;
        gstAmount = totalPrice - (totalPrice / (1 + (taxRate / 100)));
    }

    // 4. Determine Profit and Actual Price
    let profit = markup + handling;
    let actualPrice = baseCost + countrySurcharge + fuelSurcharge;

    // SCENARIO A: If profit is reported as 0 but we have a base cost, derive profit from the gap
    if (profit === 0 && actualPrice > 0 && totalPrice > 0) {
        // Profit = Total Price - GST - Base Cost
        profit = totalPrice - gstAmount - actualPrice;
    }

    // SCENARIO B: If base cost (actual price) is 0 but we have profit data, derive base cost
    if (actualPrice === 0 && profit > 0 && totalPrice > 0) {
        actualPrice = totalPrice - gstAmount - profit;
    }

    // SCENARIO C: If BOTH are 0 but we have a total price, we use the user's tier markup to estimate.
    // This ensures no shipment shows 0 profit if it has a total cost.
    if (profit === 0 && actualPrice === 0 && totalPrice > 0) {
        const netAmount = totalPrice - gstAmount;
        // Total = Cost + Profit -> Profit = Cost * (MarkupPercentage/100)
        // Total = Cost * (1 + Markup/100) -> Cost = Total / (1 + Markup/100)
        actualPrice = netAmount / (1 + (userMarkup / 100));
        profit = netAmount - actualPrice;
    }

    // Ensure no negative values from derivation errors
    profit = Math.max(0, profit);
    actualPrice = Math.max(0, actualPrice);

    return {
        baseCost: Number(baseCost.toFixed(2)),
        countrySurcharge: Number(countrySurcharge.toFixed(2)),
        fuelSurcharge: Number(fuelSurcharge.toFixed(2)),
        actualPrice: Number(actualPrice.toFixed(2)),
        profit: Number(profit.toFixed(2)),
        gstAmount: Number(gstAmount.toFixed(2)),
        totalCost: Number(totalPrice.toFixed(2)),
        markup // Original markup field for reference if needed
    };
};

// @desc    Get finance summary by customer
// @route   GET /api/admin/finance/summary
// @access  Private/SuperAdmin
// @desc    Get finance summary by customer
// @route   GET /api/admin/finance/summary
// @access  Private/Admin+
const getFinanceSummary = async (req, res) => {
    try {
        // Fetch all users and shipments to calculate financials in memory
        // Paginating this properly would be better for scale, but for now we fetch all to get accurate totals
        const [users, shipments] = await Promise.all([
            User.find({}).select('name customerId markupPercentage tag'),
            Shipment.find({})
                .select('user serviceDetails invoice createdAt paymentMode')
                .lean()
        ]);

        const userMap = new Map();
        users.forEach(u => {
            // Exclude Internal Account (Check both _id and customerId)
            const internalId = '466a914b-b221-46ef-8eb6-c49be483c18b';
            if (String(u._id) === internalId || u.customerId === internalId) return;

            let effectiveMarkup = u.markupPercentage || 20;
            if (u.tag) {
                const tag = String(u.tag).toLowerCase();
                if (tag.includes('gold') || tag === 'd95679752134a2d9eb61dbd7b91c4bcc') effectiveMarkup = 16;
                else if (tag.includes('platinum') || tag === '5c7f383122c4a923d34d3f3511d1377e') effectiveMarkup = 12;
                else if (tag.includes('silver') || tag === 'e034fb6b66aacc1d48f445ddfb08da98') effectiveMarkup = 20;
            }

            userMap.set(String(u._id), {
                userId: u._id,
                name: u.name,
                customerId: u.customerId,
                markup: effectiveMarkup,
                totalShipments: 0,
                totalSpend: 0,
                totalProfit: 0,
                totalActual: 0,
                totalGst: 0,
                totalSurcharge: 0,
                totalFuel: 0
            });
        });

        shipments.forEach(s => {
            const dateStr = String(s.user);
            if (userMap.has(dateStr)) {
                const userStats = userMap.get(dateStr);
                const financials = calculateFinancials(s, userStats.markup);

                userStats.totalShipments += 1;
                // Add Total Cost (what customer pays)
                userStats.totalSpend += financials.totalCost;
                // Add Profit
                userStats.totalProfit += financials.profit;
                // Add Actual Cost
                userStats.totalActual += financials.actualPrice;
                // Add GST
                userStats.totalGst += financials.gstAmount;
                // Add Surcharges
                userStats.totalSurcharge += financials.countrySurcharge;
                userStats.totalFuel += financials.fuelSurcharge;
            }
        });

        // Convert Map to Array and Sort by Spend
        const summary = Array.from(userMap.values())
            .filter(u => u.totalShipments > 0) // Only show active users
            .sort((a, b) => b.totalSpend - a.totalSpend); // Sort by highest spenders

        res.json(summary);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get detailed finance data for a specific customer
// @route   GET /api/admin/finance/customer/:userId
// @access  Private/SuperAdmin
const getCustomerFinanceDetails = async (req, res) => {
    try {
        const { userId } = req.params;

        // Fetch user with tag and markupPercentage for derivation fallbacks
        const [user, shipments] = await Promise.all([
            User.findById(userId).select('name customerId markupPercentage tag'),
            Shipment.find({ user: userId })
                .select('shipmentId shipperDetails consigneeDetails serviceDetails invoice createdAt paymentMode status') // Added status
                .sort({ createdAt: -1 })
        ]);

        if (!user) {
            return res.status(404).json({ message: 'Customer not found' });
        }

        // Determine derived markup percentage based on user tier if markupPercentage is 0
        let effectiveMarkup = user.markupPercentage || 20;
        if (user.tag) {
            const tag = String(user.tag).toLowerCase();
            if (tag.includes('gold') || tag === 'd95679752134a2d9eb61dbd7b91c4bcc') effectiveMarkup = 16;
            else if (tag.includes('platinum') || tag === '5c7f383122c4a923d34d3f3511d1377e') effectiveMarkup = 12;
            else if (tag.includes('silver') || tag === 'e034fb6b66aacc1d48f445ddfb08da98') effectiveMarkup = 20;
        }

        const formattedShipments = shipments.map(s => {
            const financials = calculateFinancials(s, effectiveMarkup);
            return {
                shipmentId: s.shipmentId,
                pickup: `${s.shipperDetails?.city}, ${s.shipperDetails?.country}`,
                delivery: `${s.consigneeDetails?.city}, ${s.consigneeDetails?.country}`,
                serviceType: s.serviceDetails?.serviceName,
                bookingDate: s.createdAt,
                status: s.status || 'Pending', // Added status
                shipmentCost: financials.totalCost,
                actualPrice: financials.baseCost, // Changed to show only base cost
                countrySurcharge: financials.countrySurcharge,
                fuelSurcharge: financials.fuelSurcharge,
                profit: financials.profit,
                gstAmount: financials.gstAmount,
                paymentMethod: s.paymentMode || 'Wallet',
                markup: financials.markup
            };
        });

        // Totals
        const totals = formattedShipments.reduce((acc, curr) => {
            acc.totalCost += curr.shipmentCost;
            acc.totalProfit += curr.profit;
            acc.totalGst += curr.gstAmount;
            acc.totalActual += curr.actualPrice;
            acc.totalSurcharge += curr.countrySurcharge;
            acc.totalFuel += curr.fuelSurcharge;
            return acc;
        }, { totalCost: 0, totalProfit: 0, totalGst: 0, totalActual: 0, totalSurcharge: 0, totalFuel: 0 });

        res.json({
            customer: {
                name: user.name,
                customerId: user.customerId
            },
            shipments: formattedShipments,
            totals
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const Dispute = require('../../models/Dispute'); // Ensure Dispute model is imported

// @desc    Export finance data as Excel
// @route   GET /api/admin/finance/export
// @access  Private/Admin+
const exportFinanceData = async (req, res) => {
    try {
        const XLSX = require('xlsx');
        const { userId, startDate, endDate, status, searchTerm } = req.query;

        const userQuery = userId ? { _id: userId } : {};
        let shipmentQuery = userId ? { user: userId } : {};

        // Status filter (handle comma-separated string from frontend)
        if (status && status !== 'All') {
            const statusArray = status.split(',');
            if (statusArray.length > 0) {
                shipmentQuery.status = { $in: statusArray };
            }
        }

        // We fetch a slightly broader range if dates are provided to catch late deliveries
        if (startDate || endDate) {
            shipmentQuery.createdAt = {};
            if (startDate) {
                const start = new Date(startDate);
                shipmentQuery.createdAt.$gte = new Date(start.getTime() - (45 * 24 * 60 * 60 * 1000));
            }
            if (endDate) {
                shipmentQuery.createdAt.$lte = new Date(new Date(endDate).getTime() + (24 * 60 * 60 * 1000));
            }
        }

        const [users, shipments] = await Promise.all([
            User.find(userQuery).select('name customerId markupPercentage tag kycData'),
            Shipment.find(shipmentQuery)
                .sort({ createdAt: -1 })
                .lean()
        ]);

        // Fetch Disputes for these shipments
        const shipmentIds = shipments.map(s => s._id);
        const disputes = await Dispute.find({ shipment: { $in: shipmentIds } }).lean();

        const disputeMap = new Map();
        disputes.forEach(d => {
            const shipId = String(d.shipment);
            if (!disputeMap.has(shipId)) {
                disputeMap.set(shipId, {
                    amount: 0,
                    netAdjustment: 0,
                    status: d.status,
                    reason: d.reason,
                    type: d.disputeType
                });
            }
            const current = disputeMap.get(shipId);

            // Calculate Net Financial Impact
            // 'Approved' = User Paid (Debit) -> Increase Revenue
            // 'Resolved' = User Refunded (Credit) -> Decrease Revenue
            if (d.status === 'Approved') {
                current.netAdjustment += (d.amount || 0);
            } else if (d.status === 'Resolved') {
                current.netAdjustment -= (d.amount || 0);
            }

            current.amount += (d.amount || 0); // Total value of disputes raised
            current.status = d.status; // Latest status
            current.reason = current.reason === d.reason ? current.reason : `${current.reason}; ${d.reason}`;
            current.type = current.type === d.disputeType ? current.type : `${current.type}, ${d.disputeType}`;
        });

        const userMap = new Map();
        users.forEach(u => {
            // Exclude Internal Account
            const internalId = '466a914b-b221-46ef-8eb6-c49be483c18b';
            if (String(u._id) === internalId || u.customerId === internalId) return;

            let effectiveMarkup = u.markupPercentage || 20;
            if (u.tag) {
                const tag = String(u.tag).toLowerCase();
                if (tag.includes('gold') || tag === 'd95679752134a2d9eb61dbd7b91c4bcc') effectiveMarkup = 16;
                else if (tag.includes('platinum') || tag === '5c7f383122c4a923d34d3f3511d1377e') effectiveMarkup = 12;
                else if (tag.includes('silver') || tag === 'e034fb6b66aacc1d48f445ddfb08da98') effectiveMarkup = 20;
            }

            userMap.set(String(u._id), {
                userId: u._id,
                name: u.name,
                customerId: u.customerId,
                markup: effectiveMarkup,
                gstNumber: u.kycData?.gstNumber || ''
            });
        });

        const activeData = [];
        const cancelledData = [];

        shipments.forEach(s => {
            const dateStr = String(s.user);
            if (userMap.has(dateStr)) {
                const user = userMap.get(dateStr);

                // Apply Search Filter
                if (searchTerm) {
                    const search = searchTerm.toLowerCase();
                    const matchesSearch = (s.shipmentId?.toLowerCase() || '').includes(search) ||
                        (user.name?.toLowerCase() || '').includes(search) ||
                        (user.customerId?.toLowerCase() || '').includes(search);
                    if (!matchesSearch) return;
                }

                const financials = calculateFinancials(s, user.markup);

                // Determine Display Date: Use delivery date for delivered shipments, else booking date
                let displayDate = new Date(s.createdAt).toISOString().split('T')[0];
                let rawStatusDate = new Date(s.createdAt);

                if (s.status === 'Delivered' && s.trackingHistory?.length > 0) {
                    const deliveryEvent = [...s.trackingHistory].reverse().find(h =>
                        h.status === 'Delivered' ||
                        (h.description && h.description.toLowerCase().includes('delivered'))
                    );
                    if (deliveryEvent && deliveryEvent.timestamp) {
                        rawStatusDate = new Date(deliveryEvent.timestamp);
                        displayDate = rawStatusDate.toISOString().split('T')[0];
                    }
                }

                // Apply in-memory filter for Status Date
                if (startDate && rawStatusDate < new Date(startDate)) return;
                if (endDate && rawStatusDate > new Date(new Date(endDate).getTime() + (24 * 60 * 60 * 1000))) return;

                const invoiceDate = s.invoice?.invoiceDate ? new Date(s.invoice.invoiceDate).toISOString().split('T')[0] : '';

                const boxSummary = s.shipmentDetails?.boxes?.map((b, i) =>
                    `[Box ${i + 1}: ${b.length}x${b.width}x${b.height}cm, ${b.weight}kg]`
                ).join('; ') || '';

                // Extract HSN Codes
                const extractHSNCodes = (shipment) => {
                    if (!shipment?.shipmentDetails?.boxes) return '-';
                    let allCodes = [];
                    shipment.shipmentDetails.boxes.forEach(box => {
                        if (box.items && box.items.length > 0) {
                            box.items.forEach(item => {
                                if (item.hsnCode) allCodes.push(String(item.hsnCode).trim());
                            });
                        } else if (box.hsnCode) {
                            allCodes.push(String(box.hsnCode).trim());
                        }
                    });
                    const uniqueCodes = [...new Set(allCodes)];
                    return uniqueCodes.length > 0 ? uniqueCodes.join(', ') : '-';
                };

                // Calculate Total Weight 
                const totalWeight = s.shipmentDetails?.boxes?.reduce((acc, b) => acc + (parseFloat(b.weight) || 0), 0) || 0;

                // Get dispute info
                const disputeInfo = disputeMap.get(String(s._id)) || { amount: 0, netAdjustment: 0, status: 'N/A', reason: '', type: '' };

                // Calculate Dispute Shipping Charge and GST Type
                const taxRate = 18;
                const disputeShippingCharge = disputeInfo.amount > 0 ? Number((disputeInfo.amount / (1 + (taxRate / 100))).toFixed(2)) : 0;
                const totalGstAmountDispute = disputeInfo.amount > 0 ? Number((disputeInfo.amount - disputeShippingCharge).toFixed(2)) : 0;
                const gstTypeDispute = (disputeInfo.status !== 'N/A') ? ((
                    s.invoice?.billedTo?.gstin?.startsWith('09') ||
                    user.gstNumber?.startsWith('09') ||
                    s.shipperDetails?.state?.toLowerCase().includes('uttar pradesh')
                ) ? 'CGST + SGST' : 'IGST') : 'N/A';

                // Apply Adjustments (As per user request: DO NOT add dispute amount to profit/cost)
                const finalTotalCost = financials.totalCost;
                const finalProfit = financials.profit;

                const row = {
                    'Shipment ID': s.shipmentId,
                    'Status Date': displayDate,
                    'Booking Date': new Date(s.createdAt).toISOString().split('T')[0],
                    'Status': s.status || 'Pending',
                    'Tracking ID': s.trackingId || '',
                    'Carrier': s.trackingCarrier || 'Speedbox',
                    'Manifest ID': s.manifestId ? String(s.manifestId) : '',
                    'HSN Code': extractHSNCodes(s),
                    'SAC-CODE': '9968',

                    'Customer Name': user.name,
                    'Customer ID': user.customerId,

                    'Shipper Name': s.shipperDetails?.shipperName || '',
                    'Shipper Company': s.shipperDetails?.companyName || '',
                    'Shipper Phone': s.shipperDetails?.mobileNo || '',
                    'Shipper Email': s.shipperDetails?.email || '',
                    'Shipper Addr 1': s.shipperDetails?.addressLine1 || '',
                    'Shipper Addr 2': s.shipperDetails?.addressLine2 || '',
                    'Shipper City': s.shipperDetails?.city || '',
                    'Shipper State': s.shipperDetails?.state || '',
                    'Shipper Country': s.shipperDetails?.country || '',
                    'Shipper Pincode': s.shipperDetails?.pincode || '',
                    'Shipper Type': s.shipperDetails?.shipperType || '',
                    'Pickup Type': s.shipperDetails?.pickupType || '',

                    'Consignee Name': s.consigneeDetails?.consigneeName || '',
                    'Consignee Company': s.consigneeDetails?.companyName || '',
                    'Consignee Phone': s.consigneeDetails?.mobileNo || '',
                    'Consignee Email': s.consigneeDetails?.email || '',
                    'Consignee Addr 1': s.consigneeDetails?.addressLine1 || '',
                    'Consignee Addr 2': s.consigneeDetails?.addressLine2 || '',
                    'Consignee City': s.consigneeDetails?.city || '',
                    'Consignee State': s.consigneeDetails?.state || '',
                    'Consignee Country': s.consigneeDetails?.country || '',
                    'Consignee Pincode': s.consigneeDetails?.pincode || '',

                    'Category': s.shipmentDetails?.shipmentCategory || '',
                    'Mode': s.shipmentDetails?.shipmentMode || '',
                    'Type': s.shipmentDetails?.shipmentType || '',
                    'Service Name': s.serviceDetails?.serviceName || '',
                    'Service Code': s.serviceDetails?.serviceCode || '',
                    'Zone': '', // Not available in schema
                    'Purpose': s.shipmentDetails?.purposeOfShipment || '',
                    'Ref Number': s.shipmentDetails?.referenceNumber || '',
                    'Content Desc': s.invoice?.lineItems?.[0]?.description || '',

                    'Weight (kg)': totalWeight,
                    'Chargeable Wt (kg)': s.serviceDetails?.chargeableWeight || 0,
                    'Dimensions': boxSummary,
                    'Total Boxes': s.shipmentDetails?.noOfBoxes || 1,
                    'Insured': s.shipmentDetails?.insureShipment ? 'Yes' : 'No',
                    'Packaging Added': s.shipmentDetails?.addPackaging ? 'Yes' : 'No',

                    'Invoice No': s.shipmentDetails?.invoiceNumber || '',
                    'Invoice Date': invoiceDate,
                    'GST Payment Type': s.shipmentDetails?.gstPaymentType || 'LUT',
                    'IGST Tax %': s.serviceDetails?.igstTaxPercentage || '0',
                    'Currency': s.shipmentDetails?.currency || 'INR',

                    'Payment Mode': s.paymentMode || 'Wallet', // defaulting to Wallet if missing
                    'Base Cost (Carrier)': financials.baseCost,
                    'Country Surcharge': financials.countrySurcharge,
                    'Fuel Surcharge': financials.fuelSurcharge,
                    'Markup (%)': user.markup,
                    'Handling Fees': s.serviceDetails?.handling || 0,

                    'GST Number': s.invoice?.billedTo?.gstin || user.gstNumber || '',
                    'GST Amount': financials.gstAmount,
                    'IGST': (s.invoice?.tax?.type === 'IGST' || !s.invoice?.tax?.type) ? financials.gstAmount : 0,
                    'CGST': (s.invoice?.tax?.type === 'CGST + SGST') ? Number((financials.gstAmount / 2).toFixed(2)) : 0,
                    'SGST': (s.invoice?.tax?.type === 'CGST + SGST') ? Number((financials.gstAmount / 2).toFixed(2)) : 0,

                    'Total Cost (Wallet)': finalTotalCost,
                    'Est. Profit': finalProfit,

                    // Dispute Columns
                    'Dispute Status': disputeInfo.status,
                    'Dispute Amount': disputeInfo.amount,
                    'Dispute Shipping Charge': disputeShippingCharge,
                    'GST Type Dispute': gstTypeDispute,
                    'Total GST Amount': totalGstAmountDispute,
                    'Net Adjustment': disputeInfo.netAdjustment,
                    'Dispute Type': disputeInfo.type,
                    'Dispute Reason': disputeInfo.reason
                };

                if (s.status === 'Cancelled') {
                    cancelledData.push(row);
                } else {
                    activeData.push(row);
                }
            }
        });

        // Sort both datasets by Status Date (Descending)
        const sortByStatusDate = (a, b) => new Date(b['Status Date']) - new Date(a['Status Date']);
        activeData.sort(sortByStatusDate);
        cancelledData.sort(sortByStatusDate);

        // Create Workbook with Multiple Sheets
        const wb = XLSX.utils.book_new();

        // Sheet 1: Active Shipments
        const wsActive = XLSX.utils.json_to_sheet(activeData);
        if (activeData.length > 0) {
            const wscols = Object.keys(activeData[0]).map(() => ({ wch: 20 }));
            wsActive['!cols'] = wscols;
        }
        XLSX.utils.book_append_sheet(wb, wsActive, "Active Shipments");

        // Sheet 2: Cancelled Shipments
        const wsCancelled = XLSX.utils.json_to_sheet(cancelledData);
        if (cancelledData.length > 0) {
            const wscols = Object.keys(cancelledData[0]).map(() => ({ wch: 20 }));
            wsCancelled['!cols'] = wscols;
        }
        XLSX.utils.book_append_sheet(wb, wsCancelled, "Cancelled Shipments");

        const filename = userId
            ? `financials_${users[0]?.customerId || 'customer'}.xlsx`
            : "shipment_financials_full.xlsx";

        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.header('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get financial details for all shipments across all customers
// @route   GET /api/admin/finance/all-shipments
// @access  Private/SuperAdmin
const getAllShipmentsFinance = async (req, res) => {
    try {
        const [users, shipments] = await Promise.all([
            User.find({}).select('name customerId markupPercentage tag'),
            Shipment.find({})
                .select('shipmentId user serviceDetails invoice createdAt paymentMode status shipperDetails consigneeDetails trackingHistory')
                .sort({ createdAt: -1 })
                .lean()
        ]);

        const userMap = new Map();
        users.forEach(u => {
            let effectiveMarkup = u.markupPercentage || 20;
            if (u.tag) {
                const tag = String(u.tag).toLowerCase();
                if (tag.includes('gold') || tag === 'd95679752134a2d9eb61dbd7b91c4bcc') effectiveMarkup = 16;
                else if (tag.includes('platinum') || tag === '5c7f383122c4a923d34d3f3511d1377e') effectiveMarkup = 12;
                else if (tag.includes('silver') || tag === 'e034fb6b66aacc1d48f445ddfb08da98') effectiveMarkup = 20;
            }
            userMap.set(String(u._id), { name: u.name, customerId: u.customerId, markup: effectiveMarkup });
        });

        const formattedShipments = shipments.map(s => {
            const user = userMap.get(String(s.user));
            if (!user) return null;

            // Determine Status Date (Delivery date if delivered, else booking date)
            let statusDate = s.createdAt;
            if (s.status === 'Delivered' && s.trackingHistory?.length > 0) {
                const deliveryEvent = [...s.trackingHistory].reverse().find(h =>
                    h.status === 'Delivered' ||
                    (h.description && h.description.toLowerCase().includes('delivered'))
                );
                if (deliveryEvent && deliveryEvent.timestamp) {
                    statusDate = deliveryEvent.timestamp;
                }
            }

            const financials = calculateFinancials(s, user.markup);
            return {
                shipmentId: s.shipmentId,
                customerName: user.name,
                customerId: user.customerId,
                pickup: `${s.shipperDetails?.city}, ${s.shipperDetails?.country}`,
                delivery: `${s.consigneeDetails?.city}, ${s.consigneeDetails?.country}`,
                serviceType: s.serviceDetails?.serviceName,
                bookingDate: s.createdAt,
                statusDate: statusDate,
                status: s.status || 'Pending',
                shipmentCost: financials.totalCost,
                actualPrice: financials.baseCost, // Changed to show only base cost
                countrySurcharge: financials.countrySurcharge,
                fuelSurcharge: financials.fuelSurcharge,
                profit: financials.profit,
                gstAmount: financials.gstAmount,
                paymentMethod: s.paymentMode || 'Wallet'
            };
        }).filter(Boolean);

        res.json(formattedShipments);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getFinanceSummary,
    getCustomerFinanceDetails,
    exportFinanceData,
    getAllShipmentsFinance
};
