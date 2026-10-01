const dns = require('dns');

// Configure DNS resolution safely for both Windows local dev & production servers
try {
    if (dns.setDefaultResultOrder) {
        dns.setDefaultResultOrder('ipv4first');
    }
} catch (err) {
    // Ignore DNS ordering errors on unsupported Node versions
}

const path = require('path');
const dotenv = require('dotenv');

// Load env vars before anything else
dotenv.config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const compression = require('compression'); // Production Optimization
const helmet = require('helmet').default || require('helmet'); // Production Security
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const ratesRoutes = require('./routes/rates');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { redisConfig } = require('./config/redisConfig');
const Redis = require('ioredis');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const addressRoutes = require('./routes/addressRoutes');

const app = express();
app.set('trust proxy', 1); // Trust first level of proxy (AWS ALB/Nginx)
const server = http.createServer(app);

const requiredEnvVars = ['JWT_SECRET', 'MONGO_URI'];
const missingCriticalEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingCriticalEnvVars.length > 0) {
    throw new Error(`Missing critical environment variables: ${missingCriticalEnvVars.join(', ')}`);
}

const io = new Server(server, {
    cors: {
        origin: true,
        methods: ["GET", "POST", "PUT", "DELETE"],
        credentials: true
    }
});

// Setup Redis Adapter for scalable Socket.io
if (process.env.BYPASS_REDIS !== 'true') {
    const pubClient = new Redis(redisConfig);
    const subClient = pubClient.duplicate();

    pubClient.on('error', (err) => console.error('Redis PubClient Error:', err && typeof err === 'object' && 'message' in err ? err.message : err));
    subClient.on('error', (err) => console.error('Redis SubClient Error:', err && typeof err === 'object' && 'message' in err ? err.message : err));

    io.adapter(createAdapter(pubClient, subClient));
} else {
    console.warn('Redis adapter bypassed because BYPASS_REDIS=true.');
}

// Socket.io Connection Logic & Handshake Security
io.use((socket, next) => {
    try {
        const rawHeader = socket.handshake?.headers?.authorization;
        const token = socket.handshake?.auth?.token || (rawHeader && rawHeader.startsWith('Bearer ') ? rawHeader.split(' ')[1] : null);
        if (token) {
            const { verifyJwtToken } = require('./middleware/securityHelpers');
            socket.user = verifyJwtToken(token);
        }
        next();
    } catch (err) {
        next(); // Safe fallback so existing UI sockets remain non-breaking
    }
});

io.on('connection', (socket) => {
    socket.on('join_room', (room) => {
        socket.join(room);
    });

    socket.on('disconnect', () => { });
});

// Getter for background workers
const getIO = () => io;

// Make io accessible to routes
app.set('io', io);

const baseAllowedCorsOrigins = [
    "http://localhost:5173", "http://127.0.0.1:5173",
    "http://localhost:5174", "http://127.0.0.1:5174",
    "http://localhost:5175", "http://127.0.0.1:5175",
    "http://localhost:3000", "http://127.0.0.1:3000",
    "https://express.thedflgroup.com",
    "https://admin.thedflgroup.com",
    "https://franchise.thedflgroup.com",
    "https://partner.thedflgroup.com",
    "https://thedflexpress.com",
    "https://www.thedflexpress.com",
    "https://thedflexpress.in",
    "https://www.thedflexpress.in",
    "http://3.108.86.176",
    "http://dflexp.in",
    "https://dflexp.in",
    "http://www.dflexp.in",
    "https://www.dflexp.in"
];

// Dynamically collect origins from environment variables for Customer, Admin, and Franchise EC2s
const envOrigins = [
    process.env.CLIENT_URL,
    process.env.FRONTEND_URL,
    process.env.CUSTOMER_PORTAL_URL,
    process.env.ADMIN_PORTAL_URL,
    process.env.FRANCHISE_PORTAL_URL,
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()) : [])
].filter(Boolean);

const allowedCorsOrigins = Array.from(new Set([...baseAllowedCorsOrigins, ...envOrigins]));

