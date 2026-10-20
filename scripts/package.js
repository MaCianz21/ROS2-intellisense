#!/usr/bin/env node
/**
 * `vsce package` wrapper.
 *
 * vsce 3.9+ depends on undici 7, which assumes the global `File` (Node 20+).
 * On Node 18 that global is missing, so `npx vsce package` dies with
 * `ReferenceError: File is not defined` before doing anything. Node 18 has the
 * same class in `node:buffer`, so expose it and then hand over to vsce.
 *
 * Run via `npm run package` (extra arguments are forwarded, e.g.
 * `npm run package -- --out /tmp`).
 */
globalThis.File ??= require('node:buffer').File;

// `npm run package` invokes us without the subcommand, so add it; extra flags
// (`npm run package -- --out /tmp`) are appended after it.
require('@vscode/vsce/out/main')([
    process.argv[0],
    process.argv[1],
    'package',
    ...process.argv.slice(2),
]);
