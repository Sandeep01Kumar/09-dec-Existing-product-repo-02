/**
 * Robust HTTP Server Implementation
 * 
 * This server includes comprehensive error handling, graceful shutdown,
 * input validation, and proper resource cleanup.
 * 
 * Features:
 * - Server-level error handling (EADDRINUSE, EACCES)
 * - Request/response error handling
 * - HTTP method validation (GET, HEAD, OPTIONS only)
 * - URL validation (length limits, null byte detection)
 * - Graceful shutdown with timeout
 * - Signal handling (SIGTERM, SIGINT)
 * - Process-level error handlers (uncaughtException, unhandledRejection)
 */

const http = require('http');

// Server configuration - preserved from original
const hostname = '127.0.0.1';
const port = 3000;

// Shutdown configuration
const SHUTDOWN_TIMEOUT = 5000; // 5 seconds timeout for graceful shutdown

// Allowed HTTP methods for this server
const ALLOWED_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Maximum URL length (common browser limit)
const MAX_URL_LENGTH = 2048;

// Server state tracking
let isShuttingDown = false;
let shutdownTimer = null;

/**
 * Graceful shutdown handler
 * Closes the server and waits for existing connections to complete
 * Forces exit after SHUTDOWN_TIMEOUT if connections don't close
 * 
 * @param {string} signal - The signal that triggered the shutdown (SIGTERM/SIGINT)
 */
function gracefulShutdown(signal) {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    console.log(`Shutdown already in progress. Ignoring ${signal} signal.`);
    return;
  }

  isShuttingDown = true;
  console.log(`${signal} received. Starting graceful shutdown...`);

  // Set a timeout to force exit if graceful shutdown takes too long
  shutdownTimer = setTimeout(() => {
    console.error(`Shutdown timeout (${SHUTDOWN_TIMEOUT}ms) exceeded. Forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);

  // Unref the timer so it doesn't keep the process alive
  shutdownTimer.unref();

  // Stop accepting new connections and wait for existing ones to complete
  server.close((err) => {
    if (err) {
      console.error('Error during server close:', err.message);
      clearTimeout(shutdownTimer);
      process.exit(1);
    }

    console.log('Server closed successfully. All connections terminated.');
    clearTimeout(shutdownTimer);
    process.exit(0);
  });
}

/**
 * Validates the request URL
 * 
 * @param {string} url - The URL to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validateUrl(url) {
  // Check URL length
  if (url && url.length > MAX_URL_LENGTH) {
    return {
      valid: false,
      error: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`
    };
  }

  // Check for null bytes (potential security issue)
  if (url && url.includes('\0')) {
    return {
      valid: false,
      error: 'URL contains invalid null bytes'
    };
  }

  return { valid: true };
}

/**
 * Sends an error response with the specified status code and message
 * 
 * @param {http.ServerResponse} res - The response object
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message to send
 * @param {Object} additionalHeaders - Optional additional headers
 */
function sendErrorResponse(res, statusCode, message, additionalHeaders = {}) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain');
  
  // Add any additional headers
  Object.entries(additionalHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.end(`${message}\n`);
}

/**
 * HTTP Server Request Handler
 * Handles incoming HTTP requests with proper validation and error handling
 */
const server = http.createServer((req, res) => {
  // Handle request errors (e.g., client disconnection during upload)
  req.on('error', (err) => {
    console.error('Request error:', err.message);
    // Only try to send error if headers haven't been sent
    if (!res.headersSent) {
      sendErrorResponse(res, 400, 'Bad Request');
    }
  });

  // Handle response errors (e.g., connection closed while sending)
  res.on('error', (err) => {
    console.error('Response error:', err.message);
  });

  // Check if server is shutting down
  if (isShuttingDown) {
    sendErrorResponse(res, 503, 'Service Unavailable - Server is shutting down', {
      'Connection': 'close',
      'Retry-After': '30'
    });
    return;
  }

  // Validate URL
  const urlValidation = validateUrl(req.url);
  if (!urlValidation.valid) {
    console.error('URL validation failed:', urlValidation.error);
    sendErrorResponse(res, 400, 'Bad Request - ' + urlValidation.error);
    return;
  }

  // Check HTTP method
  if (!ALLOWED_METHODS.includes(req.method)) {
    sendErrorResponse(res, 405, 'Method Not Allowed', {
      'Allow': ALLOWED_METHODS.join(', ')
    });
    return;
  }

  // Handle OPTIONS request (CORS preflight, method discovery)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204; // No Content
    res.setHeader('Allow', ALLOWED_METHODS.join(', '));
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }

  // Handle HEAD request (same as GET but without body)
  if (req.method === 'HEAD') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Length', Buffer.byteLength('Hello, World!\n'));
    res.end();
    return;
  }

  // Handle GET request - original functionality preserved
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain');
  res.end('Hello, World!\n');
});

/**
 * Server-level error handler
 * Handles errors that occur when the server is starting or running
 */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${port} is already in use.`);
    console.error('Please stop the other process using this port or use a different port.');
    process.exit(1);
  }
  
  if (err.code === 'EACCES') {
    console.error(`Error: Permission denied to bind to port ${port}.`);
    console.error('Privileged ports (< 1024) require elevated permissions.');
    process.exit(1);
  }

  // Handle other server errors
  console.error('Server error:', err.message);
  process.exit(1);
});

/**
 * Start the server
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
  console.log('Press Ctrl+C to stop the server gracefully.');
});

/**
 * Signal Handlers for graceful shutdown
 * SIGTERM: Sent by process managers (Docker, Kubernetes, PM2) for graceful termination
 * SIGINT: Sent when user presses Ctrl+C
 */
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

/**
 * Process-level error handlers
 * Catch-all for any unhandled errors to prevent silent crashes
 */
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
  console.error('Stack:', err.stack);
  
  // Attempt graceful shutdown before exiting
  if (!isShuttingDown) {
    gracefulShutdown('uncaughtException');
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  
  // Attempt graceful shutdown before exiting
  if (!isShuttingDown) {
    gracefulShutdown('unhandledRejection');
  } else {
    process.exit(1);
  }
});

// Export server for testing purposes
module.exports = { server, gracefulShutdown };
