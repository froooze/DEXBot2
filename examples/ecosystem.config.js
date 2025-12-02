/**
 * PM2 ecosystem configuration (example)
 *
 * Add a new entry in `apps` for each bot instance you want to run, or use the pm2 CLI
 * to start instances based on these templates.
 *
 * Each app runs ./modules/bot.js inside the project root; pm2 will set environment variables
 * which your bot can read to pick the market, instance number and config.
 */

module.exports = {
  apps: [
    // Example placeholder. Duplicate and customize for each bot (or use process manager to launch with args).
    {
      name: "01-BTC-USD",
  script: "./modules/bot.js",
      cwd: "./",
      max_memory_restart: "300M",
      watch: false,
      autorestart: true,
      // set error/out files to an absolute path appropriate for your host
      error_file: "/var/log/DEXBot2/01-BTC-USD-error.log",
      out_file: "/var/log/DEXBot2/01-BTC-USD-out.log",
      log_date_format: "YY-MM-DD HH:mm:ss.SSS",
      merge_logs: false,
      combine_logs: true,
      env: {
        NODE_ENV: "production",
        BOT_NUMBER: "01",
        MARKET: "BTC-USD",
        // If you want, set PREFERRED_ACCOUNT to the account name as known in profiles/bots.json
        PREFERRED_ACCOUNT: "test-account"
      },
      max_restarts: 13,
      min_uptime: 86400000,
      restart_delay: 3000
    }
  ]
};
