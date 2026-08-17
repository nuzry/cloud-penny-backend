# ─────────────────────────────────────────────────────────────
# Terraform version + provider requirements + remote backend
# ─────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Backend values are injected at runtime via -backend-config flags.
  # See: README.md → "Initialising Terraform" for the exact commands.
  backend "s3" {}
}
