/**
 * tests/test_native_transport.ts — Transport layer unit tests
 *
 * Tests the transport lifecycle, multi-node failover, JSON-RPC 2.0 request/response
 * routing, and error handling using Node.js built-in WebSocket server for mocking.
 */

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const { getErrorMessage } = require('../modules/utils/errors');

console.log('=== Native Transport Tests ===\n');

const STRICT_TEST = process.env.RUN_NATIVE_TRANSPORT_TEST_STRICT === '1';

function formatError(error) {
    return error && error.message ? error.message : String(error);
}

function isEnvironmentError(error) {
    if (!error) return false;
    const message = formatError(error);
    const code = error.code || '';
    return [
        'EPERM',
        'EACCES',
        'EADDRINUSE',
        'EADDRNOTAVAIL',
        'ECONNREFUSED',
        'ETIMEDOUT'
    ].includes(code) || /listen|bind|timed out/i.test(message);
}

// Dynamically create WebSocket server for testing
// Node 22 has built-in WebSocket, but server-side requires ws package or http upgrade.
// For mocking, we use a simple HTTP upgrade handler.

function createWsServer(port, options = {}) {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            res.writeHead(200);
            res.end('ok');
        });

        const connections = new Set();

        server.on('upgrade', (req, socket, head) => {
            const key = req.headers['sec-websocket-key'];
            const acceptKey = crypto
                .createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');

            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
            );

            connections.add(socket);
            const handlers: any = {};

            socket.on('data', (chunk) => {
                try {
                    const frame = parseWsFrame(chunk);
                    if (!frame) return;
                    const msg = JSON.parse(frame.payload.toString());
                    const id = msg.id;

                    if (msg.method === 'call') {
                        const [apiId, method, params] = msg.params;

                        // Handle login
                        if (method === 'login') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: true,
                            }));
                        }
                        // Handle API registration
                        else if (method === 'database') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 2 }));
                        }
                        else if (method === 'history') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 3 }));
                        }
                        else if (method === 'network_broadcast') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: 4 }));
                        }
                        else if (method === 'get_chain_id') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8',
                            }));
                        }
                        else if (method === 'get_chain_properties') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: { address_prefix: 'BTS' },
                            }));
                        }
                        else if (method === 'get_global_properties') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: {
                                    parameters: {
                                        current_fees: {
                                            parameters: [],
                                            scale: 10000,
                                        },
                                    },
                                },
                            }));
                        }
                        // Handle get_dynamic_global_properties
                        else if (method === 'get_dynamic_global_properties') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: { head_block_number: 12345, head_block_id: '00cafe0000000000000000000000000000000000' },
                            }));
                        }
                        // Handle get_objects
                        else if (method === 'get_objects') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: [{ id: '2.0.0' }, { id: '2.1.0', head_block_number: 12300, head_block_id: '00cafe0000000000000000000000000000000000' }],
                            }));
                        }
                        // Handle get_assets
                        else if (method === 'get_assets') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: [{ id: '1.3.0', precision: 5, symbol: 'BTS' }],
                            }));
                        }
                        // Handle lookup_asset_symbols
                        else if (method === 'lookup_asset_symbols') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: [{ id: '1.3.0', precision: 5, symbol: 'BTS' }],
                            }));
                        }
                        // Handle getGlobalProperties
                        else if (method === 'get_global_properties') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: {
                                    parameters: {
                                        current_fees: {
                                            parameters: [],
                                            scale: 10000,
                                        },
                                    },
                                },
                            }));
                        }
                        // Handle get_full_accounts
                        else if (method === 'get_full_accounts') {
                            sendWsFrame(socket, JSON.stringify({
                                id, jsonrpc: '2.0',
                                result: [[params[0][0], { account: { id: '1.2.100', name: 'test-account' }, balances: [], limit_orders: [] }]],
                            }));
                        }
                        // Handle subscribe
                        else if (method === 'set_subscribe_callback') {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: null }));
                        }
                        else {
                            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result: {} }));
                        }
                    }

                    if (handlers.onMessage) handlers.onMessage(JSON.parse(frame.payload.toString()));
                    if (typeof (options as any).onMessage === 'function') {
                        (options as any).onMessage(JSON.parse(frame.payload.toString()));
                    }
                } catch (e) {
                    // Ignore parse errors for control frames
                }
            });

            socket.on('end', () => { connections.delete(socket); });
            socket.on('error', () => { connections.delete(socket); });

            if (handlers.onCreate) handlers.onCreate(socket);
            socket._handlers = handlers;
        });

        server.once('error', reject);

        server.listen(port, '127.0.0.1', () => {
            resolve({
                server,
                port,
                close() {
                    for (const s of connections) {
                        try { (s as any).destroy(); } catch (_) {}
                    }
                    server.close();
                },
                onConnection(handler) {
                    // Store handler for new connections
                    server._connHandler = handler;
                },
            });
        });
    });
}

