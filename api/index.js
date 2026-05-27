// Vercel serverless entrypoint — delegates every request to the Express app.
// server.js detects VERCEL env and exports `app` instead of calling listen().
module.exports = require('../server.js');