const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    if (allowedCorsOrigins.includes(origin)) return true;
    // Allow subdomain matching for trusted company domains
    const trustedDomainPattern = /^https?:\/\/([a-zA-Z0-9-]+\.)*(thedflgroup\.com|thedflexpress\.com|thedflexpress\.in|dflexp\.in)(:\d+)?$/;
    if (trustedDomainPattern.test(origin)) return true;
    return false;
};

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps, curl, or server-to-server)
        if (!origin || isAllowedOrigin(origin)) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "x-finance-token",
        "sb_token",
        "admin_token",
        "x-api-key",
        "x-partner-request-id",
        "x-request-id",
        "x-sandbox-scenario",
        "idempotency-key"
    ]
}));

// --- Production Optimizations ---
app.use(compression()); // Gzip compression
app.use(helmet({
    crossOriginResourcePolicy: false, // Allow loading resources (images/pdfs) from this API
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "frame-ancestors": ["'self'", "http://localhost:5173", "http://dflexp.in", "https://dflexp.in", "http://www.dflexp.in", "https://www.dflexp.in", "http://3.108.86.176", "http://localhost:5174", "https://*.thedflgroup.com", "https://*.thedflexpress.com", "https://*.thedflexpress.in"],
        },
    },
    frameguard: false, // Allow framing to support PDF preview in Admin Dashboard
}));
// --------------------------------

const cronManager = require('./utils/cronManager');

