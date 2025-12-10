/**
 * Comprehensive Unit Tests for Robust HTTP Server
 * 
 * This test file contains 10 test cases that verify:
 * - HTTP method handling (GET, HEAD, OPTIONS)
 * - Method rejection (POST, PUT, DELETE with 405 responses)
 * - Content-Type header validation
 * - Multi-path routing
 * - Graceful shutdown signals (SIGTERM, SIGINT)
 * 
 * Run with: node server.test.js
 * Expected output: "Test Results: 10 passed, 0 failed"
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

// Test configuration
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 3000;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_FILE = path.resolve(__dirname, 'server.js');
const STARTUP_DELAY = 500; // milliseconds to wait for server startup
const SHUTDOWN_DELAY = 2000; // milliseconds to wait for graceful shutdown

// Test results tracking
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

/**
 * Makes an HTTP request and returns a promise with the response
 * @param {string} method - HTTP method
 * @param {string} urlPath - URL path
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
function makeRequest(method, urlPath = '/') {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: body
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Starts the server as a child process
 * @returns {Promise<ChildProcess>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn('node', [SERVER_FILE], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let started = false;
    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      if (!started && stdout.includes('Server running')) {
        started = true;
        setTimeout(() => resolve(serverProcess), 100);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    serverProcess.on('error', (err) => {
      if (!started) {
        reject(err);
      }
    });

    // Timeout for server startup
    setTimeout(() => {
      if (!started) {
        serverProcess.kill('SIGKILL');
        reject(new Error(`Server failed to start. stdout: ${stdout}, stderr: ${stderr}`));
      }
    }, 5000);
  });
}

/**
 * Stops the server gracefully
 * @param {ChildProcess} serverProcess 
 * @param {string} signal - Signal to send (SIGTERM or SIGINT)
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function stopServer(serverProcess, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';

    serverProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    serverProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    serverProcess.on('exit', (code) => {
      resolve({
        exitCode: code,
        stdout: stdout,
        stderr: stderr
      });
    });

    serverProcess.kill(signal);

    // Force kill after timeout
    setTimeout(() => {
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }, 10000);
  });
}

/**
 * Logs test result and updates counters
 * @param {string} testName 
 * @param {boolean} passed 
 * @param {string} message 
 */
