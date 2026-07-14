#!/usr/bin/env node
/**
 * MCP Stdio-HTTP Bridge
 *
 * Bridges Claude Code's stdio-based MCP client to the knowledge-service HTTP API.
 * This allows Claude Code to use mcp__spaceos-knowledge__* tools.
 */

const readline = require('readline');
const http = require('http');

const MCP_HOST = process.env.MCP_HOST || 'localhost';
const MCP_PORT = parseInt(process.env.MCP_PORT || '3456', 10);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!AUTH_TOKEN) {
  console.error('MCP_AUTH_TOKEN env var is required (no hardcoded default — set it per-terminal).');
  process.exit(1);
}

// Setup readline for stdin only (don't bind to stdout)
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

// Forward JSON-RPC messages from stdin to HTTP endpoint
rl.on('line', (line) => {
  if (!line.trim()) return;

  let jsonrpcMessage;
  try {
    jsonrpcMessage = JSON.parse(line);
  } catch (err) {
    // Invalid JSON - send error response
    const errorResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32700,
        message: 'Parse error: Invalid JSON'
      },
      id: null
    };
    console.log(JSON.stringify(errorResponse));
    return;
  }

  // Forward to HTTP MCP server
  const postData = JSON.stringify(jsonrpcMessage);
  const options = {
    hostname: MCP_HOST,
    port: MCP_PORT,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
      'Authorization': `Bearer ${AUTH_TOKEN}`
    }
  };

  const req = http.request(options, (res) => {
    let responseData = '';

    res.on('data', (chunk) => {
      responseData += chunk;
    });

    res.on('end', () => {
      // Write response to stdout
      console.log(responseData.trim());
    });
  });

  req.on('error', (err) => {
    // HTTP request failed - send JSON-RPC error
    const errorResponse = {
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: `Internal error: ${err.message}`
      },
      id: jsonrpcMessage.id || null
    };
    console.log(JSON.stringify(errorResponse));
  });

  req.write(postData);
  req.end();
});

rl.on('close', () => {
  process.exit(0);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  rl.close();
});

process.on('SIGINT', () => {
  rl.close();
});
