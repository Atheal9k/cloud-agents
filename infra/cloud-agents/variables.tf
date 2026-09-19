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

variable "controller_mode" {
  description = "Where the cloud-agent controller runs. Use ec2 for the permanent AWS host or local for a T3 process on the operator's machine."
  type        = string
  default     = "ec2"

  validation {
    condition     = contains(["ec2", "local"], var.controller_mode)
    error_message = "controller_mode must be either ec2 or local."
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
  description = "Versioned Linux worker images and launch settings. Changing an AMI affects new workers only, which permits rollback without mutating active runs."
  type = map(object({
    ami_id               = string
    image_version        = string
    instance_type        = string
    root_volume_size_gib = number
    architecture         = optional(string, "x86_64")
    capabilities         = optional(set(string), ["coding", "web-preview"])
    desktop_dependencies = optional(bool, false)
    shared_browser       = optional(bool, false)
  }))
  default = {}

  validation {
    condition = alltrue([
      for name in keys(var.worker_profiles) :
      can(regex("^[a-z0-9][a-z0-9-]{0,31}$", name))
    ])
    error_message = "Worker profile names must contain at most 32 lowercase letters, numbers, or hyphens."
  }

  validation {
    condition = alltrue([
      for profile in values(var.worker_profiles) :
      can(regex("^ami-[0-9a-f]{8,17}$", profile.ami_id)) &&
      can(regex("^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$", profile.image_version))
    ])
    error_message = "Each worker profile must use an explicit AMI ID and a short image version."
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
    error_message = "CA-03 supports x86_64 Linux web workers only. Android profiles belong to CA-37. macOS iOS profiles use mac_worker_profiles."
  }

  validation {
    condition = alltrue([
      for profile in values(var.worker_profiles) :
      !profile.shared_browser || (
        profile.desktop_dependencies && contains(profile.capabilities, "shared-browser")
      )
    ])
    error_message = "A shared-browser worker profile must enable desktop_dependencies and declare the shared-browser capability."
  }
}

variable "mac_worker_profiles" {
  description = "macOS iOS Simulator worker images launched onto EC2 Mac Dedicated Hosts. Hosts are allocated on demand and kept for the 24-hour minimum; they are not disposable Linux workers."
  type = map(object({
    ami_id               = string
    image_version        = string
    instance_type        = string
    root_volume_size_gib = number
    macos                = string
    xcode                = string
    simulator_runtime    = string
  }))
  default = {}

  validation {
    condition = alltrue([
      for name in keys(var.mac_worker_profiles) :
      can(regex("^[a-z0-9][a-z0-9-]{0,31}$", name))
    ])
    error_message = "Mac worker profile names must contain at most 32 lowercase letters, numbers, or hyphens."
  }

  validation {
    condition = alltrue([
      for profile in values(var.mac_worker_profiles) :
      contains(["mac2.metal", "mac2-m1ultra.metal", "mac2-m2.metal", "mac2-m2pro.metal"], profile.instance_type)
    ])
    error_message = "Mac worker profiles must use Apple Silicon EC2 Mac instance types."
  }

  validation {
    condition = alltrue([
      for profile in values(var.mac_worker_profiles) :
      profile.root_volume_size_gib >= 100 && profile.root_volume_size_gib <= 500
    ])
    error_message = "Each Mac worker root volume must be between 100 and 500 GiB so Xcode and simulators fit."
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

variable "worker_git_ssh_secret_arn" {
  description = "Optional Secrets Manager ARN containing an SSH private key used by root to fetch the assigned repository. When worker_github_token_secret_arn is set, the key remains available to the disposable task so it can push its output branch."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_git_ssh_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_git_ssh_secret_arn))
    )
    error_message = "worker_git_ssh_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "worker_github_token_secret_arn" {
  description = "Optional Secrets Manager ARN containing a GitHub token exposed only to the disposable task for GitHub CLI authentication. Requires worker_git_ssh_secret_arn so the task can push its branch."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_github_token_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_github_token_secret_arn))
    )
    error_message = "worker_github_token_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "worker_codex_api_key_secret_arn" {
  description = "Optional Secrets Manager ARN containing the raw OpenAI API key used to authenticate Codex on disposable workers."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_codex_api_key_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_codex_api_key_secret_arn))
    )
    error_message = "worker_codex_api_key_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "worker_codex_auth_json_secret_arn" {
  description = "Optional Secrets Manager ARN containing a Codex auth.json created by ChatGPT account login. Workers read and write this secret so refreshed credentials survive replacement."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_codex_auth_json_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_codex_auth_json_secret_arn))
    )
    error_message = "worker_codex_auth_json_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "worker_claude_oauth_token_secret_arn" {
  description = "Optional Secrets Manager ARN containing the raw CLAUDE_CODE_OAUTH_TOKEN produced by claude setup-token."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_claude_oauth_token_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_claude_oauth_token_secret_arn))
    )
    error_message = "worker_claude_oauth_token_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "worker_tailscale_auth_key_secret_arn" {
  description = "Optional Secrets Manager ARN containing the raw Tailscale auth key used to enroll disposable workers."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.worker_tailscale_auth_key_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.worker_tailscale_auth_key_secret_arn))
    )
    error_message = "worker_tailscale_auth_key_secret_arn must be a full AWS Secrets Manager ARN."
  }
}

