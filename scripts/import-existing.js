#!/usr/bin/env node
'use strict';

/**
 * import-existing.js
 *
 * Inspects your existing AWS resources (Lambda functions, API Gateway integrations
 * and routes) and generates the correct `terraform import` commands to bring them
 * under Terraform management — without recreating or destroying anything.
 *
 * Prerequisites:
 *   - AWS CLI installed and configured (aws configure or env vars)
 *   - infra/functions.json populated with existing function names
 *   - terraform init already run (so the state backend is initialised)
 *
 * Usage:
 *   node scripts/import-existing.js [environment]
 *   node scripts/import-existing.js dev
 *
 * Environment variables (override defaults):
 *   API_GATEWAY_ID   — default: d9olex4f3k
 *   PROJECT_NAME     — default: cloud-penny
 *   AWS_REGION       — default: ap-southeast-1
 */

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT        = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'infra', 'functions.json');

const ENVIRONMENT     = process.argv[2] ?? 'dev';
const API_GATEWAY_ID  = process.env.API_GATEWAY_ID  ?? 'd9olex4f3k';
const PROJECT_NAME    = process.env.PROJECT_NAME    ?? 'cloud-penny';
const AWS_REGION      = process.env.AWS_REGION      ?? 'ap-southeast-1';

const hr = '─'.repeat(54);

console.log(`\n${hr}`);
console.log(` 🔍  Terraform Import Helper — cloud-penny`);
console.log(hr);
console.log(` Environment : ${ENVIRONMENT}`);
console.log(` API Gateway : ${API_GATEWAY_ID}`);
console.log(` Region      : ${AWS_REGION}`);
console.log(`${hr}\n`);

// ── Read config ───────────────────────────────────────────────
let functions;
try {
  functions = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error(`❌  Cannot read ${CONFIG_PATH}: ${err.message}`);
  process.exit(1);
}

const importCommands = [];

