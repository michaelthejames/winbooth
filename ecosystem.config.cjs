module.exports = {
  apps: [
    {
      name: 'parsec-server',
      script: 'C:\\Users\\pod\\winbooth\\start-parsec.bat',
      interpreter: 'none',  // Don't use Node interpreter
      watch: false,
      env: {
        NODE_ENV: 'development'
      }
    },
    {
      name: 'photo-booth-api',
      script: 'C:\\Users\\pod\\winbooth\\start-api.bat',
      interpreter: 'none',  // Don't use Node interpreter
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      }
    }
  ]
};