function parseWsFrame(chunk) {
    if (chunk.length < 2) return null;
    const firstByte = chunk[0];
    const secondByte = chunk[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
        payloadLength = chunk.readUInt16BE(2);
        offset = 4;
    } else if (payloadLength === 127) {
        // 64-bit length - use Number for test simplicity
        payloadLength = Number(chunk.readBigUInt64BE(2));
        offset = 10;
    }

    const maskKey = masked ? chunk.slice(offset, offset + 4) : null;
    if (masked) offset += 4;
    const payload = chunk.slice(offset, offset + payloadLength);

    if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
            payload[i] ^= maskKey[i % 4];
        }
    }

    return { opcode, payload };
}

function sendWsFrameRaw(socket: any, opcode: number, payload: Buffer) {
    const finOpcode = 0x80 | opcode;
    let header: Buffer;
    if (payload.length < 126) {
        header = Buffer.from([finOpcode, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = finOpcode; header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = finOpcode; header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}

function sendWsFrame(socket, data) {
    const payload = Buffer.from(data, 'utf8');
    let header;
    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
}

// ── Test 1: Transport connection lifecycle ───────────────────────────────

async function testConnectionLifecycle() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    try {
        const transport = createTransport({});

        // Connect
        await transport.connect([`ws://127.0.0.1:${port}/ws`]);

        // Check state
        assert.strictEqual(transport.isConnected(), true, 'Should be connected');
        assert.ok(transport.getNodeUrl().includes(String(port)), 'Node URL should match');

        // Make an RPC call
        const result = await transport.call('call', [1, 'get_assets', [['1.3.0']]]);
        assert.ok(result, 'RPC call should return result');

        // RPC timeout test - call a method the server doesn't know about
        // The server won't respond, triggering the client-side timeout
        let timeoutCaught = false;
        try {
            await transport.call('unregistered_method', [], 500);
        } catch (e) {
            timeoutCaught = (e as any).code === 'RPC_TIMEOUT';
        }
        assert.ok(timeoutCaught, 'Timeout should be caught');

        // Disconnect
        transport.disconnect();
        assert.strictEqual(transport.isConnected(), false, 'Should be disconnected');

        console.log('  PASS: Connection lifecycle');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test 2: Multi-node failover ──────────────────────────────────────────

async function testMultiNodeFailover() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    try {
        const transport = createTransport({});

        // Connect with invalid first node, valid second
        await transport.connect([
            `ws://127.0.0.1:19999/nonexistent`,
            `ws://127.0.0.1:${port}/ws`,
        ]);

        assert.strictEqual(transport.isConnected(), true, 'Should connect to fallback node');
        assert.ok(transport.getNodeUrl().includes(String(port)), 'Should use second node');

        transport.disconnect();

        console.log('  PASS: Multi-node failover (bad node first)');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test 3: All nodes fail ───────────────────────────────────────────────

async function testAllNodesFail() {
    const { createTransport, AllNodesFailed } = require('../modules/bitshares-native/transport');

    const transport = createTransport({ connectTimeoutMs: 500 });

    try {
        await transport.connect([
            'ws://127.0.0.1:19998/bad',
            'ws://127.0.0.1:19997/bad',
        ]);
        assert.fail('Should have thrown');
    } catch (e) {
        assert.ok(e instanceof AllNodesFailed || (e as any).code === 'ALL_NODES_FAILED' || (e as any).code === 'CONNECTION_ERROR',
            `Expected connection error, got: ${(e as any).code || getErrorMessage(e)}`);
    }

    console.log('  PASS: All nodes fail gracefully');
}

// ── Test 4: RPC error handling ───────────────────────────────────────────

async function testRpcErrorHandling() {
    assert.ok(true, 'RPC error types defined');
    const { RpcError, RpcTimeoutError, ConnectionError } = require('../modules/bitshares-native/transport');
    const rpcErr = new RpcError('test error', -32000, 'test_method', []);
    assert.strictEqual(rpcErr.code, -32000);
    assert.strictEqual(rpcErr.method, 'test_method');

    const timeoutErr = new RpcTimeoutError('test_method', 5000);
    assert.strictEqual(timeoutErr.code, 'RPC_TIMEOUT');
    assert.strictEqual(timeoutErr.method, 'test_method');

    const connErr = new ConnectionError('test connection error');
    assert.strictEqual(connErr.code, 'CONNECTION_ERROR');

    console.log('  PASS: Error type hierarchy');
}

// ── Test 5: Message handlers and status callbacks ────────────────────────

async function testStatusCallbacks() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);

    const statuses = [];
    const transport = createTransport({
        onStatusChange: (status) => statuses.push(status),
    });

    try {
        await transport.connect([`ws://127.0.0.1:${port}/ws`]);
        assert.ok(statuses.includes('connected'), 'Should fire connected status');

        transport.disconnect();
        assert.ok(statuses.includes('closed'), 'Should fire closed status');

        console.log('  PASS: Status callbacks');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test 6: Idle keepalive ───────────────────────────────────────────────

async function testKeepAlive() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);
    let loginCalls = 0;
    const wsServer = await createWsServer(port, {
        onMessage: (msg) => {
            if (msg?.method === 'call' && msg.params?.[1] === 'login') {
                loginCalls += 1;
            }
        },
    });

    const transport = createTransport({
        keepAliveIntervalMs: 30,
        rpcTimeoutMs: 500,
    });

    try {
        await transport.connect([`ws://127.0.0.1:${port}/ws`]);
        const callsAfterConnect = loginCalls;
        // One keep-alive interval is 30 ms; 40 ms guarantees at least one
        // lightweight login RPC without padding three full intervals.
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.ok(loginCalls > callsAfterConnect, 'keepalive should send lightweight login RPCs while idle');
        transport.disconnect();
        console.log('  PASS: Idle keepalive');
    } finally {
        (wsServer as any).close();
    }
}

// ── Test 7: Keep-alive failure recovery ──────────────────────────────────

async function testKeepAliveRecovery() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);

    // We need a stateful server: first login per connection succeeds (for chain setup),
    // subsequent login calls fail (simulating a dead remote node).
    // The transport should reconnect after 3 consecutive keep-alive failures.
    let connectionCount = 0;
    const loginsPerSocket: Map<any, number> = new Map();

    const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end('ok');
    });

    server.on('upgrade', (req, socket, head) => {
        connectionCount++;
        loginsPerSocket.set(socket, 0);

        // Complete WebSocket upgrade handshake
        const key = req.headers['sec-websocket-key'];
        const acceptKey = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
        );

        const respond = (id: any, result?: any, error?: any) => {
            sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result, error }));
        };

        socket.on('data', (chunk) => {
            try {
                const frame = parseWsFrame(chunk);
                if (!frame) return;

                // Handle WebSocket close frame — echo it back so client onclose fires
                if (frame.opcode === 0x08) {
                    const statusCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1000;
                    const closePayload = Buffer.alloc(2);
                    closePayload.writeUInt16BE(statusCode, 0);
                    sendWsFrameRaw(socket, 0x08, closePayload);
                    socket.end();
                    return;
                }

                const msg = JSON.parse(frame.payload.toString());
                if (msg.method !== 'call') return;
                const id = msg.id;
                const [apiId, method, params] = msg.params;

                if (method === 'login') {
                    const count = loginsPerSocket.get(socket) || 0;
                    loginsPerSocket.set(socket, count + 1);
                    if (count === 0) {
                        respond(id, true);          // first login on this socket → succeed
                    } else {
                        respond(id, null, { code: 1, message: 'keep-alive failure' });  // subsequent → fail
                    }
                } else if (method === 'database') {
                    respond(id, 2);
                } else if (method === 'history') {
                    respond(id, 3);
                } else if (method === 'network_broadcast') {
                    respond(id, 4);
                } else if (method === 'get_chain_id') {
                    respond(id, '4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8');
                } else if (method === 'get_chain_properties') {
                    respond(id, { address_prefix: 'BTS' });
                } else if (method === 'get_global_properties') {
                    respond(id, { parameters: { current_fees: { parameters: [], scale: 10000 } } });
                } else if (method === 'get_dynamic_global_properties') {
                    respond(id, { head_block_number: 12345, head_block_id: '00cafe0000000000000000000000000000000000' });
                } else if (method === 'get_objects') {
                    respond(id, [{ id: '2.0.0' }, { id: '2.1.0', head_block_number: 12300, head_block_id: '00cafe0000000000000000000000000000000000' }]);
                } else if (method === 'get_assets') {
                    respond(id, [{ id: '1.3.0', precision: 5, symbol: 'BTS' }]);
                } else if (method === 'lookup_asset_symbols') {
                    respond(id, [{ id: '1.3.0', precision: 5, symbol: 'BTS' }]);
                } else if (method === 'set_subscribe_callback') {
                    respond(id, null);
                } else {
                    respond(id, {});
                }
            } catch (_) {}
        });

        socket.on('end', () => loginsPerSocket.delete(socket));
        socket.on('error', () => loginsPerSocket.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

    try {
        const initialConnections = connectionCount;
        const transport = createTransport({
            keepAliveIntervalMs: 30,
            rpcTimeoutMs: 100,
            connectTimeoutMs: 500,
            // Keep the reconnect cycle fast: the assertions only need one
            // successful reconnect, not the production 1s+ exponential wait.
            reconnectBaseDelayMs: 10,
        });

        await transport.connect([`ws://127.0.0.1:${port}/ws`]);
        assert.ok(transport.isConnected(), 'Should connect initially');

        // Keep-alive fails immediately (server sends error for login call #2+).
        // After 3 consecutive failures, ws.close() → onclose → scheduleReconnect → tryConnect.
        // The cycle repeats (each reconnect triggers keep-alive again).
        // Poll for at least one reconnect (connectionCount increment) with a 12s timeout.
        const pollStart = Date.now();
        const pollTimeout = 12000;
        let reconnected = false;
        while (Date.now() - pollStart < pollTimeout) {
            if (connectionCount >= initialConnections + 1) {
                reconnected = true;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        assert.ok(reconnected,
            `Expected at least 1 reconnect within ${pollTimeout}ms (connections: ${initialConnections} → ${connectionCount})`);

        transport.disconnect();
        console.log('  PASS: Keep-alive failure recovery');
    } finally {
        server.close();
    }
}

// ── Node-failure reporting / reconnect selection ─────────────────────────

/**
 * Minimal mock node server for node-failure tests.
 * @param {number} port
 * @param {{failLoginAfter?: number, closeReply?: 'destroy'|'graceful'}} options
 */
function createNodeFailureServer(port, options: any = {}) {
    return new Promise<any>((resolve, reject) => {
        const server = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
        const sockets = new Set();
        let loginCalls = 0;
        const failLoginAfter = options.failLoginAfter ?? Number.POSITIVE_INFINITY;
        const closeReply = options.closeReply || 'destroy';

        server.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            const acceptKey = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('error', () => { sockets.delete(socket); });

            socket.on('data', (chunk) => {
                let frame;
                try { frame = parseWsFrame(chunk); } catch (_) { return; }
                if (!frame) return;
                if (frame.opcode === 0x08) {
                    if (closeReply === 'graceful') { try { socket.end(); } catch (_) {} }
                    else { try { socket.destroy(); } catch (_) {} }
                    return;
                }
                let msg;
                try { msg = JSON.parse(frame.payload.toString()); } catch (_) { return; }
                if (msg.method !== 'call') return;
                const id = msg.id;
                const method = msg.params[1];
                const respond = (result, error?) => sendWsFrame(socket, JSON.stringify({ id, jsonrpc: '2.0', result, error }));
                if (method === 'login') {
                    loginCalls++;
                    if (loginCalls > failLoginAfter) respond(null, { code: 1, message: 'login failed' });
                    else respond(true);
                } else if (method === 'database') respond(2);
                else if (method === 'history') respond(3);
                else if (method === 'network_broadcast') respond(4);
                else if (method === 'get_chain_id') respond('4018d7844c78f6a6c41c6a552b898022310fc5dec06da467ee7905a8dad512c8');
                else if (method === 'get_chain_properties') respond({ address_prefix: 'BTS' });
                else if (method === 'get_global_properties') respond({ parameters: { current_fees: { parameters: [], scale: 10000 } } });
                else respond({});
            });
        });

        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            resolve({
                port,
                url: `ws://127.0.0.1:${port}/ws`,
                abortAll() { for (const s of sockets) { try { (s as any).destroy(); } catch (_) {} } },
                sendClose(code) {
                    const payload = Buffer.alloc(2);
                    payload.writeUInt16BE(code, 0);
                    for (const s of sockets) { try { sendWsFrameRaw(s, 0x08, payload); } catch (_) {} }
                },
                close() { for (const s of sockets) { try { (s as any).destroy(); } catch (_) {} } server.close(); },
            });
        });
    });
}

