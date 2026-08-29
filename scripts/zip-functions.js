#!/usr/bin/env node
'use strict';

/**
 * zip-functions.js
 *
 * Reads infra/functions.json and zips each function's source folder
 * (functions/<path>/, where <path> defaults to <name> if not set — functions
 * are grouped into domain subfolders like functions/auth/getClientMe/, so
 * the on-disk location and the deployed identity are independent) into
 * dist/<name>.zip — ready for Terraform to upload.
 *
 * Usage:  npm run zip
 *         node scripts/zip-functions.js
 */

const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');

const ROOT         = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const DIST_DIR     = path.join(ROOT, 'dist');
const CONFIG_PATH  = path.join(ROOT, 'infra', 'functions.json');

// ── Read config ───────────────────────────────────────────────
let functions;
try {
  functions = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`❌  Cannot read ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

// ── Ensure dist/ exists ────────────────────────────────────────
fs.mkdirSync(DIST_DIR, { recursive: true });

// ── Zip one function ──────────────────────────────────────────
function zipFunction(fn) {
  return new Promise((resolve, reject) => {
    // fn.path is the on-disk location (e.g. "auth/getClientMe"); fn.name is
    // the deployed/Terraform identity and always drives the zip filename —
    // never the other way around, so moving a function's folder can never
    // accidentally rename the live Lambda function.
    const sourceDir  = path.join(FUNCTIONS_DIR, fn.path ?? fn.name);
    const outputPath = path.join(DIST_DIR, `${fn.name}.zip`);

    if (!fs.existsSync(sourceDir)) {
      console.warn(`  ⚠️  Skipping "${fn.name}" — folder not found: ${sourceDir}`);
      return resolve({ skipped: true });
    }

    const output  = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      const kb = (archive.pointer() / 1024).toFixed(1);
      console.log(`  ✅  ${fn.name}.zip  (${kb} KB)`);
      resolve({ skipped: false, size: archive.pointer() });
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        console.warn(`  ⚠️  ${fn.name}: ${err.message}`);
      } else {
        reject(err);
      }
    });

    archive.on('error', reject);

    archive.pipe(output);

    // Add all files from the function folder — flat (no parent dir) — except
    // test files, which live alongside index.mjs but have no business in the
    // deployed Lambda package.
    archive.directory(sourceDir, false, (entry) =>
      entry.name.endsWith('.test.mjs') ? false : entry
    );

    archive.finalize();
  });
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log(`\n📦  Zipping ${functions.length} function(s) → dist/\n`);

  let zipped  = 0;
  let skipped = 0;

  for (const fn of functions) {
    const result = await zipFunction(fn);
    if (result.skipped) skipped++;
    else zipped++;
  }

  console.log(`\n✨  Done — ${zipped} zipped, ${skipped} skipped\n`);

  if (skipped > 0) {
    console.log(`   Skipped functions have no folder under functions/`);
    console.log(`   Run: node scripts/create-function.js <name>  to scaffold one\n`);
  }

  if (zipped === 0) {
    console.error('❌  No functions were zipped. Terraform will fail if it cannot find dist/*.zip');
    process.exit(1);
  }
})().catch((err) => {
  console.error(`\n❌  Fatal error: ${err.message}`);
  process.exit(1);
});
