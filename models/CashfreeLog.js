const mongoose = require("mongoose");

const cashfreeLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Partner",
      index: true,
    },

    orderId: {
      type: String,
      required: true,
    },

    paymentSessionId: {
      type: String,
      default: null,
    },

    cfOrderId: {
      type: String,
      default: null,
    },

    action: {
      type: String,
      enum: [
        "ORDER_CREATED",
        "ORDER_VERIFIED",
        "PAYMENT_SUCCESS",
        "PAYMENT_FAILED",
        "ERROR",
      ],
      required: true,
    },

    success: {
      type: Boolean,
      required: true,
    },

    amount: {
      type: Number,
      default: 0,
    },

    currency: {
      type: String,
      default: "INR",
    },

    enviroment: {
      type: String,
      enum: ["SANDBOX", "PRODUCTION"],
      default: "SANDBOX",
    },

    status: {
      type: String,
      default: null,
    },

    paymentStatus: {
      type: String,
      default: null,
    },

    customer: {
      customerId: {
        type: String,
        default: null,
      },
      name: {
        type: String,
        default: null,
      },
      email: {
        type: String,
        default: null,
      },
      phone: {
        type: String,
        default: null,
      },
    },

    balanceAfter: {
      type: Number,
      default: null,
    },

    notes: {
      type: String,
      default: null,
    },

    walletAmount: {
      type: Number,
    },

    processingFee: {
      type: Number,
    },

    totalPaid: {
      type: Number,
    },

    country: {
      type: String,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
cashfreeLogSchema.index({ user: 1, createdAt: -1 });
cashfreeLogSchema.index({ orderId: 1 });
cashfreeLogSchema.index({ orderId: 1, action: 1 });

module.exports = mongoose.model("CashfreeLog", cashfreeLogSchema);