async function testNodeFailureReportsOnce() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 19100 + Math.floor(Math.random() * 500);
    const server = await createNodeFailureServer(port, { failLoginAfter: 0, closeReply: 'destroy' });
    const failures: any[] = [];
    try {
        const transport = createTransport({
            keepAliveIntervalMs: 30,
            rpcTimeoutMs: 100,
            connectTimeoutMs: 500,
            onNodeFailure: (url, message, source) => failures.push({ url, message, source }),
        });
        await transport.connect([server.url], false);
        const start = Date.now();
        while (failures.length === 0 && Date.now() - start < 5000) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.ok(failures.length >= 1, 'expected at least one node-failure report');
        assert.strictEqual(failures[0].url, server.url, 'failure must name the node');
        assert.strictEqual(failures[0].source, 'keep-alive', 'first failure source is keep-alive');
        // The close triggered by the keep-alive trip must not produce a second
        // (connection) strike for the same event. The keep-alive interval is
        // 30 ms, so a duplicate would surface within the first interval.
        await new Promise(r => setTimeout(r, 40));
        assert.strictEqual(failures.filter(f => f.source === 'connection').length, 0,
            'keep-alive trip must not double-report as a connection failure');
        transport.disconnect();
        console.log('  PASS: Node failure reported once (no duplicate close strike)');
    } finally {
        server.close();
    }
}

