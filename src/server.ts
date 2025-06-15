// Enable source map support for better error stack traces in production
if (process.env.NODE_ENV === 'production') {
  require('source-map-support').install();
}

import app from "./app";

const port = process.env.PORT || 3000;


// Export server startup function for better testing
export function startServer() {
  return app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

// Start server if running directly
if (process.env.NODE_ENV !== 'test') {
  startServer();
}