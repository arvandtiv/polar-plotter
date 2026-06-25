#!/usr/bin/env node
/**
 * Bundle console/src/lib/mcp-core.ts → plotter-mcp/core.js
 * One shared pipeline for browser Studio, Script tab, and MCP.
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '../console/src/lib/mcp-core.ts');
const outfile = path.join(here, 'core.js');

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  target: 'node18',
  logLevel: 'info',
});

console.log(`Built ${outfile}`);