// IMPORTANT: Shopify webhook routes need raw body — must be BEFORE express.json()
app.use('/api/shopify/webhooks', express.raw({ type: 'application/json' }), require('./routes/shopifyWebhookRoutes'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

// Intercept and verify incoming host headers for authorized domain lock (with in-memory throttling)
let lastVerifiedHost = '';
let lastVerifiedTimestamp = 0;
const HOST_VERIFY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes cache

app.use((req, res, next) => {
    const host = req.headers.host || req.hostname;
    const now = Date.now();
    if (cronManager.isAllowedHost(host)) {
        const cleanHost = cronManager.normalizeHost(host);
        if (cleanHost !== lastVerifiedHost || (now - lastVerifiedTimestamp) > HOST_VERIFY_INTERVAL_MS) {
            lastVerifiedHost = cleanHost;
            lastVerifiedTimestamp = now;
            cronManager.verifyHostFromRequest(host).catch((err) => {
                console.error('[CronManager] Error verifying host:', err?.message || err);
            });
        }
    }
    next();
});
app.get('/api/healthcheck', (req, res) => {
    res.json({ message: 'Server is working fine' });
});

// Serve static files from the uploads directory
app.use('/uploads', express.static('uploads'));
app.use('/manifest-labels', express.static(path.join(__dirname, 'public/manifest-labels')));
app.use('/stickers', express.static(path.join(__dirname, 'public/stickers')));
app.use('/labels', express.static(path.join(__dirname, 'public/labels')));

app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/careers', require('./routes/careerRoutes'));
app.use('/api/admin/careers', require('./routes/adminCareerRoutes'));
app.use('/api/partners', require('./routes/partnerRoutes'));
app.use('/api/developer', require('./routes/developerRoutes'));
app.use('/api/admin/developer-hub', require('./routes/adminDeveloperHubRoutes'));
app.use('/api/v1/partner', require('./routes/partnerApiRoutes'));
app.use('/api/addresses', addressRoutes);
app.use('/api/admin/rates', require('./routes/rateCardRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/admin/report-recipients', require('./routes/reportRecipientRoutes'));
app.use('/api/shipments', require('./routes/shipmentRoutes'));
app.use('/api/client/shipments', require('./routes/clientShipmentRoutes'));
app.use('/api/quotes', require('./routes/quoteRoutes'));
app.use('/api/payments', require('./routes/paymentRoutes'));
app.use('/api/manifests', require('./routes/manifestRoutes'));
app.use('/api/bulk', require('./routes/bulkRoutes'));
app.use('/api/contact', require('./routes/contactRoutes'));
app.use('/api/drafts', require('./routes/draftRoutes'));
app.use('/api/disputes', require('./routes/disputeRoutes'));
app.use('/api/prospects', require('./routes/prospectRoutes'));
app.use('/api/analytics', require('./routes/analyticsRoutes'));
app.use('/api/admin/finance', require('./routes/admin/financeRoutes'));
app.use('/api/admin/reports/csbv', require('./routes/admin/csbvReportRoutes'));
app.use('/api/admin/shipping-bills', require('./routes/admin/shippingBillRoutes'));
app.use('/api/admin/reports/daily', require('./routes/admin/dailyReportRoutes'));
app.use('/api/ports', require('./routes/portRoutes'));
app.use('/api/rates', ratesRoutes);
app.use('/api/tickets', require('./routes/ticketRoutes'));
app.use('/api/config', require('./routes/configRoutes'));
app.use('/api/uk-economy', require('./routes/ukEconomyRoutes'));
app.use('/api/willow', require('./routes/willowConfigRoutes'));
app.use('/api/admin/currency-rates', require('./routes/currencyRateRoutes'));
app.use('/api/ebay-auth', require('./routes/ebayAuthRoutes'));
app.use('/api/chatbot', require('./routes/chatbotRoutes'));
app.use('/api/ebay-orders', require('./routes/ebayOrderRoutes'));
app.use('/api/ebay-shipments', require('./routes/ebayShipmentRoutes'));
app.use('/api/ebay-tracking', require('./routes/ebayTrackingRoutes'));
app.use('/api/ebay-compliance', require('./routes/ebayComplianceRoutes'));
app.use('/api/marketplace', require('./routes/marketplaceRoutes'));
app.use('/api/shopify', require('./routes/shopifyRoutes'));
app.use('/api/whatsapp', require('./routes/whatsappWebhookRoutes'));
app.use('/api/admin/pickup', require('./routes/pickupRoutes'));
app.use('/api/pickup', require('./routes/pickupRoutes'));
app.use('/api/admin/hub-receiving', require('./routes/hubReceivingRoutes'));
app.use('/api/hub-receiving', require('./routes/hubReceivingRoutes'));
app.use('/api/amazon-auth', require('./routes/amazonAuthRoutes'));
app.use('/api/amazon', require('./routes/amazonRoutes'));
app.use('/api/amazon-orders', require('./routes/amazonOrderRoutes'));
app.use('/api/envia', require('./routes/envia/enviaRoutes'));

// Zoho Test Route
// app.use('/api', require('./routes/test')); // Route missing, commented out to fix crash
// Health check
app.get('/', (req, res) => {
    res.send('SpeedBox Microservice is running');
});

// Initialize Workers & Schedulers only outside tests to avoid open handles in Jest
if (process.env.NODE_ENV !== 'test') {
    if (process.env.RUN_WORKERS === 'false') {
        console.log('[Server] RUN_WORKERS=false: Background workers decoupled. Web API running in high-performance HTTP mode.');
    } else {
        // BullMQ Background Workers
        require('./workers/emailWorker');
    require('./workers/bulkBookingWorker');
    require('./workers/whatsappBulkWorker');
    require('./workers/ticketEscalationWorker');
    require('./workers/developerCredentialExpiryWorker');
    require('./workers/livePartnerOutboxPublisherWorker');
    require('./workers/livePartnerBookingWorker');
    require('./workers/carrierReconciliationWorker');
    require('./workers/walletReconciliationWorker');
    require('./workers/tplAutomationWorker');
    require('./workers/rsaSkynetAutomationWorker');
    require('./workers/ebayWorker');

    // Cron Jobs & Schedulers
    const { setupCurrencyRateCron } = require('./jobs/currencyRateJob');
    setupCurrencyRateCron();

    const { setupPickupReportCron } = require('./workers/pickupReportWorker');
    setupPickupReportCron();

    const { setupDailyBookingSummaryCron } = require('./workers/dailyBookingSummaryWorker');
    setupDailyBookingSummaryCron();

    const { setupDailyReportCron } = require('./workers/dailyReportWorker');
    setupDailyReportCron();

    const { setupShipmentDelayCron } = require('./workers/shipmentDelayWorker');
    setupShipmentDelayCron();

    const etsyTrackingSyncWorker = require('./workers/etsyTrackingSyncWorker');
    if (etsyTrackingSyncWorker && typeof etsyTrackingSyncWorker.start === 'function') {
        etsyTrackingSyncWorker.start();
    }

    const shopifyTrackingSyncWorker = require('./workers/shopifyTrackingSyncWorker');
    if (shopifyTrackingSyncWorker && typeof shopifyTrackingSyncWorker.start === 'function') {
        shopifyTrackingSyncWorker.start();
    }

    // Inline Cron: Admin OTP Cleanup every 15 minutes
    const cron = require('node-cron');
    const Admin = require('./models/Admin');
    cron.schedule('*/15 * * * *', async () => {
        try {
            const result = await Admin.updateMany(
                {
                    otp: { $exists: true, $ne: null },
                    $or: [{ otpExpires: { $lt: new Date() } }, { otpExpires: { $exists: false } }]
                },
                { $unset: { otp: "", otpExpires: "" } }
            );
            if (result.modifiedCount > 0) {
                console.log(`[Cron] Cleared expired OTPs from ${result.modifiedCount} admin accounts.`);
            }
        } catch (err) {
            console.error('[Cron] Admin OTP Cleanup Error:', err.message);
        }
    });

    // Periodic eBay order auto-sync every 30 minutes
    cron.schedule('*/30 * * * *', async () => {
        try {
            const MarketplaceAccount = require('./models/MarketplaceAccount');
            const ebayOrderService = require('./services/ebayOrderService');

            const activeEbayAccounts = await MarketplaceAccount.find({
                platform: 'eBay',
                isActive: true,
                status: 'Connected'
            }).lean();

            for (const account of activeEbayAccounts) {
                try {
                    await ebayOrderService.importOrders(account.userId);
                } catch (err) {
                    console.error(`[eBay Cron] Sync error for user ${account.userId}:`, err.message);
                }
            }
        } catch (cronErr) {
            console.error('[eBay Cron] Scheduler error:', cronErr.message);
        }
    });
    }
}

app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ success: false, message: 'File is too large. Please upload images smaller than 10MB.' });
    }
    if (err && err.status === 413) {
        return res.status(413).json({ success: false, message: 'Total upload size is too large. Please compress your images.' });
    }
    next(err);
});

