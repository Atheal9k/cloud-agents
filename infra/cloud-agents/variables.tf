variable "aws_region" {
  description = "AWS region for the personal cloud-agent stack."
  type        = string
  default     = "us-west-1"
}

variable "name_prefix" {
  description = "Prefix for resource names and ownership tags."
  type        = string
  default     = "t3-cloud-agents"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,27}[a-z0-9]$", var.name_prefix))
    error_message = "name_prefix must contain 4-30 lowercase letters, numbers, or hyphens, and cannot end with a hyphen."
  }
}

variable "vpc_cidr" {
  description = "CIDR for the cloud-agent VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "controller_subnet_cidr" {
  description = "CIDR for the permanent controller subnet."
  type        = string
  default     = "10.42.1.0/24"
}

variable "worker_subnet_cidr" {
  description = "CIDR for disposable Linux workers."
  type        = string
  default     = "10.42.2.0/24"
}

variable "controller_ingress_cidrs" {
  description = "CIDRs allowed to reach the controller HTTPS endpoint. Use a trusted network, not 0.0.0.0/0, until CA-04 configures application authentication."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for cidr in var.controller_ingress_cidrs : cidr != "0.0.0.0/0"])
    error_message = "controller_ingress_cidrs must not contain 0.0.0.0/0 before CA-04 configures application authentication."
  }
}

variable "controller_ami_id" {
  description = "Optional baked controller AMI. Null uses the latest Amazon Linux 2023 x86_64 AMI."
  type        = string
  default     = null
  nullable    = true
}

variable "controller_instance_type" {
  description = "EC2 instance type for the permanent controller."
  type        = string
  default     = "t3.small"
}

variable "controller_root_volume_size_gib" {
  description = "Encrypted controller root volume size."
  type        = number
  default     = 20

  validation {
    condition     = var.controller_root_volume_size_gib >= 20 && var.controller_root_volume_size_gib <= 200
    error_message = "controller_root_volume_size_gib must be between 20 and 200."
  }
}

variable "controller_data_volume_size_gib" {
  description = "Encrypted retained volume size for controller state and archives."
  type        = number
  default     = 40

  validation {
    condition     = var.controller_data_volume_size_gib >= 20 && var.controller_data_volume_size_gib <= 1024
    error_message = "controller_data_volume_size_gib must be between 20 and 1024."
  }
}

variable "controller_service_port" {
  description = "HTTPS port exposed by the permanent controller."
  type        = number
  default     = 443

  validation {
    condition     = var.controller_service_port >= 1 && var.controller_service_port <= 65535
    error_message = "controller_service_port must be a valid TCP port."
  }
}

variable "worker_control_port" {
  description = "Worker T3 service port reachable only from the controller."
  type        = number
  default     = 3773

  validation {
    condition     = var.worker_control_port >= 1 && var.worker_control_port <= 65535
    error_message = "worker_control_port must be a valid TCP port."
  }
}

variable "worker_preview_port_range" {
  description = "Worker preview ports reachable only from the controller proxy."
  type = object({
    from = number
    to   = number
  })
  default = {
    from = 3000
    to   = 3999
  }

  validation {
    condition = (
      var.worker_preview_port_range.from >= 1 &&
      var.worker_preview_port_range.to <= 65535 &&
      var.worker_preview_port_range.from <= var.worker_preview_port_range.to
    )
    error_message = "worker_preview_port_range must be an ordered TCP port range."
  }
}

variable "worker_default_ttl_minutes" {
  description = "Hard lifetime applied to disposable workers unless an allocation supplies an earlier expiry."
  type        = number
  default     = 120

  validation {
    condition     = var.worker_default_ttl_minutes >= 15 && var.worker_default_ttl_minutes <= 1440
    error_message = "worker_default_ttl_minutes must be between 15 and 1440."
  }
}

variable "worker_profiles" {
  description = "Linux worker launch profiles. Later tickets may add separate Android and Mac infrastructure without changing this map's consumers."
  type = map(object({
    ami_id               = optional(string)
    instance_type        = string
    root_volume_size_gib = number
    architecture         = optional(string, "x86_64")
    capabilities         = optional(set(string), ["coding", "web-preview"])
  }))
  default = {
    linux-web = {
      instance_type        = "t3.medium"
      root_volume_size_gib = 30
    }
  }

  validation {
    condition = alltrue([
      for profile in values(var.worker_profiles) :
      profile.root_volume_size_gib >= 20 && profile.root_volume_size_gib <= 500
    ])
    error_message = "Each worker root volume must be between 20 and 500 GiB."
  }

  validation {
    condition = alltrue([
      for profile in values(var.worker_profiles) : profile.architecture == "x86_64"
    ])
    error_message = "CA-03 supports x86_64 Linux web workers only. Android and Mac profiles belong to CA-37 and CA-38."
  }
}

variable "artifact_retention_days" {
  description = "Days to retain current run artifacts before lifecycle expiration."
  type        = number
  default     = 30

  validation {
    condition     = var.artifact_retention_days >= 1 && var.artifact_retention_days <= 3650
    error_message = "artifact_retention_days must be between 1 and 3650."
  }
}

variable "cleanup_schedule_minutes" {
  description = "Interval for the independent expired-worker cleanup backstop."
  type        = number
  default     = 5

  validation {
    condition     = var.cleanup_schedule_minutes >= 1 && var.cleanup_schedule_minutes <= 60
    error_message = "cleanup_schedule_minutes must be between 1 and 60."
  }
}

variable "controller_termination_protection" {
  description = "Protect the permanent controller from API termination. Disable only in an isolated sandbox."
  type        = bool
  default     = true
}

variable "controller_credential_secret_arns" {
  description = "Secrets Manager ARNs the controller may read for Git SSH and GitHub API authentication. Workers receive no access to these master credentials."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.controller_credential_secret_arns :
      can(regex("^arn:[^:]+:secretsmanager:[^:]+:[0-9]{12}:secret:.+$", arn))
    ])
    error_message = "controller_credential_secret_arns must contain full AWS Secrets Manager ARNs."
  }
}

variable "allow_retained_data_destroy" {
  description = "Allow OpenTofu to delete retained controller data and artifact objects. Set only for an isolated sandbox teardown."
  type        = bool
  default     = false
}
