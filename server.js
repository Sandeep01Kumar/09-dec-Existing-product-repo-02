/**
 * @fileoverview A robust, dependency-free Node.js HTTP server that returns
 * `Hello, World!` for GET requests, supports HEAD and OPTIONS, validates the
 * request method and URL, and shuts down gracefully on process signals.
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
 *
 * @module server
 * @requires http
 * Source: server.js:L1-L326
 */

const http = require('http');

// Server configuration - preserved from original
const hostname = '127.0.0.1'; // Loopback bind address (not externally reachable by default)
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
 * Graceful shutdown handler. Idempotent: repeat invocations while a shutdown
 * is already in progress are ignored (guarded by `isShuttingDown`). Stops
 * accepting new connections, waits for existing connections to drain, and
 * forces process exit after `SHUTDOWN_TIMEOUT` if they do not close in time.
 *
 * @param {string} signal - The signal that triggered the shutdown (e.g. 'SIGTERM', 'SIGINT').
 * @returns {void} - No value is returned; the process exits asynchronously once connections drain or the timeout fires.
 * Source: server.js:L52-L83
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
 * Validates the request URL against length and content constraints.
 *
 * @param {string} url - The request URL to validate.
 * @returns {{valid: boolean, error?: string}} - Validation result; `valid` is false with an `error` message when the URL exceeds MAX_URL_LENGTH characters or contains a null byte.
 * Source: server.js:L92-L110
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
 * Sends a plain-text error response with the specified status code and message.
 *
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {number} statusCode - The HTTP status code to send.
 * @param {string} message - The plain-text error message (a trailing newline is appended).
 * @param {Object<string,string>} [additionalHeaders={}] - Optional extra response headers to set.
 * @returns {void} - No value is returned; the response is written and ended as a side effect.
 * Source: server.js:L122-L132
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
 * HTTP request handler for every incoming request. This is a catch-all
 * handler with no path-based routing: the request path never selects a route,
 * so all valid paths share the same per-method behavior. Every URL is still
 * validated, and an overlong or null-byte URL yields 400 regardless of path.
 *
 * Decision order: attaches req/res error listeners -> responds 503 if the
 * server is shutting down -> 400 on an invalid URL -> 405 if the method is not
 * in ALLOWED_METHODS -> 204 for OPTIONS -> 200 headers-only for HEAD ->
 * 200 with `Hello, World!\n` for GET.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The outgoing HTTP response.
 * @returns {void} - No value is returned; the response is produced entirely via side effects on `res`.
 * Source: server.js:L150-L212
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
 * Server-level error handler for errors raised while the server is starting or
 * running. `EADDRINUSE` (the port is already in use) and `EACCES` (permission
 * denied, e.g. binding a privileged port) are diagnosed specifically; all
 * cases log a message and call `process.exit(1)`.
 *
 * @param {Error} err - The server error (its `code` property is inspected for EADDRINUSE/EACCES).
 * @returns {void} - No value is returned; the process terminates via `process.exit(1)`.
 * Source: server.js:L224-L240
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
 * Startup callback fired once the server is listening. Logs the startup banner
 * `Server running at http://127.0.0.1:3000/` and the Ctrl+C hint. Takes no
 * parameters.
 *
 * @returns {void} - No value is returned; it only writes the startup banner to stdout.
 * Source: server.js:L250-L253
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
  console.log('Press Ctrl+C to stop the server gracefully.');
});

/**
 * SIGTERM signal handler for graceful shutdown. SIGTERM is the termination
 * signal sent by process managers (Docker, Kubernetes, PM2) to request an
 * orderly shutdown. The zero-argument callback delegates to
 * `gracefulShutdown('SIGTERM')`.
 *
 * @returns {void} - No value is returned; it delegates to `gracefulShutdown('SIGTERM')`.
 * Source: server.js:L264-L266
 */
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

/**
 * SIGINT signal handler for graceful shutdown. SIGINT is delivered when the
 * user presses Ctrl+C at the controlling terminal. The zero-argument callback
 * delegates to `gracefulShutdown('SIGINT')`.
 *
 * @returns {void} - No value is returned; it delegates to `gracefulShutdown('SIGINT')`.
 * Source: server.js:L276-L278
 */
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

/**
 * Process-level handler for uncaught synchronous exceptions. Acts as a
 * catch-all to prevent silent crashes: it logs the error message and stack,
 * then attempts a `gracefulShutdown('uncaughtException')` if a shutdown is not
 * already in progress, otherwise it calls `process.exit(1)`.
 *
 * @param {Error} err - The uncaught exception.
 * @returns {void} - No value is returned; it triggers graceful shutdown or exits with code 1.
 * Source: server.js:L290-L300
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

/**
 * Process-level handler for unhandled promise rejections. Acts as a catch-all
 * to prevent silent crashes: it logs the offending promise and rejection
 * reason, then attempts a `gracefulShutdown('unhandledRejection')` if a
 * shutdown is not already in progress, otherwise it calls `process.exit(1)`.
 *
 * @param {*} reason - The rejection reason (the value the promise was rejected with).
 * @param {Promise} promise - The promise that was rejected.
 * @returns {void} - No value is returned; it triggers graceful shutdown or exits with code 1.
 * Source: server.js:L313-L323
 */
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
