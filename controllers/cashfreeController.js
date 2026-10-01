const axios = require("axios");
const crypto = require("crypto");
const { logActivity } = require('../utils/activityLogger');
const User = require("../models/User");
const CashfreeLog = require("../models/CashfreeLog");
const PaymentRequest = require("../models/PaymentRequest");
const Transaction = require("../models/Transaction");

const cashfreeConfig = {
  appId: process.env.CASHFREE_APP_ID,
  secretKey: process.env.CASHFREE_SECRET_KEY,
  env: process.env.CASHFREE_ENV || "SANDBOX",
};

const getBaseUrl = () => {
  return cashfreeConfig.env === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
};

// Safe error formatter to prevent leaking Axios config headers or keys
const getSafeErrorMessage = (error) => {
  if (!error) return "An unexpected error occurred";
  if (error.response?.data?.message) {
    return String(error.response.data.message);
  }
  return String(error.message || "An unexpected error occurred");
};

const previewFee = async (req, res) => {
  try {
    const { amount } = req.query;
    if (!amount || isNaN(Number(amount)) || Number(amount) < 1) {
      return res.status(400).json({ message: "Invalid amount" });
    }

    const userId = req.user?._id || req.partner?._id;
    if (!userId) {
      return res.status(401).json({ message: "Not authorized" });
    }

    const isPartner = !!req.partner;
    const Partner = require('../models/Partner');
    const user = isPartner ? await Partner.findById(userId) : await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const country = isPartner ? "India" : (user?.kycData?.billingAddress?.country || "");
    const isIndian = country.toLowerCase() === "india";
    
    let walletAmount = Number(amount);
    let processingFee = 0;
    
    let feePercentage = 2.39;
    try {
        const config = await require('../models/SystemConfig').findOne({ key: 'cashfreeProcessingFee' });
        if (config && config.value !== undefined) {
            feePercentage = Number(config.value);
        }
    } catch (err) {
        // Silently handle error to avoid logs leak
    }
    
    if (!user?.exemptFromCashfreeFee) {
      processingFee = walletAmount * (feePercentage / 100);
    }
    const totalPaid = walletAmount + processingFee;

    res.json({
      walletAmount,
      processingFee: Number(processingFee.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      country,
      isIndian,
      feePercentage
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "Server Error", 
      error: getSafeErrorMessage(error)
    });
  }
};

const createOrder = async (req, res) => {
  try {
    const { amount, paymentMethod } = req.body;

    if (!amount || isNaN(Number(amount)) || Number(amount) < 100) {
      return res
        .status(400)
        .json({ success: false, message: "Amount must be at least 100." });
    }

    const userId = req.user?._id || req.partner?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const isPartner = !!req.partner;
    const Partner = require('../models/Partner');
    const user = isPartner ? await Partner.findById(userId) : await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const orderId = `CF_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const cleanPhone = user?.phone ? String(user.phone).replace(/\D/g, "").slice(-10) : "";
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ message: "A valid 10-digit phone number is required to create a payment order." });
    }
    const finalPhone = cleanPhone;

    const returnUrl = req.headers?.origin
      ? `${req.headers.origin}/recharge?tab=history&source=cashfree&order_id={order_id}`
      : `${process.env.FRONTEND_URL || "http://localhost:5173"}/recharge?tab=history&source=cashfree&order_id={order_id}`;

    const country = isPartner ? "India" : (user?.kycData?.billingAddress?.country || "");
    
    let walletAmount = Number(amount);
    let processingFee = 0;
    
    let feePercentage = 2.39;
    try {
        const config = await require('../models/SystemConfig').findOne({ key: 'cashfreeProcessingFee' });
        if (config && config.value !== undefined) {
            feePercentage = Number(config.value);
        }
    } catch (err) {
        // Silently handle error
    }
    
    if (!user?.exemptFromCashfreeFee) {
      processingFee = walletAmount * (feePercentage / 100);
    }
    
    const totalPaid = walletAmount + processingFee;

    const requestData = {
      order_amount: Number(totalPaid.toFixed(2)),
      order_currency: "INR",
      order_id: orderId,
      customer_details: {
        customer_id: user?._id?.toString() || "",
        customer_phone: finalPhone,
        customer_email: user?.email || "customer@dfl.in",
        customer_name: user?.name || user?.companyName || user?.ownerName || "Customer",
      },
      order_meta: {
        return_url: returnUrl,
        payment_methods: paymentMethod === 'card' ? "cc,dc" : paymentMethod === 'upi' ? "upi" : paymentMethod === 'nb' ? "nb" : ""
      }
    };

    const response = await axios.post(`${getBaseUrl()}/orders`, requestData, {
      headers: {
        "x-client-id": cashfreeConfig.appId,
        "x-client-secret": cashfreeConfig.secretKey,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json",
      },
    });

    await CashfreeLog.create({
      user: isPartner ? undefined : userId,
      partnerId: isPartner ? userId : undefined,
      orderId,
      cfOrderId: response?.data?.order_id || null,
      paymentSessionId: response?.data?.payment_session_id || null,
      action: "ORDER_CREATED",
      success: true,
      amount: Number(totalPaid.toFixed(2)),
      currency: "INR",
      enviroment: cashfreeConfig.env,
      status: response?.data?.order_status || "CREATED",
      customer: {
        customerId: user?._id?.toString() || "",
        name: user?.name || user?.companyName || user?.ownerName || "Customer",
        email: user?.email || null,
        phone: finalPhone,
      },
      walletAmount: Number(walletAmount.toFixed(2)),
      processingFee: Number(processingFee.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      country: country,
    });

    res.json({
      payment_session_id: response?.data?.payment_session_id,
      order_id: orderId,
      env: cashfreeConfig.env.toLowerCase(),
    });
  } catch (error) {
    try {
      const isPartner = !!req.partner;
      await CashfreeLog.create({
        user: isPartner ? undefined : (req.user?._id || null),
        partnerId: isPartner ? req.partner?._id : undefined,
        orderId: `CF_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        action: "ERROR",
        success: false,
        amount: req.body?.amount || 0,
        currency: "INR",
        enviroment: cashfreeConfig.env,
      });
    } catch (e) {
      // Avoid crash on error logging
    }

    res.status(500).json({ 
      success: false, 
      message: "Failed to create payment session", 
      error: getSafeErrorMessage(error)
    });
  }
};

