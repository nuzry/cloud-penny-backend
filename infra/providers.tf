# AWS Provider

provider "aws" {
  region = var.aws_region

  # Default tags applied to EVERY resource created by this provider.
  # Individual resources may add additional tags; they are merged.
  default_tags {
    tags = {
      project     = var.project_name
      environment = var.environment
      managed_by  = "terraform"
    }
  }
}
