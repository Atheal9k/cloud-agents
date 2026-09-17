packer {
  required_version = "= 1.16.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "= 1.8.2"
    }
  }
}

variable "aws_region" {
  type    = string
  default = "us-west-1"
}

variable "source_ami_id" {
  description = "Exact Amazon Linux 2023 x86_64 AMI used as the build input."
  type        = string
}

variable "image_version" {
  description = "Immutable worker image version recorded in the AMI and on launched instances."
  type        = string
  default     = "0.0.42-ca27.1"
}

variable "profile_name" {
  description = "Worker profile baked into the image manifest."
  type        = string
  default     = "linux-web"
}

variable "install_desktop_dependencies" {
  description = "Install the dormant X11/browser library layer used by the later shared-browser profile."
  type        = bool
  default     = false
}

variable "node_version" {
  type    = string
  default = "24.13.1"
}

variable "node_linux_x64_sha256" {
  type    = string
  default = "30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089"
}

variable "t3_version" {
  type    = string
  default = "0.0.42"
}

variable "codex_version" {
  type    = string
  default = "0.154.0"
}

variable "claude_code_version" {
  type    = string
  default = "2.1.273"
}

locals {
  desktop_layer = var.install_desktop_dependencies ? "desktop" : "headless"
}

source "amazon-ebs" "worker" {
  ami_description             = "T3 cloud worker ${var.image_version} (${var.profile_name}, ${local.desktop_layer})"
  ami_name                    = "t3-cloud-agent-${var.profile_name}-${var.image_version}-${formatdate("YYYYMMDDhhmmss", timestamp())}"
  ami_virtualization_type     = "hvm"
  associate_public_ip_address = true
  ena_support                 = true
  imds_support                = "v2.0"
  instance_type               = "t3.medium"
  region                      = var.aws_region
  source_ami                  = var.source_ami_id
  ssh_username                = "ec2-user"

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  run_tags = {
    Name              = "t3-worker-image-build"
    CloudAgentRole    = "image-builder"
    CloudAgentProfile = var.profile_name
  }

  tags = {
    Name                          = "t3-cloud-agent-${var.profile_name}-${var.image_version}"
    CloudAgentRole                = "worker-image"
    CloudAgentProfile             = var.profile_name
    CloudAgentImageVersion        = var.image_version
    CloudAgentDesktopDependencies = var.install_desktop_dependencies ? "true" : "false"
    NodeVersion                   = var.node_version
    T3Version                     = var.t3_version
    CodexVersion                  = var.codex_version
    ClaudeCodeVersion             = var.claude_code_version
  }
}

build {
  name    = "t3-worker"
  sources = ["source.amazon-ebs.worker"]

  provisioner "file" {
    source      = "${path.root}/files/cloud-agent-worker.service"
    destination = "/tmp/cloud-agent-worker.service"
  }

  provisioner "file" {
    source      = "${path.root}/files/cloud-agent-worker-registration.service"
    destination = "/tmp/cloud-agent-worker-registration.service"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-worker-cleanup"
    destination = "/tmp/cloud-agent-worker-cleanup"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-worker-preflight"
    destination = "/tmp/cloud-agent-worker-preflight"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-worker-register"
    destination = "/tmp/cloud-agent-worker-register"
  }

  provisioner "shell" {
    environment_vars = [
      "CLAUDE_CODE_VERSION=${var.claude_code_version}",
      "CODEX_VERSION=${var.codex_version}",
      "IMAGE_VERSION=${var.image_version}",
      "INSTALL_DESKTOP_DEPENDENCIES=${var.install_desktop_dependencies}",
      "NODE_LINUX_X64_SHA256=${var.node_linux_x64_sha256}",
      "NODE_VERSION=${var.node_version}",
      "PROFILE_NAME=${var.profile_name}",
      "SOURCE_AMI_ID=${var.source_ami_id}",
      "T3_VERSION=${var.t3_version}",
    ]
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E '{{ .Path }}'"
    script          = "${path.root}/scripts/install-worker-image.sh"
  }

  provisioner "shell" {
    environment_vars = [
      "CLAUDE_CODE_VERSION=${var.claude_code_version}",
      "CODEX_VERSION=${var.codex_version}",
      "INSTALL_DESKTOP_DEPENDENCIES=${var.install_desktop_dependencies}",
      "NODE_VERSION=${var.node_version}",
      "T3_VERSION=${var.t3_version}",
    ]
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E '{{ .Path }}'"
    script          = "${path.root}/scripts/verify-worker-image.sh"
  }
}
