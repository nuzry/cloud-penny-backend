#
# Resources managed here:
#   - CloudWatch Log Group (shared, /aws/lambda/cloud-penny)
#



data "aws_caller_identity" "current" {}

# Existing API Gateway HTTP API (cloud-penny)
data "aws_apigatewayv2_api" "main" {
  api_id = var.api_gateway_id
}

# Existing IAM execution role shared by all Lambda functions
data "aws_iam_role" "lambda_role" {
  name = var.lambda_role_name
}



resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = local.log_group_name # /aws/lambda/cloud-penny
  retention_in_days = var.log_retention_days

  # Tags are automatically inherited from provider default_tags.
  # Nothing extra needed here.
}


# CENTRAL CUR S3 BUCKET

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



resource "aws_lambda_function" "functions" {
  for_each = local.functions_map

  
  # If the function already exists in AWS under a different name, set
  # aws_name_override in functions.json before running terraform import.
  function_name = (
    try(each.value.aws_name_override, null) != null
    ? each.value.aws_name_override
    : "${var.project_name}-${each.key}-${var.environment}"
  )


  # Built by:  npm run zip  (scripts/zip-functions.js)
  filename         = "${path.module}/../dist/${each.key}.zip"
  source_code_hash = filebase64sha256("${path.module}/../dist/${each.key}.zip")


  role        = data.aws_iam_role.lambda_role.arn
  handler     = try(each.value.handler, "index.handler")
  runtime     = try(each.value.runtime, var.lambda_runtime)
  memory_size = try(each.value.memory, 128)
  timeout     = try(each.value.timeout, 10)

  environment {
    variables = merge(
      {
        ENVIRONMENT           = var.environment
        PROJECT               = var.project_name
        FUNCTION_NAME         = each.key
        ANOMALY_SNS_TOPIC_ARN = aws_sns_topic.anomaly_alerts.arn
      },
      try(each.value.environment, {})
    )
  }

  # Direct all logs to the shared /aws/lambda/cloud-penny log group.
  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lambda_logs.name
  }

  # X-Ray active tracing
  tracing_config {
    mode = "Active"
  }

  description = try(each.value.description, "")

  # provider default_tags adds project/environment/managed_by automatically.
  tags = {
    function = each.key
  }

  depends_on = [aws_cloudwatch_log_group.lambda_logs]
}


# One integration per function (multiple routes can share one integration)

resource "aws_apigatewayv2_integration" "functions" {
  for_each = local.functions_map

  api_id                 = data.aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.functions[each.key].invoke_arn
  payload_format_version = "2.0"

  # Optional: add a description for visibility in the console
  description = "Integration for ${each.key} (${var.environment})"
}


# One route per entry in each function's "routes" array

resource "aws_apigatewayv2_route" "routes" {
  for_each = local.routes_map

  api_id    = data.aws_apigatewayv2_api.main.id
  route_key = "${each.value.method} ${each.value.path}"

  authorization_type = "JWT"
  authorizer_id      = var.api_gateway_authorizer_id

  # Wire route integration for the owning function
  target = "integrations/${aws_apigatewayv2_integration.functions[each.value.function_name].id}"
}



resource "aws_lambda_permission" "api_gateway" {
  for_each = local.functions_map

  statement_id  = "AllowAPIGatewayInvoke-${var.environment}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions[each.key].function_name
  principal     = "apigateway.amazonaws.com"

  # Restrict to this specific API, all stages, all routes
  source_arn = "${data.aws_apigatewayv2_api.main.execution_arn}/*/*"
}


# SQS QUEUE for CUR Updates

resource "aws_sqs_queue" "cur_updates" {
  name = "cloudpenny-cur-updates-${var.environment}"
  # Optional: Configure visibility timeout, typically 6x Lambda timeout
  visibility_timeout_seconds = 180
}

# Allow S3 to send messages to the SQS queue
resource "aws_sqs_queue_policy" "cur_updates_policy" {
  queue_url = aws_sqs_queue.cur_updates.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "s3.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.cur_updates.arn
        Condition = {
          ArnLike = {
            "aws:SourceArn" = aws_s3_bucket.central_curs.arn
          }
        }
      }
    ]
  })
}

# S3 EVENT NOTIFICATIONS

resource "aws_s3_bucket_notification" "bucket_notification" {
  bucket = aws_s3_bucket.central_curs.id

  queue {
    queue_arn = aws_sqs_queue.cur_updates.arn
    events    = ["s3:ObjectCreated:*"]
  }

  depends_on = [aws_sqs_queue_policy.cur_updates_policy]
}

# LAMBDA EVENT SOURCE MAPPING (SQS -> Lambda)

resource "aws_lambda_event_source_mapping" "sqs_trigger" {
  # We look up the specific lambda we just created
  event_source_arn = aws_sqs_queue.cur_updates.arn
  function_name    = aws_lambda_function.functions["cloud-penny-processCurUpdate"].arn
  batch_size       = 10
}

# IAM PERMISSIONS FOR LAMBDA TO READ FROM SQS

resource "aws_iam_role_policy" "lambda_sqs_access" {
  name = "${var.project_name}-lambda-sqs-access-${var.environment}"
  role = data.aws_iam_role.lambda_role.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes"
        ]
        Resource = aws_sqs_queue.cur_updates.arn
      }
    ]
  })
}


