#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import pkg from '../package.json' with { type: 'json' };
import { logEvent } from './logging.js';
import { runTool } from './tool-helper.js';
import { SERVER_NAME, PROTOCOL_VERSION, CACHE_TTL_MS } from './identity.js';
import { PROMPTS } from './prompts.js';
import { TOOL_REGISTRY } from './tools.js';

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: pkg.version },
    {
      // Static tool and prompt sets: no list-changed notifications. Cached
      // catalogs help clients and prompt caches (SEP-2549).
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions:
        'Local review memory for geometry. Use remember to save a named feature or a plain note against revision-scoped entity IDs from the geometry server, recall to restore context (records are marked stale when the artifact revision changes), and forget to remove them. Stores authored meaning, not measured facts.',
      cacheHints: {
        'server/discover': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
        'tools/list': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
        'prompts/list': { ttlMs: CACHE_TTL_MS, cacheScope: 'public' },
      },
    },
  );

  for (const tool of TOOL_REGISTRY) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      // The registry intentionally contains heterogeneous tool schemas.
      // MCP validates each tool's input before this adapter runs.
      (args: unknown) => runTool(tool.name, () => tool.handler(args)),
    );
  }

  for (const prompt of PROMPTS) {
    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: prompt.argsSchema,
      },
      (args: unknown) => prompt.handler(args),
    );
  }

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const handle = serveStdio(createServer, { legacy: 'reject' });
  logEvent('server.started', { tools: TOOL_REGISTRY.length, protocol: PROTOCOL_VERSION });

  let closing: Promise<void> | undefined;
  const close = () => (closing ??= handle.close());
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
  process.stdin.once('end', () => void close());
}
