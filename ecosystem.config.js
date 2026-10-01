module.exports = {
  apps: [
    {
      name: 'dfl-web-api',
      script: './server.js',
      instances: 'max', // Scale across all available CPU cores for HTTP traffic
      exec_mode: 'cluster',
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 5001,
        RUN_WORKERS: 'false' // Disables background jobs on web threads so APIs remain snappy (<30ms)
      }
    },
    {
      name: 'dfl-workers',
      script: './workers/workerServer.js',
      instances: 1, // Single dedicated worker instance prevents duplicate cron triggers & race conditions
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '1.5G',
      env: {
        NODE_ENV: 'production',
        ROLE: 'worker'
      }
    }
  ]
};