# ATHENA RESULTS BUCKET
resource "aws_s3_bucket" "athena_results" {
  bucket = "${var.project_name}-athena-results-${var.environment}"
}
resource "aws_s3_bucket_lifecycle_configuration" "athena_results_cleanup" {
  bucket = aws_s3_bucket.athena_results.id
  rule {
    id     = "expire-old-results"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
  }
}

# GLUE DATABASE & CRAWLER FOR CUR
resource "aws_glue_catalog_database" "cur_db" {
  name = "cloudpenny_curs_${var.environment}"
}

# IAM Role for Glue Crawler
resource "aws_iam_role" "glue_crawler_role" {
  name = "${var.project_name}-glue-crawler-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "glue.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "glue_service_role" {
  role       = aws_iam_role.glue_crawler_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole"
}

resource "aws_iam_role_policy" "glue_s3_access" {
  name = "${var.project_name}-glue-s3-access-${var.environment}"
  role = aws_iam_role.glue_crawler_role.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = ["${aws_s3_bucket.central_curs.arn}/*"]
      }
    ]
  })
}

resource "aws_glue_crawler" "cur_crawler" {
  database_name = aws_glue_catalog_database.cur_db.name
  name          = "cloudpenny-cur-crawler-${var.environment}"
  role          = aws_iam_role.glue_crawler_role.arn

  s3_target {
    path = "s3://${aws_s3_bucket.central_curs.bucket}"
  }

  configuration = jsonencode({
    Version = 1.0
    Grouping = {
      TableGroupingPolicy = "CombineCompatibleSchemas"
    }
    CrawlerOutput = {
      Partitions = { AddOrUpdateBehavior = "InheritFromTable" }
    }
  })
}

# DYNAMODB TABLE - SNAPSHOTS
resource "aws_dynamodb_table" "snapshots" {
  name         = "cloudpenny-snapshots-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "snapshotId"

  attribute {
    name = "tenantId"
    type = "S"
  }
  attribute {
    name = "snapshotId"
    type = "S"
  }
}

# EVENTBRIDGE RULE (Athena -> Lambda)
resource "aws_cloudwatch_event_rule" "athena_success" {
  name        = "cloudpenny-athena-success-${var.environment}"
  description = "Trigger saveSnapshot Lambda on Athena Query SUCCEEDED"

  event_pattern = jsonencode({
    source        = ["aws.athena"]
    "detail-type" = ["Athena Query State Change"]
    detail = {
      currentState = ["SUCCEEDED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "trigger_lambda" {
  rule      = aws_cloudwatch_event_rule.athena_success.name
  target_id = "TriggerSaveSnapshotLambda"
  arn       = aws_lambda_function.functions["cloud-penny-saveSnapshot"].arn
}

resource "aws_lambda_permission" "allow_eventbridge" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions["cloud-penny-saveSnapshot"].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.athena_success.arn
}

# ADDITIONAL IAM PERMISSIONS FOR LAMBDAS
resource "aws_iam_role_policy" "lambda_athena_dynamo" {
  name = "${var.project_name}-lambda-athena-dynamo-${var.environment}"
  role = data.aws_iam_role.lambda_role.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetDatabase",
          "glue:GetPartitions"
        ]
        Resource = ["*"]
      },
      {
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation"]
        Resource = [
          aws_s3_bucket.central_curs.arn,
          "${aws_s3_bucket.central_curs.arn}/*",
          aws_s3_bucket.athena_results.arn,
          "${aws_s3_bucket.athena_results.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:GetItem",
          "dynamodb:Query"
        ]
        Resource = [aws_dynamodb_table.snapshots.arn]
      }
    ]
  })
}



resource "aws_sns_topic" "anomaly_alerts" {
  name = "cloudpenny-anomaly-alerts-${var.environment}"
}

resource "aws_sns_topic_policy" "anomaly_alerts_policy" {
  arn = aws_sns_topic.anomaly_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCostAnomalyDetection"
        Effect = "Allow"
        Principal = {
          Service = "costalerts.amazonaws.com"
        }
        Action   = "sns:Publish"
        Resource = aws_sns_topic.anomaly_alerts.arn
      }
    ]
  })
}

resource "aws_sns_topic_subscription" "anomaly_lambda" {
  topic_arn = aws_sns_topic.anomaly_alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.functions["cloud-penny-processAnomalyAlert"].arn
}

resource "aws_lambda_permission" "sns_invoke_anomaly_alert" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.functions["cloud-penny-processAnomalyAlert"].function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.anomaly_alerts.arn
}

# -----------------------------------------------------------
# LAMBDA SES PERMISSIONS
# -----------------------------------------------------------

resource "aws_iam_role_policy" "lambda_ses_access" {
  name = "${var.project_name}-lambda-ses-access-${var.environment}"
  role = data.aws_iam_role.lambda_role.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ]
        Resource = "*"
      }
    ]
  })
}



resource "aws_dynamodb_table" "alerts" {
  name         = "cloudpenny-alerts-${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "createdAt"

  attribute {
    name = "tenantId"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "S"
  }
}


resource "aws_iam_role_policy" "lambda_alerts_dynamo" {
  name = "cloud-penny-lambda-alerts-dynamo-${var.environment}"
  role = data.aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:Scan",
          "dynamodb:Query",
          "dynamodb:UpdateItem"
        ]
        Effect   = "Allow"
        Resource = aws_dynamodb_table.alerts.arn
      }
    ]
  })
}

