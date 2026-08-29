#!/usr/bin/env node
'use strict';

/**
 * create-function.js
 *
 * Scaffolds a new Lambda function folder and adds an entry to functions.json.
 *
 * Usage:
 *   npm run create -- <function-name>
 *   npm run create -- <domain>/<function-name>
 *   node scripts/create-function.js <function-name>
 *
 * Examples:
 *   node scripts/create-function.js payments-create
 *   node scripts/create-function.js billing/payments-create
 *
 * What it does:
 *   1. Creates functions/[<domain>/]<name>/index.mjs from a template
 *   2. Appends a new entry to infra/functions.json (with "path" set when a
 *      domain was given, so the function lands in the right subfolder
 *      alongside its siblings — see functions/auth|aws-connection|billing|
 *      alerts|chat|support for the existing groupings)
 *   3. Prints next steps
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const CONFIG_PATH   = path.join(ROOT, 'infra', 'functions.json');

// ── Validate input ───────────────────────────────────────────
const rawArg = process.argv[2];

if (!rawArg) {
  console.error('\n❌  Usage: node scripts/create-function.js [<domain>/]<function-name>');
  console.error('    Example: node scripts/create-function.js billing/payments-create\n');
  process.exit(1);
}

// Optional "<domain>/<name>" shape — domain is just a subfolder under
// functions/, it never affects the deployed function name (fnName is the
// Terraform/AWS identity either way).
const slashIdx = rawArg.indexOf('/');
const domain = slashIdx === -1 ? null : rawArg.slice(0, slashIdx);
const fnName = slashIdx === -1 ? rawArg : rawArg.slice(slashIdx + 1);

if (!/^[a-z][a-z0-9-]*$/.test(fnName)) {
  console.error('\n❌  Function name must be lowercase letters, numbers, and hyphens.');
  console.error('    Valid:   clients-me, payments-create, users-list');
  console.error('    Invalid: ClientsMe, payments_create, 123-func\n');
  process.exit(1);
}

if (domain !== null && !/^[a-z][a-z0-9-]*$/.test(domain)) {
  console.error('\n❌  Domain must be lowercase letters, numbers, and hyphens.');
  console.error('    Valid:   billing, aws-connection\n');
  process.exit(1);
}

const relativePath = domain ? `${domain}/${fnName}` : fnName;
const functionDir = path.join(FUNCTIONS_DIR, relativePath);

if (fs.existsSync(functionDir)) {
  console.error(`\n❌  Function "${fnName}" already exists at:\n    ${functionDir}\n`);
  process.exit(1);
}

// ── Create folder + handler ──────────────────────────────────
// ESM (.mjs, `export const handler`) — every existing function in this
// project is written this way (root package.json has "type": "module"),
// so a scaffold emitting CommonJS would be inconsistent with the real
// convention and Lambda would resolve it differently at runtime.
fs.mkdirSync(functionDir, { recursive: true });

const handlerContent = `// ${fnName} — Lambda handler
// Created: ${new Date().toISOString().split('T')[0]}
//
// TODO: Add routes to infra/functions.json, then implement logic below.

const response = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*"
  },
  body: JSON.stringify(body)
});

const extractTenantId = (event) =>
  event?.requestContext?.authorizer?.jwt?.claims?.sub ??
  event?.requestContext?.authorizer?.claims?.sub ??
  null;

export const handler = async (event) => {
  console.log("EVENT_PRINT:", JSON.stringify(event, null, 2));

  const tenantId = extractTenantId(event);
  if (!tenantId) {
    console.warn("UNAUTHORIZED: No sub claim found in token");
    return response(401, { success: false, error: "Unauthorized — invalid or missing token" });
  }

  try {
    // TODO: implement your business logic here

    return response(200, { success: true, data: {} });
  } catch (err) {
    console.error("${fnName.toUpperCase().replace(/-/g, '_')}_ERROR:", err.message);
    return response(500, { success: false, error: "Internal server error" });
  }
};
`;

fs.writeFileSync(path.join(functionDir, 'index.mjs'), handlerContent);

// ── Append entry to functions.json ───────────────────────────
let functions = [];
try {
  functions = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`❌  Cannot read ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

const entry = {
  name:             fnName,
  description:      `TODO: describe ${fnName}`,
  aws_name_override: null,
  handler:          'index.handler',
  memory:           128,
  timeout:          10,
  environment:      {},
  routes:           [],  // Add routes here: { "method": "GET", "path": "/api/v1/..." }
};
// Only set "path" when it actually differs from "name" — zip-functions.js
// falls back to fn.name when "path" is absent, so this keeps entries for
// ungrouped functions exactly as terse as they'd otherwise be.
if (domain) entry.path = relativePath;

functions.push(entry);

fs.writeFileSync(CONFIG_PATH, JSON.stringify(functions, null, 2) + '\n');

// ── Success output ────────────────────────────────────────────
console.log(`
✅  Created function: ${fnName}

   📁  functions/${relativePath}/index.mjs   ← implement your logic here
   📋  infra/functions.json                 ← route definitions added (empty for now)

👉  Next steps:
   1. Add routes to the "${fnName}" entry in infra/functions.json:
         {
           "method": "GET",
           "path":   "/api/v1/your-path"
         }

   2. Implement your logic in functions/${fnName}/index.mjs

   3. Zip + deploy:
         npm run zip
         cd infra && terraform apply -var="environment=dev"

   4. Or just commit and push — GitHub Actions handles the rest.
`);