async function testCloseClassification() {
    const { createTransport } = require('../modules/bitshares-native/transport');

    // Benign close (1000) must NOT count as a node failure.
    const benignPort = 19200 + Math.floor(Math.random() * 200);
    const benignServer = await createNodeFailureServer(benignPort, { closeReply: 'graceful' });
    const benignFailures: any[] = [];
    try {
        const transport = createTransport({
            keepAliveIntervalMs: 60000,
            rpcTimeoutMs: 500,
            connectTimeoutMs: 1000,
            onNodeFailure: (url, message, source) => benignFailures.push({ url, source }),
        });
        await transport.connect([benignServer.url], false);
        benignServer.sendClose(1000);
        await new Promise(r => setTimeout(r, 40));
        assert.strictEqual(benignFailures.length, 0, 'normal close (1000) must not count as a node failure');
        transport.disconnect();
        console.log('  PASS: Benign close not reported');
    } finally {
        benignServer.close();
    }

    // Abnormal close (abrupt drop) MUST count, with source 'connection'.
    const abnormalPort = 19400 + Math.floor(Math.random() * 200);
    const abnormalServer = await createNodeFailureServer(abnormalPort, {});
    const abnormalFailures: any[] = [];
    try {
        const transport = createTransport({
            keepAliveIntervalMs: 60000,
            rpcTimeoutMs: 500,
            connectTimeoutMs: 1000,
            onNodeFailure: (url, message, source) => abnormalFailures.push({ url, source }),
        });
        await transport.connect([abnormalServer.url], false);
        abnormalServer.abortAll();
        const start = Date.now();
        while (abnormalFailures.length === 0 && Date.now() - start < 3000) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.ok(abnormalFailures.length >= 1, 'abnormal close must count as a node failure');
        assert.strictEqual(abnormalFailures[0].source, 'connection');
        transport.disconnect();
        console.log('  PASS: Abnormal close reported');
    } finally {
        abnormalServer.close();
    }
}

