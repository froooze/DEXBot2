'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const { getErrorMessage } = require('../../modules/utils/errors');
const { spawnSync } = require('child_process');
const path = require('path');
const { isDistCodeRoot } = require('../../modules/launcher/runtime_entry');
const mcpServer = require('../scripts/claw_mcp_server');

function encodeNewlineMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function testParserAcceptsJsonlAcrossChunksAndSingleBuffer() {
  const seen = [];
  const parser = mcpServer.createMessageParser((message) => {
    seen.push(message);
  });

  const initializeRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: {
        name: 'claw-mcp-transport-test',
        version: '1.4.13'
      },
      protocolVersion: '2024-11-05'
    }
  };

  const listRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  };

  const pingRequest = {
    jsonrpc: '2.0',
    id: 3,
    method: 'ping',
    params: {}
  };

  const initializeLine = encodeNewlineMessage(initializeRequest);
  const splitPoint = Math.floor(initializeLine.length / 2);

  await parser.push(Buffer.from(initializeLine.slice(0, splitPoint)));
  assert.deepStrictEqual(seen, [], 'parser should wait for a newline before emitting a message');

  await parser.push(Buffer.from(initializeLine.slice(splitPoint)));
  await parser.push(Buffer.from(encodeNewlineMessage(listRequest) + encodeNewlineMessage(pingRequest)));

  assert.deepStrictEqual(seen[0], initializeRequest, 'parser should emit a split JSONL message once it is complete');
  assert.deepStrictEqual(seen[1], listRequest, 'parser should parse the first message from a multi-message buffer');
  assert.deepStrictEqual(seen[2], pingRequest, 'parser should continue parsing later messages from the same buffer');
}

async function testParserIgnoresLegacyContentLengthFrames() {
  const seen = [];
  const parser = mcpServer.createMessageParser((message) => {
    seen.push(message);
  });

  const legacyFrame = [
    'Content-Length: 52',
    '',
    '{"jsonrpc":"2.0","id":4,"method":"ping","params":{}}'
  ].join('\r\n');

  await parser.push(Buffer.from(legacyFrame));

  assert.deepStrictEqual(seen, [], 'legacy Content-Length frames should not be parsed on stdio');
}

async function testHandleRequestEmitsNewlineJson() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const captured = [];
  const originalWrite = process.stdout.write;

  process.stdout.write = ((chunk: any, encoding: any, callback: any) => {
    captured.push(String(chunk));
    if (typeof encoding === 'function') {
      encoding();
    } else if (typeof callback === 'function') {
      callback();
    }
    return true;
  }) as any;

  try {
    await mcpServer.handleRequest({
      id: 1,
      method: 'initialize',
      params: {}
    }, {
      profileRoot: repoRoot
    });

    await mcpServer.handleRequest({
      id: 2,
      method: 'tools/list',
      params: {}
    }, {
      profileRoot: repoRoot
    });
  } finally {
    process.stdout.write = originalWrite;
  }

  const output = captured.join('');
  assert.strictEqual(output.includes('Content-Length:'), false, 'server responses should not use Content-Length framing');

  const responses = output
    .split('\n')
    .map((line) => line.trim())
    .filter((x: any) => x)
    .map((line) => JSON.parse(line));

  assert.strictEqual(responses.length, 2, 'expected two JSON-RPC responses');
  assert.strictEqual(responses[0].id, 1);
  assert.strictEqual(responses[0].result.serverInfo.name, 'bitshares-claw');
  assert.strictEqual(responses[1].id, 2);
  assert.ok(Array.isArray(responses[1].result.tools), 'tools/list should return a tool list');
  assert.ok(
    responses[1].result.tools.some((tool) => tool.name === 'claw_runtime'),
    'tools/list should include claw_runtime'
  );
  assert.strictEqual(
    responses[1].result.tools.some((tool) => String(tool.name).startsWith('mcp_claw_')),
    false,
    'tools/list should expose the raw claw_* tool ids from the MCP server'
  );
}

function runServerProcess(input) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const clawRoot = path.resolve(__dirname, '..');
  const _isDist = isDistCodeRoot(path.dirname(__dirname));
  const scriptPath = path.join(clawRoot, 'scripts', 'claw_mcp_server' + (_isDist ? '.js' : '.ts'));
  const scriptRel = path.relative(repoRoot, scriptPath);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-mcp-transport-'));
  const inputPath = path.join(tmpRoot, 'input.jsonl');
  const outputPath = path.join(tmpRoot, 'output.jsonl');
  fs.writeFileSync(inputPath, input, 'utf8');

  try {
    const loaderArgs = _isDist ? '' : '--import tsx ';
    const shellCommand = `cat ${shellQuote(inputPath)} | ${shellQuote(process.execPath)} --no-warnings ${loaderArgs}${shellQuote(scriptRel)} --profile-root ${shellQuote(repoRoot)} > ${shellQuote(outputPath)}`;
    const run = spawnSync('/bin/sh', ['-lc', shellCommand], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    return {
      exitCode: run.status,
      signal: run.signal,
      stdout: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '',
      stderr: run.stderr || ''
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function testMainEntrypointHandlesRealProcessInitialize() {
  const initMessage = encodeNewlineMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      capabilities: {},
      clientInfo: {
        name: 'claw-mcp-transport-test',
        version: '1.4.13'
      },
      protocolVersion: '2024-11-05'
    }
  });

  const listMessage = encodeNewlineMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });

  const run = runServerProcess(initMessage + listMessage);

  assert.strictEqual(run.exitCode, 0, `claw_mcp_server should exit cleanly, got code ${run.exitCode} signal ${run.signal}\nSTDERR:\n${run.stderr}`);
  assert.strictEqual(run.signal, null);
  assert.strictEqual(run.stderr.trim(), '', `claw_mcp_server should not write to stderr:\n${run.stderr}`);
  assert.strictEqual(run.stdout.includes('Content-Length:'), false, 'stdout should stay newline-delimited');

  const responses = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((x: any) => x)
    .map((line) => JSON.parse(line));

  assert.strictEqual(responses.length, 2, 'expected two JSON-RPC responses from the entrypoint');
  assert.strictEqual(responses[0].id, 1);
  assert.strictEqual(responses[0].result.serverInfo.name, 'bitshares-claw');
  assert.strictEqual(responses[1].id, 2);
  assert.ok(Array.isArray(responses[1].result.tools), 'tools/list should return a tool array');
  assert.ok(
    responses[1].result.tools.some((tool) => tool.name === 'claw_manifest'),
    'tools/list should include claw_manifest'
  );
  assert.strictEqual(
    responses[1].result.tools.some((tool) => String(tool.name).startsWith('mcp_claw_')),
    false,
    'entrypoint should expose raw claw_* tool ids from the MCP server'
  );
}

async function main() {
  await testParserAcceptsJsonlAcrossChunksAndSingleBuffer();
  await testParserIgnoresLegacyContentLengthFrames();
  await testHandleRequestEmitsNewlineJson();
  await testMainEntrypointHandlesRealProcessInitialize();
  console.log('claw mcp transport regression test passed');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : getErrorMessage(err));
  process.exit(1);
});
