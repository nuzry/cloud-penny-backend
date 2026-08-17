#!/usr/bin/env node
'use strict';

/**
 * create-function.js
 *
 * Scaffolds a new Lambda function folder and adds an entry to functions.json.
 *
 * Usage:
 *   npm run create -- <function-name>
 *   node scripts/create-function.js <function-name>
 *
 * Example:
 *   node scripts/create-function.js payments-create
 *
 * What it does:
 *   1. Creates functions/<name>/index.js from a template
 *   2. Appends a new entry to infra/functions.json
 *   3. Prints next steps
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');
const CONFIG_PATH   = path.join(ROOT, 'infra', 'functions.json');

// ── Validate input ───────────────────────────────────────────
const fnName = process.argv[2];

if (!fnName) {
  console.error('\n❌  Usage: node scripts/create-function.js <function-name>');
  console.error('    Example: node scripts/create-function.js payments-create\n');
  process.exit(1);
}

if (!/^[a-z][a-z0-9-]*$/.test(fnName)) {
  console.error('\n❌  Function name must be lowercase letters, numbers, and hyphens.');
  console.error('    Valid:   clients-me, payments-create, users-list');
  console.error('    Invalid: ClientsMe, payments_create, 123-func\n');
  process.exit(1);
}

const functionDir = path.join(FUNCTIONS_DIR, fnName);

if (fs.existsSync(functionDir)) {
  console.error(`\n❌  Function "${fnName}" already exists at:\n    ${functionDir}\n`);
  process.exit(1);
}

// ── Create folder + handler ──────────────────────────────────
fs.mkdirSync(functionDir, { recursive: true });

const handlerContent = `'use strict';

/**
 * ${fnName} — Lambda handler
 * Created: ${new Date().toISOString().split('T')[0]}
 *
 * TODO: Add routes to infra/functions.json, then implement logic below.
 */
exports.handler = async (event, context) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'UNKNOWN';

  console.log(JSON.stringify({
    level:     'INFO',
    requestId: context.awsRequestId,
    method,
    path:      event.rawPath,
    stage:     process.env.ENVIRONMENT,
  }));

  try {
    // TODO: implement your business logic here

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({
        message:  'Success',
        function: '${fnName}',
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error(JSON.stringify({ level: 'ERROR', error: err.message, stack: err.stack }));
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Internal server error' }),
    };
  }
};
`;

fs.writeFileSync(path.join(functionDir, 'index.js'), handlerContent);

// ── Append entry to functions.json ───────────────────────────
let functions = [];
try {
  functions = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`❌  Cannot read ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

functions.push({
  name:             fnName,
  description:      `TODO: describe ${fnName}`,
  aws_name_override: null,
  handler:          'index.handler',
  memory:           128,
  timeout:          10,
  environment:      {},
  routes:           [],  // Add routes here: { "method": "GET", "path": "/api/v1/..." }
});

fs.writeFileSync(CONFIG_PATH, JSON.stringify(functions, null, 2) + '\n');

// ── Success output ────────────────────────────────────────────
console.log(`
✅  Created function: ${fnName}

   📁  functions/${fnName}/index.js   ← implement your logic here
   📋  infra/functions.json           ← route definitions added (empty for now)

👉  Next steps:
   1. Add routes to the "${fnName}" entry in infra/functions.json:
         {
           "method": "GET",
           "path":   "/api/v1/your-path"
         }

   2. Implement your logic in functions/${fnName}/index.js

   3. Zip + deploy:
         npm run zip
         cd infra && terraform apply -var="environment=dev"

   4. Or just commit and push — GitHub Actions handles the rest.
`);
