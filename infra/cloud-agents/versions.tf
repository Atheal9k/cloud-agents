terraform {
  required_version = "= 1.12.5"

  backend "s3" {
    encrypt              = true
    use_lockfile         = true
    workspace_key_prefix = "cloud-agents/workspaces"

    state_tags = {
      Component = "OpenTofuState"
      ManagedBy = "OpenTofu"
    }

    lock_tags = {
      Component = "OpenTofuStateLock"
      ManagedBy = "OpenTofu"
    }
  }

  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.50"
    }
  }
}
