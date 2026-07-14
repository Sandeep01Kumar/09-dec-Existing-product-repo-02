/**
 * @fileoverview Robust, dependency-free HTTP Server Implementation built on the
 * Node.js core `http` module. Provides comprehensive error handling, graceful
 * shutdown, HTTP method validation, URL validation, and proper resource cleanup,
 * plus process-level safety nets. Binds to 127.0.0.1:3000 and responds to every
 * path through a single catch-all request handler.
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
 * HTTP verbs this server accepts. A request whose method is not in this list is
 * rejected with a 405 Method Not Allowed response and an `Allow` header enumerating
 * these methods — but only after the earlier stages of the request-decision cascade
 * pass. The shutdown check (503) and URL validation (400) run first, so, for
 * example, a `POST` carrying an over-length URL is answered with 400, not 405.
 * @constant {string[]}
 * @default ['GET', 'HEAD', 'OPTIONS']
 */
const ALLOWED_METHODS = ['GET', 'HEAD', 'OPTIONS'];

// Maximum URL length (conservative application-configured cap)
/**
 * Maximum permitted length, in characters, of a request URL. Requests whose URL
 * exceeds this limit are rejected with 400 Bad Request by {@link validateUrl}.
 * 2048 is this server's configured, conservative cap on request-URL size; it is
 * an application setting chosen by this project, not an inherent HTTP, browser,
 * or proxy limit.
 * @constant {number}
 * @default 2048
 */
const MAX_URL_LENGTH = 2048;

// Server state tracking
/**
 * Whether a graceful shutdown is currently in progress. While `true`, any request
 * that still reaches the request handler is answered with 503 Service Unavailable.
 * Note that {@link gracefulShutdown} also calls `server.close()`, which stops the
 * listening socket from accepting new connections; a brand-new connection opened
 * during shutdown is therefore refused at the transport layer rather than answered
 * with 503. In practice the 503 branch is only reached by a request that arrives on
 * a connection accepted before `server.close()` took effect (for example an
 * in-flight or already-established keep-alive connection), so it is race-dependent
 * and not a guarantee to fresh clients.
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
 * Initiates a one-time graceful shutdown of the HTTP server and then terminates
 * the process. This is the single shutdown routine shared by every trigger; it is
 * idempotent, so any repeated or concurrent trigger after the first is logged and
 * ignored.
 *
 * Sequence:
 * 1. If a shutdown is already in progress ({@link isShuttingDown} is `true`), log
 *    that the trigger is being ignored and return immediately (idempotent early
 *    return).
 * 2. Set {@link isShuttingDown} to `true` (so any request that still reaches the
 *    handler on an already-accepted connection is answered with 503; note that
 *    step 4's `server.close()` simultaneously stops accepting new connections, so
 *    fresh connections opened during shutdown are refused rather than given a 503)
 *    and log that graceful shutdown has started.
 * 3. Arm a forced-exit timer for {@link SHUTDOWN_TIMEOUT} ms (5 seconds) and
 *    `unref()` it so the timer never keeps the event loop alive on its own. If the
 *    timer fires first, log the timeout and call `process.exit(1)`.
 * 4. Call `server.close(callback)` to stop accepting new connections and wait for
 *    in-flight ones to drain. In the callback: on error, log it, clear the timer,
 *    and `process.exit(1)`; on a clean drain, log completion, clear the timer, and
 *    `process.exit(0)`.
 *
 * @param {string} signal - Label identifying what triggered the shutdown; used
 *   only for logging. Current callers pass the OS signal names `'SIGTERM'` and
 *   `'SIGINT'`, plus the process-level trigger labels `'uncaughtException'` and
 *   `'unhandledRejection'`.
 * @returns {void} Returns synchronously; the process exit happens asynchronously
 *   from the `server.close` callback (exit 0 on clean drain, exit 1 on close
 *   error) or from the forced-exit timer (exit 1 on timeout).
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
 * All error responses below (400, 405, 503) are produced by {@link sendErrorResponse},
 * which sets `Content-Type: text/plain` and writes the supplied message followed by
 * a trailing newline (`\n`) as the body.
 *
 * Request-decision cascade, evaluated in order:
 * 1. Attach `error` listeners to the request and response streams so a client
 *    disconnect or broken pipe is logged. A request-stream error is answered,
 *    only if response headers have not already been sent, with 400 and the body
 *    `Bad Request\n`, instead of crashing the process.
 * 2. If a graceful shutdown is in progress ({@link isShuttingDown} is `true`),
 *    respond 503 Service Unavailable with headers `Retry-After: 30` and
 *    `Connection: close` and the body `Service Unavailable - Server is shutting down\n`.
 * 3. Validate the URL via {@link validateUrl}; on failure respond 400 with the body
 *    `Bad Request - <reason>\n`, where `<reason>` is the validation error message
 *    (e.g. `URL exceeds maximum length of 2048 characters` or
 *    `URL contains invalid null bytes`).
 * 4. If the method is not in {@link ALLOWED_METHODS}, respond 405 with an `Allow`
 *    header listing the permitted methods and the body `Method Not Allowed\n`.
 * 5. `OPTIONS` -> 204 No Content with an `Allow` header and `Content-Length: 0`;
 *    no response body.
 * 6. `HEAD` -> 200 OK with `Content-Type: text/plain` and a `Content-Length: 14`
 *    header, but no response body.
 * 7. `GET` -> 200 OK with `Content-Type: text/plain`, `Content-Length: 14`, and the
 *    body `Hello, World!\n`.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request.
 * @param {http.ServerResponse} res - The outgoing HTTP response.
 * @returns {void}
 * @example
 * // Live curl probe of GET / (every header/body field below was observed live):
 * // $ curl -i http://127.0.0.1:3000/
 * // HTTP/1.1 200 OK
 * // Content-Type: text/plain     // this field is asserted by test 7 (Content-Type validation)
 * // Content-Length: 14           // observed live only; not asserted by any test
 * //
 * // Hello, World!                // the 200 status and this body are asserted by tests 1 & 8
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
 * the server emits the `net.Server` `'listening'` event (bound on `hostname:port`);
 * it logs the listen URL and a hint that Ctrl+C triggers a graceful shutdown.
 *
 * @returns {void}
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
 */
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