variable "controller_image_ref" {
  description = "Container image reference for the permanent controller, built by the repository Dockerfile and published for CA-04B. Pin a digest or an immutable tag."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.controller_mode != "ec2" ||
      (var.controller_image_ref != null && length(trimspace(var.controller_image_ref)) > 0)
    )
    error_message = "controller_image_ref is required when controller_mode is ec2."
  }
}

variable "controller_tailscale_auth_key_secret_arn" {
  description = "Secrets Manager ARN containing the raw Tailscale auth key that enrolls the permanent controller. The tailnet supplies its stable name and renewed TLS certificate."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.controller_tailscale_auth_key_secret_arn == null ||
      can(regex("^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", var.controller_tailscale_auth_key_secret_arn))
    )
    error_message = "controller_tailscale_auth_key_secret_arn must be a full AWS Secrets Manager ARN."
  }

  validation {
    condition = (
      var.controller_mode != "ec2" ||
      var.controller_tailscale_auth_key_secret_arn != null
    )
    error_message = "controller_tailscale_auth_key_secret_arn is required when controller_mode is ec2; the tailnet is the controller's entry point."
  }
}

variable "controller_tailnet_domain" {
  description = "MagicDNS domain of the tailnet the controller joins, such as example-tailnet.ts.net. With the hostname it forms the stable controller URL."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.controller_tailnet_domain == null ||
      can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.controller_tailnet_domain))
    )
    error_message = "controller_tailnet_domain must be a lowercase DNS name such as example-tailnet.ts.net."
  }

  validation {
    condition     = var.controller_mode != "ec2" || var.controller_tailnet_domain != null
    error_message = "controller_tailnet_domain is required when controller_mode is ec2."
  }
}

variable "controller_tailscale_hostname" {
  description = "MagicDNS hostname for the permanent controller. This is the stable name clients and workers use."
  type        = string
  default     = "t3-controller"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.controller_tailscale_hostname))
    error_message = "controller_tailscale_hostname must be a lowercase DNS label."
  }
}

variable "controller_runtime_environment" {
  description = "Extra T3CODE_* settings passed to the controller container. Secret values belong in Secrets Manager and are referenced by name, never set here."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for name in keys(var.controller_runtime_environment) : can(regex("^T3CODE_[A-Z0-9_]+$", name))])
    error_message = "controller_runtime_environment keys must look like T3CODE_EXAMPLE_NAME."
  }

  validation {
    condition = alltrue([
      for name in keys(var.controller_runtime_environment) :
      !can(regex("(TOKEN|SECRET|PASSWORD|_KEY)$", name)) || can(regex("_SECRET_REF$", name))
    ])
    error_message = "Pass credentials as Secrets Manager references (a T3CODE_*_SECRET_REF name), not as controller_runtime_environment values."
  }
}

variable "allow_retained_data_destroy" {
  description = "Allow OpenTofu to delete retained controller data and artifact objects. Set only for an isolated sandbox teardown."
  type        = bool
  default     = false
}

variable "allow_controller_data_destroy" {
  description = "Allow OpenTofu to delete only the retained controller volume when switching an existing stack to local-controller mode."
  type        = bool
  default     = false
}