function logTestResult(testName, passed, message = '') {
  testsRun++;
  if (passed) {
    testsPassed++;
    console.log(`✓ PASS: ${testName}`);
  } else {
    testsFailed++;
    console.log(`✗ FAIL: ${testName}`);
    if (message) {
      console.log(`  Error: ${message}`);
    }
  }
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms 
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==================== TEST CASES ====================

/**
 * Test 1: GET Request Success Test
 * - Send GET request to http://127.0.0.1:3000/
 * - Assert status code is 200
 * - Assert body is "Hello, World!\n"
 */
async function testGetRequestSuccess(serverProcess) {
  const testName = 'GET Request Success';
  try {
    const response = await makeRequest('GET', '/');
    const passed = response.statusCode === 200 && response.body === 'Hello, World!\n';
    logTestResult(testName, passed, 
      passed ? '' : `Expected status 200 and body "Hello, World!\\n", got status ${response.statusCode} and body "${response.body}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 2: HEAD Request Handling Test
 * - Send HEAD request to http://127.0.0.1:3000/
 * - Assert status code is 200
 * - Assert response has no body
 */
async function testHeadRequest(serverProcess) {
  const testName = 'HEAD Request Handling';
  try {
    const response = await makeRequest('HEAD', '/');
    const passed = response.statusCode === 200 && response.body === '';
    logTestResult(testName, passed,
      passed ? '' : `Expected status 200 and empty body, got status ${response.statusCode} and body "${response.body}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 3: OPTIONS Request Test
 * - Send OPTIONS request to http://127.0.0.1:3000/
 * - Assert status code is 204
 * - Assert Allow header contains "GET, HEAD, OPTIONS"
 */
async function testOptionsRequest(serverProcess) {
  const testName = 'OPTIONS Request';
  try {
    const response = await makeRequest('OPTIONS', '/');
    const allowHeader = response.headers['allow'] || '';
    const passed = response.statusCode === 204 && allowHeader.includes('GET') && 
                   allowHeader.includes('HEAD') && allowHeader.includes('OPTIONS');
    logTestResult(testName, passed,
      passed ? '' : `Expected status 204 and Allow header with GET, HEAD, OPTIONS. Got status ${response.statusCode}, Allow: "${allowHeader}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 4: POST Rejection Test
 * - Send POST request to http://127.0.0.1:3000/
 * - Assert status code is 405
 * - Assert body contains "Method Not Allowed"
 */
async function testPostRejection(serverProcess) {
  const testName = 'POST Rejection (405)';
  try {
    const response = await makeRequest('POST', '/');
    const passed = response.statusCode === 405 && response.body.includes('Method Not Allowed');
    logTestResult(testName, passed,
      passed ? '' : `Expected status 405 and body containing "Method Not Allowed". Got status ${response.statusCode}, body: "${response.body}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 5: PUT Rejection Test
 * - Send PUT request to http://127.0.0.1:3000/
 * - Assert status code is 405
 * - Assert body contains "Method Not Allowed"
 */
async function testPutRejection(serverProcess) {
  const testName = 'PUT Rejection (405)';
  try {
    const response = await makeRequest('PUT', '/');
    const passed = response.statusCode === 405 && response.body.includes('Method Not Allowed');
    logTestResult(testName, passed,
      passed ? '' : `Expected status 405 and body containing "Method Not Allowed". Got status ${response.statusCode}, body: "${response.body}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 6: DELETE Rejection Test
 * - Send DELETE request to http://127.0.0.1:3000/
 * - Assert status code is 405
 * - Assert body contains "Method Not Allowed"
 */
async function testDeleteRejection(serverProcess) {
  const testName = 'DELETE Rejection (405)';
  try {
    const response = await makeRequest('DELETE', '/');
    const passed = response.statusCode === 405 && response.body.includes('Method Not Allowed');
    logTestResult(testName, passed,
      passed ? '' : `Expected status 405 and body containing "Method Not Allowed". Got status ${response.statusCode}, body: "${response.body}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 7: Content-Type Header Validation Test
 * - Send GET request
 * - Assert Content-Type header is "text/plain"
 */
async function testContentTypeHeader(serverProcess) {
  const testName = 'Content-Type Header Validation';
  try {
    const response = await makeRequest('GET', '/');
    const contentType = response.headers['content-type'] || '';
    const passed = contentType === 'text/plain';
    logTestResult(testName, passed,
      passed ? '' : `Expected Content-Type "text/plain", got "${contentType}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 8: Multi-Path Routing Test
 * - Send GET requests to different paths (/, /test, /api)
 * - Assert all return same 200 response
 */
async function testMultiPathRouting(serverProcess) {
  const testName = 'Multi-Path Routing';
  try {
    const paths = ['/', '/test', '/api', '/any/path'];
    let allPassed = true;
    let failureMessage = '';

    for (const p of paths) {
      const response = await makeRequest('GET', p);
      if (response.statusCode !== 200 || response.body !== 'Hello, World!\n') {
        allPassed = false;
        failureMessage = `Path ${p}: Expected status 200 and body "Hello, World!\\n", got status ${response.statusCode} and body "${response.body}"`;
        break;
      }
    }

    logTestResult(testName, allPassed, failureMessage);
  } catch (err) {
    logTestResult(testName, false, err.message);
  }
}

/**
 * Test 9: SIGTERM Graceful Shutdown Test
 * - Start server as child process
 * - Send SIGTERM signal
 * - Assert server outputs graceful shutdown message
 * - Assert process exits cleanly
 */
async function testSigtermShutdown() {
  const testName = 'SIGTERM Graceful Shutdown';
  let serverProcess = null;
  
  try {
    serverProcess = await startServer();
    await sleep(STARTUP_DELAY);
    
    const result = await stopServer(serverProcess, 'SIGTERM');
    
    const hasShutdownMessage = result.stdout.includes('SIGTERM received') || 
                               result.stdout.includes('graceful shutdown') ||
                               result.stdout.includes('Starting graceful shutdown');
    const cleanExit = result.exitCode === 0;
    
    const passed = hasShutdownMessage && cleanExit;
    logTestResult(testName, passed,
      passed ? '' : `Expected graceful shutdown message and exit code 0. Got exit code ${result.exitCode}, stdout: "${result.stdout.substring(0, 200)}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }
}

/**
 * Test 10: SIGINT Graceful Shutdown Test
 * - Start server as child process
 * - Send SIGINT signal
 * - Assert server outputs graceful shutdown message
 * - Assert process exits cleanly
 */
async function testSigintShutdown() {
  const testName = 'SIGINT Graceful Shutdown';
  let serverProcess = null;
  
  try {
    serverProcess = await startServer();
    await sleep(STARTUP_DELAY);
    
    const result = await stopServer(serverProcess, 'SIGINT');
    
    const hasShutdownMessage = result.stdout.includes('SIGINT received') || 
                               result.stdout.includes('graceful shutdown') ||
                               result.stdout.includes('Starting graceful shutdown');
    const cleanExit = result.exitCode === 0;
    
    const passed = hasShutdownMessage && cleanExit;
    logTestResult(testName, passed,
      passed ? '' : `Expected graceful shutdown message and exit code 0. Got exit code ${result.exitCode}, stdout: "${result.stdout.substring(0, 200)}"`);
  } catch (err) {
    logTestResult(testName, false, err.message);
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }
}

// ==================== TEST RUNNER ====================

/**
 * Main test runner
 */
async function runTests() {
  console.log('');
  console.log('='.repeat(60));
  console.log('Robust HTTP Server - Comprehensive Unit Tests');
  console.log('='.repeat(60));
  console.log('');

  let serverProcess = null;

  try {
    // Tests 1-8: HTTP Method Tests (require running server)
    console.log('Starting server for HTTP method tests...');
    serverProcess = await startServer();
    await sleep(STARTUP_DELAY);
    console.log('Server started successfully.');
    console.log('');

    // Run HTTP tests
    await testGetRequestSuccess(serverProcess);
    await testHeadRequest(serverProcess);
    await testOptionsRequest(serverProcess);
    await testPostRejection(serverProcess);
    await testPutRejection(serverProcess);
    await testDeleteRejection(serverProcess);
    await testContentTypeHeader(serverProcess);
    await testMultiPathRouting(serverProcess);

    // Stop server for signal tests
    console.log('');
    console.log('Stopping server for signal tests...');
    await stopServer(serverProcess, 'SIGTERM');
    await sleep(1000); // Wait for port to be released
    console.log('');

    // Tests 9-10: Signal Tests (start/stop server for each)
    await testSigtermShutdown();
    await sleep(1000); // Wait for port to be released
    await testSigintShutdown();

  } catch (err) {
    console.error('Test runner error:', err.message);
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log(`Test Results: ${testsPassed} passed, ${testsFailed} failed`);
  console.log('='.repeat(60));
  console.log('');

  // Exit with appropriate code
  process.exit(testsFailed > 0 ? 1 : 0);
}

// Run the tests
runTests();
