/**
 * @fileoverview Robust, dependency-free HTTP Server Implementation built on the
 * Node.js core `http` module. Provides comprehensive error handling, graceful
 * shutdown, HTTP method validation, URL validation, and proper resource cleanup,
 * plus process-level safety nets. Binds to 127.0.0.1:3000 and responds to every
 * path through a single catch-all request handler.
 *
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
 *
 * @module server
 * @author hxu
 * @license MIT
 */

const http = require('http');

// Server configuration - preserved from original
/**
 * Loopback network interface the HTTP server binds to.
 * @constant {string}
 * @default '127.0.0.1'
 */
const hostname = '127.0.0.1';
/**
 * TCP port the HTTP server listens on.
 * @constant {number}
 * @default 3000
 */
const port = 3000;

// Shutdown configuration
/**
 * Maximum time, in milliseconds, to wait for in-flight connections to drain
 * during a graceful shutdown before the process is forcibly terminated. Set to
 * 5000 ms (5 seconds) to balance clean connection draining against a bounded,
 * predictable shutdown window suitable for process managers and orchestrators.
 * @constant {number}
 * @default 5000
 */
const SHUTDOWN_TIMEOUT = 5000; // 5 seconds timeout for graceful shutdown

// Allowed HTTP methods for this server
/**
 * HTTP verbs this server accepts. Any request whose method is not in this list
 * is rejected with a 405 Method Not Allowed response and an `Allow` header
 * enumerating these methods.
 * @constant {string[]}
 * @default ['GET', 'HEAD', 'OPTIONS']
 */
const ALLOWED_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Maximum URL length (common browser limit)
/**
 * Maximum permitted length, in characters, of a request URL. Requests whose URL
 * exceeds this limit are rejected with 400 Bad Request. The value mirrors the de
 * facto browser/proxy URL-length limit of 2048 characters.
 * @constant {number}
 * @default 2048
 */
const MAX_URL_LENGTH = 2048;

// Server state tracking
/**
 * Whether a graceful shutdown is currently in progress. While `true`, the
 * request handler short-circuits new requests with 503 Service Unavailable.
 * @type {boolean}
 */
let isShuttingDown = false;
/**
 * Handle to the forced-exit timer armed during graceful shutdown; `null` while
 * no shutdown is in progress.
 * @type {?NodeJS.Timeout}
 */
let shutdownTimer = null;

