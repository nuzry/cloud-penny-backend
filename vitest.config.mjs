import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['node_modules', 'dist', 'infra/.terraform', 'bootstrap'],
    coverage: {
      provider: 'v8',
      include: ['functions/**/*.mjs'],
      exclude: ['functions/**/*.test.mjs'],
    },
    // Applied to process.env before any test module (and therefore before
    // the handler module it imports) evaluates — several handlers read a
    // required env var at module scope with no `??` fallback, so this has
    // to happen ahead of the static import, not inside a test/beforeEach.
    env: {
      TENANTS_TABLE: 'cloudpenny-tenants',
      ALERTS_TABLE: 'cloudpenny-alerts-dev',
      SNAPSHOTS_TABLE: 'cloudpenny-snapshots-dev',
      SUPPORT_TABLE: 'cloudpenny-support-dev',
      CENTRAL_CURS_BUCKET: 'cloudpenny-central-curs-dev',
      COGNITO_USER_POOL_ID: 'ap-southeast-1_testpool',
      ATHENA_RESULTS_BUCKET: 'cloud-penny-athena-results-dev',
      ANOMALY_SNS_TOPIC_ARN: 'arn:aws:sns:ap-southeast-1:123456789012:cloudpenny-anomaly-alerts-dev',
      SENDER_EMAIL: 'test@cloudpenny.test',
      GROQ_SECRET_NAME: 'cloudpenny-groq-api-key-dev',
      GROQ_MODEL_ID: 'openai/gpt-oss-120b',
      TELEGRAM_SECRET_NAME: 'cloudpenny-telegram-bot-dev',
      TELEGRAM_CHAT_ID: '-1000000000',
      COGNITO_DOMAIN: 'test-pool.auth.ap-southeast-1.amazoncognito.com',
      COGNITO_CLIENT_ID: 'test-client-id',
      ALLOWED_REDIRECT_URIS: 'http://localhost:5173/,https://app.example.test/',
      REFRESH_TOKEN_MAX_AGE_SECONDS: '432000',
      ENVIRONMENT: 'dev',
    },
  },
});