const verifyOrder = async (req, res) => {
  try {
    const { order_id } = req.body;
    if (!order_id) {
      return res.status(400).json({ success: false, message: "Order ID is required" });
    }

    const userId = req.user?._id || req.partner?._id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }
    const isPartner = !!req.partner;
    const Partner = require('../models/Partner');

    const response = await axios.get(`${getBaseUrl()}/orders/${order_id}`, {
      headers: {
        "x-client-id": cashfreeConfig.appId,
        "x-client-secret": cashfreeConfig.secretKey,
        "x-api-version": "2022-09-01",
      },
    });

    const orderData = response?.data;
    if (!orderData) {
      return res.status(404).json({ success: false, message: "Order data not found from gateway" });
    }

    let paymentSessionId = orderData?.payment_session_id;
    if (!paymentSessionId) {
      const originalLog = await CashfreeLog.findOne({ orderId: order_id, action: "ORDER_CREATED" });
      if (originalLog) {
        paymentSessionId = originalLog?.paymentSessionId;
      }
    }

    const user = isPartner ? await Partner.findById(userId) : await User.findById(userId);
    const cleanPhone = user?.phone ? String(user.phone).replace(/\D/g, "").slice(-10) : null;
    const finalPhone = cleanPhone && cleanPhone.length === 10 ? cleanPhone : null;

    const customerDetails = {
      customerId: user ? (user.customerId || user.partnerCode) : userId.toString(),
      name: user?.name || user?.companyName || user?.ownerName || "Customer",
      email: user?.email || null,
      phone: finalPhone,
    };

    let originalLog = await CashfreeLog.findOne({ orderId: order_id, action: "ORDER_CREATED" });
    const walletAmount = originalLog ? originalLog.walletAmount : (orderData?.order_amount || 0);
    const processingFee = originalLog ? originalLog.processingFee : 0;
    const totalPaid = originalLog ? originalLog.totalPaid : (orderData?.order_amount || 0);
    const country = originalLog ? originalLog.country : "";

    await CashfreeLog.findOneAndUpdate(
      { orderId: order_id },
      {
        $set: {
          user: isPartner ? undefined : userId,
          partnerId: isPartner ? userId : undefined,
          cfOrderId: orderData?.cf_order_id || null,
          action: "ORDER_VERIFIED",
          success: true,
          amount: orderData?.order_amount || 0,
          currency: orderData?.order_currency || "INR",
          enviroment: cashfreeConfig.env,
          status: orderData?.order_status || "PENDING",
          customer: customerDetails,
          walletAmount,
          processingFee,
          totalPaid,
          country
        }
      },
      { new: true, upsert: true }
    );

    if (orderData?.order_status === "PAID") {
      const existingPayment = await PaymentRequest.findOne({
        orderId: order_id,
      });
      if (existingPayment) {
        return res.json({
          message: "Payment already verified",
          payment: {
            orderId: existingPayment?.orderId,
            amount: existingPayment?.amount,
            status: existingPayment?.status
          },
        });
      }

      let methodSymbol = '';
      const group = orderData?.payment_group || (orderData?.payment_method && typeof orderData.payment_method === 'string' ? orderData.payment_method : '');
      if (group) {
        const g = String(group).toLowerCase();
        if (g.includes('card')) methodSymbol = 'CC';
        else if (g.includes('upi')) methodSymbol = 'U';
        else if (g.includes('net_banking') || g.includes('nb')) methodSymbol = 'NB';
      }
      const bankNameString = methodSymbol ? `CashFree Online (${methodSymbol})` : "CashFree Online";

      const newPayment = await PaymentRequest.create({
        ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: userId }),
        orderId: order_id,
        amount: walletAmount,
        processingFee: processingFee,
        totalPaid: totalPaid,
        transactionId: `CF_AUTO_${Date.now()}`,
        paymentDate: new Date(),
        proofUrl: "CASHFREE_AUTO",
        fileType: "auto",
        status: "Completed",
        paymentMode: "Cashfree",
        remarks: "Online Recharge (Cashfree)",
        senderBankName: bankNameString,
        senderAccountName: user?.name || user?.companyName || user?.ownerName || "Customer",
      });

      if (user) {
        user.walletBalance = (user.walletBalance || 0) + walletAmount;
        await user.save();

        await CashfreeLog.findOneAndUpdate(
          { orderId: order_id },
          {
            $set: {
              action: "PAYMENT_SUCCESS",
              success: true,
              status: orderData?.order_status,
              paymentStatus: orderData?.order_status,
              balanceAfter: user.walletBalance,
              notes: "Wallet credited successfully",
            }
          },
          { new: true }
        );

        await Transaction.create({
          ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
          amount: walletAmount,
          type: "credit",
          description: `Wallet Recharge: Cashfree`,
          referenceId: user._id.toString(),
          status: "success",
          balanceAfter: user.walletBalance,
          performedByModel: "System",
          walletAmount,
          processingFee,
          totalPaid,
          country
        });

        await logActivity(null, {
            action: 'WALLET_RECHARGE_SUCCESS',
            targetModel: 'System',
            details: { amount: walletAmount, orderId: order_id },
            actor: user
        });
      }

      return res.json({
        message: "Payment verified and wallet credited successfully",
        payment: {
          orderId: newPayment?.orderId,
          amount: newPayment?.amount,
          status: newPayment?.status
        },
      });
    } else {
      await CashfreeLog.findOneAndUpdate(
        { orderId: order_id },
        {
          $set: {
            action: "PAYMENT_FAILED",
            success: false,
            status: orderData?.order_status || "FAILED",
            paymentStatus: orderData?.order_status || "FAILED",
            notes: "Payment not completed",
          }
        },
        { new: true }
      );

      return res.status(400).json({
        success: false,
        message: "Payment not successful yet",
        status: orderData?.order_status,
      });
    }
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      message: "Failed to verify payment",
      error: getSafeErrorMessage(error)
    });
  }
};

