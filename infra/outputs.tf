# ─────────────────────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────────────────────

output "api_gateway_url" {
  description = "Base URL of the cloud-penny HTTP API Gateway"
  value       = data.aws_apigatewayv2_api.main.api_endpoint
}

output "api_gateway_id" {
  description = "ID of the API Gateway (for reference)"
  value       = data.aws_apigatewayv2_api.main.id
}

output "lambda_function_names" {
  description = "Map of local function name → actual AWS function name"
  value = {
    for k, fn in aws_lambda_function.functions : k => fn.function_name
  }
}

output "lambda_function_arns" {
  description = "Map of local function name → function ARN"
  value = {
    for k, fn in aws_lambda_function.functions : k => fn.arn
  }
}

output "lambda_invoke_arns" {
  description = "Map of local function name → invoke ARN (used by API GW)"
  value = {
    for k, fn in aws_lambda_function.functions : k => fn.invoke_arn
  }
}

output "cloudwatch_log_group" {
  description = "Shared CloudWatch log group for all Lambda functions"
  value       = aws_cloudwatch_log_group.lambda_logs.name
}

output "cloudwatch_log_group_arn" {
  description = "ARN of the shared CloudWatch log group"
  value       = aws_cloudwatch_log_group.lambda_logs.arn
}

output "api_routes" {
  description = "Map of Terraform route key → API Gateway route key (METHOD /path)"
  value = {
    for k, route in aws_apigatewayv2_route.routes : k => route.route_key
  }
}

output "environment" {
  description = "Active deployment environment"
  value       = var.environment
}

output "aws_account_id" {
  description = "AWS account ID"
  value       = data.aws_caller_identity.current.account_id
}