/**
 * Handles `SIGINT`, the interrupt signal raised when the user presses Ctrl+C in
 * an interactive terminal. Delegates to {@link gracefulShutdown}.
 *
 * @returns {void}
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
 * Public module exports, provided primarily for programmatic inspection and
 * control. Note that requiring this module has a side effect: `server.listen(...)`
 * runs at load time, which *initiates* listening asynchronously. Listening is not
 * established synchronously, so immediately after `require('./server')` the server
 * is not yet bound: `server.listening` is `false` and `server.address()` returns
 * `null` until Node emits the `'listening'` event on a later tick. Consumers that
 * depend on the bound state must wait for that event (or poll `server.listening`)
 * rather than assume the server is ready the moment `require` returns. (The bundled
 * `server.test.js` does not import these exports; it spawns `node server.js` as a
 * child process instead.)
 *
 * @property {http.Server} server - The HTTP server instance whose `listen()` has
 *   already been invoked at module load, exposed so callers can inspect it (e.g.
 *   `server.listening`, `server.address()`), send requests to it once it is
 *   listening, or close it via `server.close()`. Because binding completes
 *   asynchronously, wait for the `'listening'` event before relying on
 *   `server.address()` or issuing requests.
 * @property {function(string): void} gracefulShutdown - The shutdown trigger; call
 *   with a trigger label (e.g. `'SIGTERM'`) to begin an orderly shutdown. WARNING:
 *   this terminates the host process; it calls `process.exit(0)` on a clean drain
 *   or `process.exit(1)` on a close error or shutdown timeout.
 */
// Export server for testing purposes
module.exports = { server, gracefulShutdown };
