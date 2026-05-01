module.exports = {
  apps: [
    {
      name:   'wa-sender',
      script: 'server.js',
    

      // Logs inside the app folder
      out_file:   './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time:       true,

      // Wait 10s after system boot before starting (gives OS time to fully load)
      wait_ready:     true,
      listen_timeout: 60000,  // 60s to become ready
      kill_timeout:   10000,  // 10s to gracefully stop

      // Restart behaviour
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      restart_delay: 8000,    // wait 8s before restarting after crash

      // Restart if app exceeds 500MB RAM
      max_memory_restart: '500M',

      env: {
        NODE_ENV: 'production',
        PORT:     3000,
        PWD:      './whatsapp',
      },
    },
  ],
};