/**
 * Graceful shutdown handler
 * Closes the server and waits for existing connections to complete
 * Forces exit after SHUTDOWN_TIMEOUT if connections don't close
 * 
 * @param {string} signal - The signal that triggered the shutdown (SIGTERM/SIGINT)
 * @returns {void}
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
 * @param {string} url - The URL to validate (typically `req.url`).
 * @returns {{valid: boolean, error?: string}} Result object: `valid` is `true`
 *   when the URL passes all checks; otherwise `valid` is `false` and `error`
 *   holds a human-readable reason.
 * @example
 * validateUrl('/');              // => { valid: true }
 * validateUrl('/'.repeat(3000)); // => { valid: false, error: 'URL exceeds maximum length of 2048 characters' }
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
 * @param {http.ServerResponse} res - The response object to write to.
 * @param {number} statusCode - HTTP status code to send (e.g. 400, 405, 503).
 * @param {string} message - Error message to send; a trailing newline is appended.
 * @param {Object} [additionalHeaders={}] - Optional additional response headers
 *   (e.g. `{ 'Allow': 'GET, HEAD, OPTIONS' }` or `{ 'Retry-After': '30' }`).
 * @returns {void}
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
 * HTTP request handler for every incoming request. This is the server's single
 * catch-all handler; there is no router, so all URL paths are treated identically.
 *
 * Request-decision cascade, evaluated in order:
 * 1. Attach `error` listeners to the request and response streams so a client
 *    disconnect or broken pipe is logged and, where possible, answered with
 *    400 Bad Request instead of crashing the process.
 * 2. If a graceful shutdown is in progress ({@link isShuttingDown} is `true`),
 *    respond 503 Service Unavailable with `Retry-After: 30` and `Connection: close`.
 * 3. Validate the URL via {@link validateUrl}; on failure respond 400 Bad Request.
 * 4. If the method is not in {@link ALLOWED_METHODS}, respond 405 Method Not
 *    Allowed with an `Allow` header listing the permitted methods.
 * 5. `OPTIONS` -> 204 No Content with an `Allow` header and `Content-Length: 0`.
 * 6. `HEAD` -> 200 OK with `Content-Type: text/plain` and a `Content-Length`
 *    header, but no response body.
 * 7. `GET` -> 200 OK with `Content-Type: text/plain` and the body `Hello, World!\n`.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The outgoing HTTP response.
 * @returns {void}
 * @example
 * // Verified live (also asserted by server.test.js tests 1 & 8):
 * // $ curl -i http://127.0.0.1:3000/
 * // HTTP/1.1 200 OK
 * // Content-Type: text/plain
 * // Content-Length: 14
 * //
 * // Hello, World!
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
 * Server-level error handler for failures raised while the server is starting or
 * running (the `http.Server` `'error'` event).
 *
 * Diagnoses the two most common startup failures and prints an actionable message
 * before terminating:
 * - `EADDRINUSE` - the configured port is already in use by another process.
 * - `EACCES` - insufficient privileges to bind, typically a privileged port
 *   below 1024.
 * Any other error falls through to a generic branch. All branches terminate the
 * process with `process.exit(1)`.
 *
 * @param {NodeJS.ErrnoException} err - The error emitted by the server; its `code`
 *   property (e.g. `'EADDRINUSE'`, `'EACCES'`) drives the diagnosis.
 * @returns {void}
 * @listens http.Server#error
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
 * Starts the server and registers the "ready" callback. The callback runs once
 * the server is listening on `hostname:port`; it logs the listen URL and a hint
 * that Ctrl+C triggers a graceful shutdown.
 *
 * @returns {void}
 * @listens net.Server#listening
 */
server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
  console.log('Press Ctrl+C to stop the server gracefully.');
});

/**
 * Signal handler that wires OS termination signals to the graceful-shutdown
 * routine. `SIGTERM` is the conventional termination signal sent by process
 * managers and orchestrators (Docker, Kubernetes, PM2) to request an orderly
 * stop. This handler delegates to {@link gracefulShutdown} with the signal name.
 *
 * @returns {void}
 * @listens process#SIGTERM
 */
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

/**
 * Handles `SIGINT`, the interrupt signal raised when the user presses Ctrl+C in
 * an interactive terminal. Delegates to {@link gracefulShutdown}.
 *
 * @returns {void}
 * @listens process#SIGINT
 */
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});

/**
 * Process-level safety net for synchronous errors that were never caught anywhere
 * in the call stack (the `uncaughtException` event). Logs the error message and
 * stack, then attempts a graceful shutdown via {@link gracefulShutdown} if one is
 * not already in progress; otherwise it exits immediately with code 1.
 *
 * @param {Error} err - The uncaught error.
 * @returns {void}
 * @listens process#uncaughtException
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
 * Process-level safety net for Promise rejections that were never handled (the
 * `unhandledRejection` event). Logs the offending promise and the rejection
 * reason, then attempts a graceful shutdown via {@link gracefulShutdown} if one
 * is not already underway; otherwise it exits with code 1.
 *
 * @param {*} reason - The rejection reason (any value passed to `reject`/thrown).
 * @param {Promise} promise - The promise that was rejected without a handler.
 * @returns {void}
 * @listens process#unhandledRejection
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

/**
 * Public module exports, provided primarily for testing and programmatic control.
 *
 * @property {http.Server} server - The configured HTTP server instance, so tests
 *   and embedding code can start, query, or close it directly.
 * @property {function(string): void} gracefulShutdown - The shutdown trigger; call
 *   with a signal name (e.g. `'SIGTERM'`) to begin an orderly shutdown.
 */
// Export server for testing purposes
module.exports = { server, gracefulShutdown };
