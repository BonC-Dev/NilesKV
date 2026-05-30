/**
 * PM2 Ecosystem Config
 * Tells PM2 how to run the NilesKV API in production.
 */
module.exports = {
  apps: [
    {
      name:             'nileskv-api',
      script:           'server.js',
      instances:        1,
      exec_mode:        'fork',
      watch:            false,
      max_memory_restart: '400M',
      env_production: {
        NODE_ENV: 'production',
        PORT:     3000,
        DB_PATH:  '.db',
      },
      // Restart policy: if the app crashes, wait 5s before restarting.
      restart_delay:    5000,
      max_restarts:     10,
      // Log files on the server.
      out_file:         '/root/logs/nileskv-out.log',
      error_file:       '/root/logs/nileskv-error.log',
      merge_logs:       true,
      log_date_format:  'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