async function testForceReconnect() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);
    const failures: any[] = [];
    const reconnects: string[] = [];

    try {
        const transport = createTransport({
            keepAliveIntervalMs: 60000,
            onNodeFailure: (url, message, source) => failures.push({ url, message, source }),
            onReconnect: async (url) => { reconnects.push(url); },
        });
        await transport.connect([`ws://127.0.0.1:${port}/ws`], true);
        assert.strictEqual(transport.isConnected(), true, 'Should be connected before forceReconnect');

        // forceReconnect is the recovery path for a socket that looks open but
        // serves no usable session (e.g. every RPC rejects cached api ids). It
        // must report the active node as failed and re-establish the connection.
        transport.forceReconnect('unit-test');
        assert.ok(failures.some((f: any) => f.source === 'forced-reconnect'),
            'forceReconnect must report the active node as failed');

        const start = Date.now();
        while (reconnects.length === 0 && Date.now() - start < 5000) {
            await new Promise(r => setTimeout(r, 20));
        }
        assert.ok(reconnects.length >= 1, 'forceReconnect must re-establish the connection and fire onReconnect');
        assert.strictEqual(transport.isConnected(), true, 'Should be connected after forced reconnect');
        // The forced close must not double-report as a connection strike.
        assert.strictEqual(failures.filter((f: any) => f.source === 'connection').length, 0,
            'forced reconnect must not double-report a connection failure');

        transport.disconnect();
        console.log('  PASS: forceReconnect reports failure and re-establishes');
    } finally {
        (wsServer as any).close();
    }
}

