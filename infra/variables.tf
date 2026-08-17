# ─────────────────────────────────────────────────────────────
# Input Variables
# ─────────────────────────────────────────────────────────────

variable "aws_region" {
  description = "AWS region where all resources are deployed"
  type        = string
  default     = "ap-southeast-1" # Singapore
}

variable "environment" {
  description = "Deployment environment. Must be one of: dev, staging, prod."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "project_name" {
  description = "Project identifier used for resource naming and tagging."
  type        = string
  default     = "cloud-penny"
}

# ── Existing Resources ────────────────────────────────────────

variable "api_gateway_id" {
  description = "ID of the existing HTTP API Gateway that routes will be attached to."
  type        = string
  default     = "d9olex4f3k" # cloud-penny API (ap-southeast-1)
}

variable "api_gateway_authorizer_id" {
  description = "ID of the existing JWT authorizer attached to the API Gateway."
  type        = string
  default     = "p9tfgo" # Existing Cognito JWT authorizer
}

variable "lambda_role_name" {
  description = "Name of the existing IAM execution role shared by all Lambda functions."
  type        = string
  default     = "cloud-penny-lambda-role"
}

# ── Observability ─────────────────────────────────────────────

variable "log_retention_days" {
  description = "Number of days to retain Lambda logs in the shared CloudWatch log group."
  type        = number
  default     = 14
}

variable "lambda_runtime" {
  description = "Node.js runtime version for all Lambda functions."
  type        = string
  default     = "nodejs20.x"
}

variable "central_curs_bucket_name" {
  description = "Name of the central S3 bucket for receiving client CUR reports."
  type        = string
  default     = "cloudpenny-central-curs"
}
