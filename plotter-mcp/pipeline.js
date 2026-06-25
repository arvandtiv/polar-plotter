/**
 * @deprecated Import from ./core.js instead (built from console/src/lib/mcp-core.ts).
 * This shim keeps old imports working until callers are updated.
 */
export {
  compilePaths as compile,
  compilePathsWithWarp,
  expandGenerator,
  boundsFromFirmware,
  listGenerators,
  listModules,
  getModule,
} from './core.js';