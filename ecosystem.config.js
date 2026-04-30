module.exports = {
  apps: [
    {
      name:   'wa-sender',
      script: './server.js',
 

      // Logs inside the app folder
      out_file:   './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time:       true,

      // Restart behaviour
      watch:         false,
      autorestart:   true,
      max_restarts:  10,
      restart_delay: 5000,

      // Restart if app exceeds 500MB RAM
      max_memory_restart: '500M',

      // Environment — NODE_APP_INSTANCE tells the app its own folder
      env: {
        NODE_ENV: 'production',
        PORT:     3000,
        // Force working directory so __dirname is always correct
        PWD:      './whatsapp',
      },
    },
  ],
};
