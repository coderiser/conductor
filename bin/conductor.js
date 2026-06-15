#!/usr/bin/env node
// Thin launcher for the conductor CLI. The implementation lives in
// dist/cli/index.js (compiled from src/cli by `npm run build:daemon`).
// Keeping bin/ as a stable shim means the `bin` field in package.json never
// moves even as the compiled output changes.
const path = require('path');
const entry = path.join(__dirname, '..', 'dist', 'cli', 'index.js');
const fs = require('fs');
if (!fs.existsSync(entry)) {
  console.error('conductor CLI not built. Run `npm run build:daemon` first.');
  process.exit(1);
}
require(entry);