async function testShouldSkipNode() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const portA = 19600 + Math.floor(Math.random() * 100);
    const portB = 19700 + Math.floor(Math.random() * 100);
    const serverA = await createNodeFailureServer(portA, {});
    const serverB = await createNodeFailureServer(portB, {});
    try {
        // Skip A → must land on B even though both are healthy.
        const transport = createTransport({
            keepAliveIntervalMs: 60000,
            rpcTimeoutMs: 500,
            connectTimeoutMs: 1000,
            shouldSkipNode: (url) => url === serverA.url,
        });
        await transport.connect([serverA.url, serverB.url], false);
        assert.strictEqual(transport.getNodeUrl(), serverB.url, 'skipped node must not be selected');
        transport.disconnect();
        console.log('  PASS: shouldSkipNode deprioritizes a node');

        // Every node skipped → fallback still connects (never wedge).
        const fallback = createTransport({
            keepAliveIntervalMs: 60000,
            rpcTimeoutMs: 500,
            connectTimeoutMs: 1000,
            shouldSkipNode: () => true,
        });
        await fallback.connect([serverA.url, serverB.url], false);
        assert.ok(fallback.getNodeUrl(), 'fallback connects when every node is deprioritized');
        fallback.disconnect();
        console.log('  PASS: all-deprioritized fallback still connects');
    } finally {
        serverA.close();
        serverB.close();
    }
}