// Main Server Execution
const startServer = async () => {
    const preferredPort = Number(process.env.PORT || 5001);

    await connectDB().catch(error => {
        console.error('Fatal: Persistent MongoDB connection failure:', error);
    });

    await cronManager.initCronState().catch(err => {
        console.error('[CronManager] Initialization warning:', err?.message || err);
    });

    const listenPort = (port) => {
        const onError = (error) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
                console.error(`Fatal: Port ${port} is already in use. Please kill the process using this port and try again.`);
                process.exit(1);
            } else {
                console.error('Server error:', error);
                process.exit(1);
            }
        };

        const onListening = () => {
            server.removeListener('error', onError);
            console.log(`Server listening on port ${port}`);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port);
    };

    if (process.env.NODE_ENV !== 'test') {
        listenPort(preferredPort);
    }

    if (process.env.NODE_ENV === 'production') {
        try {
            require('./utils/developerCredentialCrypto').getPepper();
        } catch (e) {
            console.error('[Security] Failed to initialize pepper:', e.message);
        }
    }

    // Startup Validation: Redis Health Check
    const { checkHealth } = require('./config/redisConfig');
    const redisStatus = await checkHealth();
    if (!redisStatus.ok && process.env.BYPASS_REDIS !== 'true') {
        console.error('FATAL: Redis is required but unavailable.');
        console.error('Error:', redisStatus.message);
        console.error('To run without Redis, set BYPASS_REDIS=true in .env');
        process.exit(1);
    }
};

// Global unhandled error guards to prevent unexpected crashes or silent blockage
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception thrown:', err);
});

// Graceful shutdown on process termination
const handleGracefulShutdown = (signal) => {
    console.log(`[Process] Received ${signal}. Gracefully shutting down server...`);
    if (server.listening) {
        server.close(async () => {
            console.log('[Process] HTTP/WebSocket server closed.');
            try {
                const mongoose = require('mongoose');
                await mongoose.connection.close(false);
                console.log('[Process] MongoDB connection closed.');
            } catch (closeErr) {
                console.error('[Process] Error closing DB connection:', closeErr.message);
            }
            process.exit(0);
        });
        setTimeout(() => {
            console.error('[Process] Forcefully exiting after shutdown timeout.');
            process.exit(1);
        }, 10000).unref();
    } else {
        process.exit(0);
    }
};

process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));

if (process.env.NODE_ENV !== 'test') {
    startServer();
}

module.exports = { app, server, io, getIO };