// ── Helpers ───────────────────────────────────────────────────
function awsCLI(cmd) {
  try {
    const out = execSync(
      `aws ${cmd} --region ${AWS_REGION} --output json`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return JSON.parse(out.toString().trim());
  } catch {
    return null;
  }
}

/**
 * Replicates the key formula used in infra/locals.tf:
 *   "${fn.name}__${route.method}__${trimprefix(replace(replace(route.path,"/","_"),"-","_"),"_")}"
 */
function buildRouteKey(fnName, method, routePath) {
  const pathPart = routePath
    .replace(/\//g, '_')
    .replace(/-/g, '_')
    .replace(/^_/, ''); // trimprefix
  return `${fnName}__${method}__${pathPart}`;
}

// ─────────────────────────────────────────────────────────────
// 1. Lambda Functions
// ─────────────────────────────────────────────────────────────
console.log(' Lambda Functions\n');

for (const fn of functions) {
  const awsName = fn.aws_name_override
    ?? `${PROJECT_NAME}-${fn.name}-${ENVIRONMENT}`;

  process.stdout.write(`  ${fn.name}  →  ${awsName}  `);

  const result = awsCLI(`lambda get-function --function-name ${awsName}`);

  if (result?.Configuration) {
    console.log('✅  exists');

    // Escape the for_each key for bash single-quote wrapping
    const tfAddr = `aws_lambda_function.functions["${fn.name}"]`;
    importCommands.push({
      description: `Lambda: ${fn.name}`,
      cmd:         `terraform -chdir=infra import '${tfAddr}' ${awsName}`,
    });
  } else {
    console.log('⏭️   not found (will be created)');
  }
}

// ─────────────────────────────────────────────────────────────
// 2. API Gateway Integrations
// ─────────────────────────────────────────────────────────────
console.log('\n API Gateway Integrations\n');

const integrationsResp = awsCLI(
  `apigatewayv2 get-integrations --api-id ${API_GATEWAY_ID}`
);
const integrations = integrationsResp?.Items ?? [];

for (const fn of functions) {
  const awsName = fn.aws_name_override
    ?? `${PROJECT_NAME}-${fn.name}-${ENVIRONMENT}`;

  process.stdout.write(`  ${fn.name}  `);

  // Match by integration URI containing the function name
  const match = integrations.find(
    (i) => i.IntegrationUri?.includes(awsName)
  );

  if (match) {
    console.log(`✅  ${match.IntegrationId}`);
    const tfAddr = `aws_apigatewayv2_integration.functions["${fn.name}"]`;
    importCommands.push({
      description: `Integration: ${fn.name}`,
      cmd:         `terraform -chdir=infra import '${tfAddr}' ${API_GATEWAY_ID}/${match.IntegrationId}`,
    });
  } else {
    console.log('⏭️   not found (will be created)');
  }
}

// ─────────────────────────────────────────────────────────────
// 3. API Gateway Routes
// ─────────────────────────────────────────────────────────────
console.log('\n API Gateway Routes\n');

const routesResp = awsCLI(
  `apigatewayv2 get-routes --api-id ${API_GATEWAY_ID}`
);
const awsRoutes = routesResp?.Items ?? [];

for (const fn of functions) {
  for (const route of (fn.routes ?? [])) {
    const routeKey   = `${route.method} ${route.path}`;
    const terraformKey = buildRouteKey(fn.name, route.method, route.path);

    process.stdout.write(`  ${routeKey.padEnd(42)}  `);

    const match = awsRoutes.find((r) => r.RouteKey === routeKey);

    if (match) {
      console.log(`✅  ${match.RouteId}`);
      const tfAddr = `aws_apigatewayv2_route.routes["${terraformKey}"]`;
      importCommands.push({
        description: `Route: ${routeKey}`,
        cmd:         `terraform -chdir=infra import '${tfAddr}' ${API_GATEWAY_ID}/${match.RouteId}`,
      });
    } else {
      console.log('⏭️   not found (will be created)');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 4. CloudWatch Log Group
// ─────────────────────────────────────────────────────────────
console.log('\n CloudWatch Log Group\n');

const logGroupName = `/aws/lambda/${PROJECT_NAME}`;
const logsResp     = awsCLI(
  `logs describe-log-groups --log-group-name-prefix "${logGroupName}"`
);
const lgMatch = logsResp?.logGroups?.find(
  (lg) => lg.logGroupName === logGroupName
);

process.stdout.write(`  ${logGroupName}  `);
if (lgMatch) {
  console.log('✅  exists');
  importCommands.push({
    description: `CloudWatch Log Group: ${logGroupName}`,
    cmd:         `terraform -chdir=infra import aws_cloudwatch_log_group.lambda_logs "${logGroupName}"`,
  });
} else {
  console.log('⏭️   not found (will be created)');
}

// ─────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────
console.log(`\n${hr}`);

if (importCommands.length === 0) {
  console.log(' No existing resources found — all will be created fresh.');
  console.log(hr);
  process.exit(0);
}

console.log(` 📋  Import commands (${importCommands.length} resources)`);
console.log(hr);
console.log('');

importCommands.forEach(({ description, cmd }) => {
  console.log(`# ${description}`);
  console.log(cmd);
  console.log('');
});

// Save to import.sh
const scriptLines = [
  '#!/bin/bash',
  `# Auto-generated by: node scripts/import-existing.js ${ENVIRONMENT}`,
  `# Generated: ${new Date().toISOString()}`,
  '# Run from the project root: bash import.sh',
  '',
  'set -euo pipefail',
  '',
  ...importCommands.flatMap(({ description, cmd }) => [
    `# ${description}`,
    cmd,
    '',
  ]),
];

const importScriptPath = path.join(ROOT, 'import.sh');
fs.writeFileSync(importScriptPath, scriptLines.join('\n'));
fs.chmodSync(importScriptPath, '755');

console.log(`${hr}`);
console.log(` 💾  Saved to import.sh`);
console.log(` ▶️   Run:  bash import.sh`);
console.log(`${hr}\n`);
