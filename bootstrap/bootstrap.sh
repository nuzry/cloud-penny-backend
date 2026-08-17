#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# bootstrap.sh
#
# One-time setup: creates the S3 bucket and DynamoDB table needed
# for Terraform remote state. Run this ONCE before your first
# `terraform init`. It is safe to re-run — all operations are
# idempotent.
#
# Usage:
#   bash bootstrap/bootstrap.sh
#
# Override defaults with environment variables:
#   AWS_REGION=ap-southeast-1 \
#   PROJECT_NAME=cloud-penny  \
#   bash bootstrap/bootstrap.sh
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
PROJECT_NAME="${PROJECT_NAME:-cloud-penny}"
BUCKET_NAME="${BUCKET_NAME:-${PROJECT_NAME}-terraform-state}"
TABLE_NAME="${TABLE_NAME:-${PROJECT_NAME}-terraform-locks}"

hr() { printf '%s\n' "$(printf '─%.0s' {1..58})"; }

hr
printf ' 🚀  Terraform State Bootstrap — %s\n' "$PROJECT_NAME"
hr
printf '  Region : %s\n' "$AWS_REGION"
printf '  Bucket : %s\n' "$BUCKET_NAME"
printf '  Table  : %s\n' "$TABLE_NAME"
hr
echo ""

# ── Verify AWS CLI ─────────────────────────────────────────────
if ! command -v aws &>/dev/null; then
  echo "❌  AWS CLI not found. Install it first: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
  exit 1
fi

echo "🔐  Using AWS identity:"
aws sts get-caller-identity --region "$AWS_REGION" --output table
echo ""

# ─────────────────────────────────────────────────────────────
# S3 Bucket
# ─────────────────────────────────────────────────────────────
echo "📦  S3 Bucket"

if aws s3api head-bucket --bucket "$BUCKET_NAME" --region "$AWS_REGION" 2>/dev/null; then
  echo "    ✅  Already exists: $BUCKET_NAME"
else
  echo "    Creating bucket..."
  if [ "$AWS_REGION" = "us-east-1" ]; then
    # us-east-1 does NOT accept a LocationConstraint
    aws s3api create-bucket \
      --bucket "$BUCKET_NAME" \
      --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$BUCKET_NAME" \
      --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
  echo "    ✅  Created: $BUCKET_NAME"
fi

# Enable versioning (allows state recovery)
aws s3api put-bucket-versioning \
  --bucket "$BUCKET_NAME" \
  --versioning-configuration Status=Enabled \
  --region "$AWS_REGION"
echo "    ✅  Versioning enabled"

# Server-side encryption
aws s3api put-bucket-encryption \
  --bucket "$BUCKET_NAME" \
  --region "$AWS_REGION" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'
echo "    ✅  Encryption enabled (AES256 + bucket key)"

# Block all public access
aws s3api put-public-access-block \
  --bucket "$BUCKET_NAME" \
  --region "$AWS_REGION" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
echo "    ✅  Public access blocked"

echo ""

# ─────────────────────────────────────────────────────────────
# DynamoDB Table (state locking)
# ─────────────────────────────────────────────────────────────
echo "🔒  DynamoDB Table (state locks)"

if aws dynamodb describe-table \
    --table-name "$TABLE_NAME" \
    --region "$AWS_REGION" \
    --output text \
    --query 'Table.TableStatus' 2>/dev/null | grep -q "ACTIVE"; then
  echo "    ✅  Already exists: $TABLE_NAME"
else
  echo "    Creating table..."
  aws dynamodb create-table \
    --table-name "$TABLE_NAME" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION" \
    --tags \
      Key=project,Value="$PROJECT_NAME" \
      Key=managed_by,Value=terraform \
    --output text > /dev/null

  echo "    Waiting for table to become ACTIVE..."
  aws dynamodb wait table-exists \
    --table-name "$TABLE_NAME" \
    --region "$AWS_REGION"

  echo "    ✅  Created: $TABLE_NAME"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
hr
printf ' ✅  Bootstrap complete!\n'
hr
echo ""
echo "  Add these secrets to your GitHub repository"
echo "  (Settings → Secrets and variables → Actions):"
echo ""
printf "  %-28s = %s\n" "AWS_ACCESS_KEY_ID"     "<your-iam-key-id>"
printf "  %-28s = %s\n" "AWS_SECRET_ACCESS_KEY" "<your-iam-secret>"
printf "  %-28s = %s\n" "AWS_REGION"            "$AWS_REGION"
printf "  %-28s = %s\n" "TF_STATE_BUCKET"       "$BUCKET_NAME"
printf "  %-28s = %s\n" "TF_STATE_LOCK_TABLE"   "$TABLE_NAME"
printf "  %-28s = %s\n" "TF_STATE_KEY_PREFIX"   "$PROJECT_NAME"
echo ""
echo "  Then run the first init locally:"
echo ""
printf "  terraform -chdir=infra init \\\\\n"
printf "    -backend-config=\"bucket=%s\" \\\\\n"        "$BUCKET_NAME"
printf "    -backend-config=\"key=%s/dev/terraform.tfstate\" \\\\\n" "$PROJECT_NAME"
printf "    -backend-config=\"region=%s\" \\\\\n"        "$AWS_REGION"
printf "    -backend-config=\"dynamodb_table=%s\"\n"     "$TABLE_NAME"
echo ""
