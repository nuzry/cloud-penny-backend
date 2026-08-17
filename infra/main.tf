# ─────────────────────────────────────────────────────────────
# main.tf — Core infrastructure
#
# Resources managed here:
#   - CloudWatch Log Group (shared, /aws/lambda/cloud-penny)
#   - aws_lambda_function   — one per entry in functions.json
#   - aws_apigatewayv2_integration — one per function
#   - aws_apigatewayv2_route       — one per route in functions.json
#   - aws_lambda_permission        — allows API GW to invoke each function
#
# Data sources (existing AWS resources — NOT re-created):
#   - aws_caller_identity   — current AWS account
#   - aws_apigatewayv2_api  — existing cloud-penny HTTP API
#   - aws_iam_role          — existing cloud-penny-lambda-role
# ─────────────────────────────────────────────────────────────


# ═══════════════════════════════════════════════════════════
# DATA SOURCES — reference existing AWS resources
# ═══════════════════════════════════════════════════════════

data "aws_caller_identity" "current" {}

# Existing API Gateway HTTP API (cloud-penny)
data "aws_apigatewayv2_api" "main" {
  api_id = var.api_gateway_id
}

# Existing IAM execution role shared by all Lambda functions
data "aws_iam_role" "lambda_role" {
  name = var.lambda_role_name
}


# ═══════════════════════════════════════════════════════════
# CLOUDWATCH — shared log group for all Lambda functions
# ═══════════════════════════════════════════════════════════

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = local.log_group_name   # /aws/lambda/cloud-penny
  retention_in_days = var.log_retention_days

  # Tags are automatically inherited from provider default_tags.
  # Nothing extra needed here.
}


# ═══════════════════════════════════════════════════════════
# CENTRAL CUR S3 BUCKET
# ═══════════════════════════════════════════════════════════

resource "aws_s3_bucket" "central_curs" {
  bucket = "${var.central_curs_bucket_name}-${var.environment}"

  # tags inherited from provider
}

resource "aws_s3_bucket_versioning" "central_curs" {
  bucket = aws_s3_bucket.central_curs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "central_curs" {
  bucket = aws_s3_bucket.central_curs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "central_curs" {
  bucket                  = aws_s3_bucket.central_curs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "central_curs" {
  bucket = aws_s3_bucket.central_curs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowBillingReports"
        Effect = "Allow"
        Principal = {
          Service = "billingreports.amazonaws.com"
        }
        Action = [
          "s3:GetBucketAcl",
          "s3:GetBucketPolicy"
        ]
        Resource = aws_s3_bucket.central_curs.arn
      }
      # The PutObject permissions will be managed dynamically by the Lambda function
      # to whitelist specific client AWS Account IDs using aws:SourceAccount.
    ]
  })

  # Ignore changes to the policy made outside Terraform (e.g., by the Lambda function)
  lifecycle {
    ignore_changes = [policy]
  }
}

# Allow Lambda execution role to read from and modify the bucket policy of the central CUR bucket
resource "aws_iam_role_policy" "lambda_s3_access" {
  name = "${var.project_name}-lambda-s3-access-${var.environment}"
  role = data.aws_iam_role.lambda_role.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetBucketPolicy",
          "s3:PutBucketPolicy",
          "s3:GetObject",
          "s3:ListBucket"
        ]
        Resource = [
          aws_s3_bucket.central_curs.arn,
          "${aws_s3_bucket.central_curs.arn}/*"
        ]
      }
    ]
  })
}


# ═══════════════════════════════════════════════════════════
# LAMBDA FUNCTIONS — one per entry in functions.json
# ═══════════════════════════════════════════════════════════

resource "aws_lambda_function" "functions" {
  for_each = local.functions_map

  # ── Naming ─────────────────────────────────────────────────
  # If the function already exists in AWS under a different name, set
  # aws_name_override in functions.json before running terraform import.
  function_name = (
    try(each.value.aws_name_override, null) != null
    ? each.value.aws_name_override
    : "${var.project_name}-${each.key}-${var.environment}"
  )

  # ── Code artifact ──────────────────────────────────────────
  # Built by:  npm run zip  (scripts/zip-functions.js)
  filename         = "${path.module}/../dist/${each.key}.zip"
  source_code_hash = filebase64sha256("${path.module}/../dist/${each.key}.zip")

  # ── Runtime ────────────────────────────────────────────────
  role        = data.aws_iam_role.lambda_role.arn
  handler     = try(each.value.handler, "index.handler")
  runtime     = try(each.value.runtime, var.lambda_runtime)
  memory_size = try(each.value.memory, 128)
  timeout     = try(each.value.timeout, 10)

  # ── Environment variables ───────────────────────────────────
  environment {
    variables = merge(
      {
        ENVIRONMENT   = var.environment
        PROJECT       = var.project_name
        FUNCTION_NAME = each.key
      },
      try(each.value.environment, {})
    )
  }

  # ── Observability ───────────────────────────────────────────
  # Direct all logs to the shared /aws/lambda/cloud-penny log group.
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lambda_logs.name
  }

  # X-Ray active tracing
  tracing_config {
    mode = "Active"
  }

  description   = try(each.value.description, "")

  # ── Tags ────────────────────────────────────────────────────
  # provider default_tags adds project/environment/managed_by automatically.
  tags = {
    function    = each.key
  }

  depends_on = [aws_cloudwatch_log_group.lambda_logs]
}


# ═══════════════════════════════════════════════════════════
# API GATEWAY — Lambda proxy integrations
# One integration per function (multiple routes can share one integration)
# ═══════════════════════════════════════════════════════════

resource "aws_apigatewayv2_integration" "functions" {
  for_each = local.functions_map

  api_id                 = data.aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions[each.key].invoke_arn
  payload_format_version = "2.0"

  # Optional: add a description for visibility in the console
  description = "Integration for ${each.key} (${var.environment})"
}


# ═══════════════════════════════════════════════════════════
# API GATEWAY — Routes
# One route per entry in each function's "routes" array
# ═══════════════════════════════════════════════════════════

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes_map

  api_id    = data.aws_apigatewayv2_api.main.id
  route_key = "${each.value.method} ${each.value.path}"

  authorization_type = "JWT"
  authorizer_id      = var.api_gateway_authorizer_id

  # Wire route → integration for the owning function
  target = "integrations/${aws_apigatewayv2_integration.functions[each.value.function_name].id}"
}


# ═══════════════════════════════════════════════════════════
# LAMBDA PERMISSIONS — allow API Gateway to invoke each function
# ═══════════════════════════════════════════════════════════

resource "aws_lambda_permission" "api_gateway" {
  for_each = local.functions_map

  statement_id  = "AllowAPIGatewayInvoke-${var.environment}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions[each.key].function_name
  principal     = "apigateway.amazonaws.com"

  # Restrict to this specific API, all stages, all routes
  source_arn = "${data.aws_apigatewayv2_api.main.execution_arn}/*/*"
}
