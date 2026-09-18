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
  description = "Install the X11 and browser runtime libraries used by a shared-browser profile."
  type        = bool
  default     = false
}

variable "install_shared_browser" {
  description = "Install the pinned Chromium and Amazon DCV shared-browser stack."
  type        = bool
  default     = false
}

variable "dcv_archive_sha256" {
  type    = string
  default = "d98eb986f3b547af22a7732ca26cb6541c3842b9ed57218f503c9acc3b29e7e2"
}

variable "dcv_gpg_key_sha256" {
  type    = string
  default = "d772e9783689d014810ccd8f014169bdf1db37ebcf686c92f8423e44c6f81912"
}

variable "dcv_version" {
  type    = string
  default = "2025.0-20103"
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

variable "tailscale_version" {
  type    = string
  default = "1.102.4"
}

variable "github_cli_version" {
  type    = string
  default = "2.101.0"
}

variable "github_cli_linux_x64_sha256" {
  type    = string
  default = "9bca2d1c16825f109907a23307628a2f0698fbf99662b73a5cf0b020293072b8"
}

variable "docker_compose_version" {
  type    = string
  default = "2.24.5"
}

variable "docker_compose_linux_x64_sha256" {
  type    = string
  default = "94355be1d1d395040bbda1490f98d5c7627c30798a7955e1f2a78fda33a4b3e1"
}

locals {
  desktop_layer = var.install_shared_browser ? "shared-browser" : (var.install_desktop_dependencies ? "desktop" : "headless")
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
    CloudAgentSharedBrowser       = var.install_shared_browser ? "true" : "false"
    NodeVersion                   = var.node_version
    T3Version                     = var.t3_version
    CodexVersion                  = var.codex_version
    ClaudeCodeVersion             = var.claude_code_version
    TailscaleVersion              = var.tailscale_version
    GitHubCliVersion              = var.github_cli_version
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
    source      = "${path.root}/files/dcv.conf"
    destination = "/tmp/dcv.conf"
  }

  provisioner "file" {
    source      = "${path.root}/files/shared-browser.perm"
    destination = "/tmp/shared-browser.perm"
  }

  provisioner "file" {
    source      = "${path.root}/files/shared-browser-control.perm"
    destination = "/tmp/shared-browser-control.perm"
  }

  provisioner "file" {
    source      = "${path.root}/files/shared-browser-nginx.conf"
    destination = "/tmp/shared-browser-nginx.conf"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-shared-browser"
    destination = "/tmp/cloud-agent-shared-browser"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-shared-browser-session"
    destination = "/tmp/cloud-agent-shared-browser-session"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-shared-browser-permissions"
    destination = "/tmp/cloud-agent-shared-browser-permissions"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/measure-shared-browser.sh"
    destination = "/tmp/measure-shared-browser.sh"
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
    source      = "${path.root}/scripts/cloud-agent-codex-auth-sync"
    destination = "/tmp/cloud-agent-codex-auth-sync"
  }

  provisioner "file" {
    source      = "${path.root}/files/cloud-agent-codex-auth-sync.service"
    destination = "/tmp/cloud-agent-codex-auth-sync.service"
  }

  provisioner "file" {
    source      = "${path.root}/files/cloud-agent-codex-auth-sync.path"
    destination = "/tmp/cloud-agent-codex-auth-sync.path"
  }

  provisioner "file" {
    source      = "${path.root}/files/cloud-agent-codex-auth-sync.timer"
    destination = "/tmp/cloud-agent-codex-auth-sync.timer"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-worker-preflight"
    destination = "/tmp/cloud-agent-worker-preflight"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-worker-register"
    destination = "/tmp/cloud-agent-worker-register"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-github-credentials"
    destination = "/tmp/cloud-agent-github-credentials"
  }

  provisioner "file" {
    source      = "${path.root}/scripts/cloud-agent-prepare-repository"
    destination = "/tmp/cloud-agent-prepare-repository"
  }

  provisioner "shell" {
    environment_vars = [
      "CLAUDE_CODE_VERSION=${var.claude_code_version}",
      "CODEX_VERSION=${var.codex_version}",
      "DCV_ARCHIVE_SHA256=${var.dcv_archive_sha256}",
      "DCV_GPG_KEY_SHA256=${var.dcv_gpg_key_sha256}",
      "DCV_VERSION=${var.dcv_version}",
      "DOCKER_COMPOSE_LINUX_X64_SHA256=${var.docker_compose_linux_x64_sha256}",
      "DOCKER_COMPOSE_VERSION=${var.docker_compose_version}",
      "IMAGE_VERSION=${var.image_version}",
      "GITHUB_CLI_LINUX_X64_SHA256=${var.github_cli_linux_x64_sha256}",
      "GITHUB_CLI_VERSION=${var.github_cli_version}",
      "INSTALL_DESKTOP_DEPENDENCIES=${var.install_desktop_dependencies}",
      "INSTALL_SHARED_BROWSER=${var.install_shared_browser}",
      "NODE_LINUX_X64_SHA256=${var.node_linux_x64_sha256}",
      "NODE_VERSION=${var.node_version}",
      "PROFILE_NAME=${var.profile_name}",
      "SOURCE_AMI_ID=${var.source_ami_id}",
      "T3_VERSION=${var.t3_version}",
      "TAILSCALE_VERSION=${var.tailscale_version}",
    ]
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E '{{ .Path }}'"
    script          = "${path.root}/scripts/install-worker-image.sh"
  }

  provisioner "shell" {
    environment_vars = [
      "CLAUDE_CODE_VERSION=${var.claude_code_version}",
      "CODEX_VERSION=${var.codex_version}",
      "DOCKER_COMPOSE_VERSION=${var.docker_compose_version}",
      "GITHUB_CLI_VERSION=${var.github_cli_version}",
      "DCV_VERSION=${var.dcv_version}",
      "INSTALL_DESKTOP_DEPENDENCIES=${var.install_desktop_dependencies}",
      "INSTALL_SHARED_BROWSER=${var.install_shared_browser}",
      "NODE_VERSION=${var.node_version}",
      "T3_VERSION=${var.t3_version}",
      "TAILSCALE_VERSION=${var.tailscale_version}",
    ]
    execute_command = "chmod +x {{ .Path }}; {{ .Vars }} sudo -E '{{ .Path }}'"
    script          = "${path.root}/scripts/verify-worker-image.sh"
  }
}