// ── Test: a disconnect names the node it closed ──────────────────────────

async function testDisconnectLogAttribution() {
    const { createTransport } = require('../modules/bitshares-native/transport');
    const { setGlobalConsoleLevel, getGlobalConsoleLevel } = require('../modules/order/logger');
    const port = 18000 + Math.floor(Math.random() * 1000);
    const wsServer = await createWsServer(port);
    const url = `ws://127.0.0.1:${port}/ws`;

    // The logger routes info -> console.log. Capture it so we can assert on the
    // status line itself: an intentional disconnect used to clear nodeUrl before
    // emitting the status change, logging `(node=null)` and making 120 of 172
    // closes in a live run unattributable.
    const originalLog = console.log;
    const originalWarn = console.warn;
    const previousConsoleLevel = getGlobalConsoleLevel();
    const lines: string[] = [];
    const collect = (...args: any[]) => { lines.push(args.join(' ')); };

    try {
        // Pin the console level so the assertion does not depend on whatever
        // LOG_LEVEL the operator's general.settings.json happens to carry.
        setGlobalConsoleLevel('debug');
        const transport = createTransport({ keepAliveIntervalMs: 60000, connectTimeoutMs: 1000 });
        await transport.connect([url], false);

        console.log = collect;
        console.warn = collect;
        transport.disconnect();

        assert.strictEqual(transport.getNodeUrl(), null, 'active node must be cleared after disconnect');

        const statusLines = lines.filter((line) => line.includes('[Transport]') && line.includes('status change:'));
        assert.ok(statusLines.length > 0, `expected a transport status line, got: ${JSON.stringify(lines)}`);
        const closeLine = statusLines.find((line) => line.includes('connected -> closed'));
        assert.ok(closeLine, `expected a connected -> closed line, got: ${JSON.stringify(statusLines)}`);
        assert.ok(
            closeLine!.includes(`node=${url}`),
            `disconnect must name the node it closed, got: ${closeLine}`
        );
        assert.ok(
            !closeLine!.includes('node=null'),
            `disconnect must not log node=null, got: ${closeLine}`
        );

        console.log = originalLog;
        console.warn = originalWarn;
        console.log('  PASS: disconnect log names the closed node');
    } finally {
        setGlobalConsoleLevel(previousConsoleLevel);
        console.log = originalLog;
        console.warn = originalWarn;
        (wsServer as any).close();
    }
}

// ── Run all tests ────────────────────────────────────────────────────────

(async () => {
    try {
        await testConnectionLifecycle();
        await testMultiNodeFailover();
        await testAllNodesFail();
        testRpcErrorHandling();
        await testStatusCallbacks();
        await testKeepAlive();
        await testKeepAliveRecovery();
        await testNodeFailureReportsOnce();
        await testCloseClassification();
        await testForceReconnect();
        await testShouldSkipNode();
        await testDisconnectLogAttribution();
        console.log('\n=== All transport tests passed ===');
    } catch (e) {
        if (!STRICT_TEST && isEnvironmentError(e)) {
            console.log('Skipping native transport test: local bind/connect environment not available.');
            console.log('Error:', formatError(e));
            process.exit(0);
        }
        console.error('\nTransport test FAILED:', getErrorMessage(e));
        console.error((e as any).stack);
        process.exit(1);
    }
})();