const webhookHandler = async (req, res) => {
    try {
        const signature = req.headers?.['x-webhook-signature'];
        const timestamp = req.headers?.['x-webhook-timestamp'];
        const body = req.rawBody || JSON.stringify(req.body);

        if (!signature || !timestamp || !body) {
            return res.status(400).send('Webhook error: Missing required headers or body');
        }

        const expectedSignature = crypto
            .createHmac('sha256', cashfreeConfig.secretKey)
            .update(timestamp + body)
            .digest('base64');

        if (expectedSignature !== signature) {
            return res.status(400).send('Webhook signature verification failed');
        }

        const payload = req.body;
        const { event_time, type, data } = payload || {};
        
        if (type !== 'PAYMENT_SUCCESS_WEBHOOK') {
             return res.status(200).send('Webhook received but ignored');
        }

        const paymentData = data?.payment;
        const orderData = data?.order;
        const orderId = orderData?.order_id;

        if (!orderId) {
             return res.status(400).send('Webhook error: Missing order ID');
        }

        const existingPayment = await PaymentRequest.findOne({ orderId });
        if (existingPayment) {
             return res.status(200).send('Webhook processed');
        }

        const originalLog = await CashfreeLog.findOne({ orderId, action: "ORDER_CREATED" });
        if (!originalLog) {
             return res.status(404).send('Original order log not found');
        }
        
        const walletAmount = originalLog?.walletAmount || 0;
        const processingFee = originalLog?.processingFee || 0;
        const totalPaid = originalLog?.totalPaid || 0;
        const country = originalLog?.country || "";
        
        const Partner = require('../models/Partner');
        const isPartner = !!originalLog?.partnerId;
        const user = isPartner ? await Partner.findById(originalLog.partnerId) : await User.findById(originalLog?.user);
        if (!user) {
             return res.status(404).send('User not found');
        }

        const paymentGroup = paymentData?.payment_group;
        let methodSymbol = '';
        if (paymentGroup === 'credit_card' || paymentGroup === 'debit_card') methodSymbol = 'CC';
        else if (paymentGroup === 'upi') methodSymbol = 'U';
        else if (paymentGroup === 'net_banking') methodSymbol = 'NB';
        else if (paymentGroup) methodSymbol = String(paymentGroup).toUpperCase();

        const bankNameString = methodSymbol ? `CashFree Online (${methodSymbol})` : (paymentData?.payment_group || "CashFree Online");

        await PaymentRequest.create({
            ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
            orderId: orderId,
            amount: walletAmount,
            processingFee: processingFee,
            totalPaid: totalPaid,
            cfPaymentId: paymentData?.cf_payment_id || null,
            transactionId: paymentData?.bank_reference || `CF_AUTO_${Date.now()}`,
            paymentDate: event_time ? new Date(event_time) : new Date(),
            proofUrl: "CASHFREE_AUTO",
            fileType: "auto",
            status: "Completed",
            paymentMode: "Cashfree",
            remarks: "Online Recharge (Cashfree Webhook)",
            senderBankName: bankNameString,
            senderAccountName: user?.name || user?.companyName || user?.ownerName || "Customer",
        });

        user.walletBalance = (user?.walletBalance || 0) + walletAmount;
        await user.save();

        await Transaction.create({
            ...(isPartner ? { partnerId: user._id, walletOwnerId: user._id, walletOwnerType: 'Partner' } : { user: user._id }),
            amount: walletAmount,
            type: "credit",
            description: `Wallet Recharge: Cashfree`,
            referenceId: orderId,
            status: "success",
            balanceAfter: user.walletBalance,
            performedByModel: "System",
            walletAmount,
            processingFee,
            totalPaid,
            country
        });

        await CashfreeLog.findOneAndUpdate(
            { orderId },
            {
                $set: {
                    action: "PAYMENT_SUCCESS",
                    success: true,
                    status: "PAID",
                    paymentStatus: paymentData?.payment_status || "SUCCESS",
                    balanceAfter: user.walletBalance,
                    cfOrderId: orderData?.cf_order_id || null,
                    notes: "Wallet credited successfully via webhook",
                }
            },
            { new: true }
        );

        res.status(200).send('Webhook processed successfully');
    } catch (error) {
        res.status(500).send('Webhook processing error');
    }
};

module.exports = { createOrder, verifyOrder, previewFee, webhookHandler };
