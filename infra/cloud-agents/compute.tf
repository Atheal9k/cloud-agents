locals {
  controller_image_id = coalesce(var.controller_ami_id, data.aws_ami.amazon_linux_2023.id)
  # The container listens on T3's own port; the tailnet publishes the HTTPS one.
  controller_container_port = 3777
  controller_hostname       = "${var.controller_tailscale_hostname}.${coalesce(var.controller_tailnet_domain, "invalid")}"
  controller_extra_environment = join(
    "\n",
    [for name in sort(keys(var.controller_runtime_environment)) : "${name}=${var.controller_runtime_environment[name]}"],
  )
}

resource "aws_instance" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  ami                         = local.controller_image_id
  instance_type               = var.controller_instance_type
  subnet_id                   = aws_subnet.controller[0].id
  vpc_security_group_ids      = [aws_security_group.controller[0].id]
  iam_instance_profile        = aws_iam_instance_profile.controller[0].name
  associate_public_ip_address = false
  disable_api_termination     = var.controller_termination_protection
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    encrypted             = true
    delete_on_termination = true
    volume_size           = var.controller_root_volume_size_gib
    volume_type           = "gp3"

    tags = {
      Name      = "${var.name_prefix}-controller-root"
      Role      = "controller"
      Retention = "replaceable"
    }
  }

  user_data = templatefile("${path.module}/templates/controller-cloud-init.sh.tftpl", {
    artifact_bucket               = aws_s3_bucket.artifacts.id
    aws_region                    = var.aws_region
    project_name                  = var.name_prefix
    data_device                   = "/dev/sdf"
    container_port                = local.controller_container_port
    controller_hostname           = local.controller_hostname
    controller_image_ref          = var.controller_image_ref
    extra_environment             = local.controller_extra_environment
    service_port                  = var.controller_service_port
    tailscale_auth_key_secret_arn = coalesce(var.controller_tailscale_auth_key_secret_arn, "")
    tailscale_hostname            = var.controller_tailscale_hostname
  })

  tags = {
    Name           = "${var.name_prefix}-controller"
    CloudAgentRole = "controller"
    Retention      = "permanent"
  }

  depends_on = [
    aws_iam_role_policy_attachment.controller_ssm,
    aws_route_table_association.controller,
  ]
}

resource "aws_eip" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  domain = "vpc"

  tags = {
    Name           = "${var.name_prefix}-controller"
    CloudAgentRole = "controller"
    Retention      = "permanent"
  }
}

resource "aws_eip_association" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  allocation_id = aws_eip.controller[0].id
  instance_id   = aws_instance.controller[0].id
}

resource "aws_volume_attachment" "controller_data" {
  count = var.controller_mode == "ec2" ? 1 : 0

  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.controller_data[0].id
  instance_id = aws_instance.controller[0].id
}

resource "aws_launch_template" "worker" {
  for_each = var.worker_profiles

  name_prefix   = "${var.name_prefix}-${each.key}-"
  image_id      = each.value.ami_id
  instance_type = each.value.instance_type

  update_default_version = true
  # The guest's own timer bounds how long it may run unattended, not how long
  # the conversation lives. Stopping keeps the agent's disk so the controller
  # can record it as a snapshot and wake it; the cleanup backstop still
  # terminates a stopped worker that no allocation claims.
  instance_initiated_shutdown_behavior = "stop"

  tags = {
    CloudAgentProject = var.name_prefix
    CloudAgentProfile = each.key
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.worker.name
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  network_interfaces {
    associate_public_ip_address = true
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.worker.id]
    subnet_id                   = aws_subnet.workers.id
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      delete_on_termination = true
      encrypted             = true
      volume_size           = each.value.root_volume_size_gib
      volume_type           = "gp3"
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/worker-cloud-init.sh.tftpl", {
    aws_region                    = var.aws_region
    claude_oauth_token_secret_arn = var.worker_claude_oauth_token_secret_arn == null ? "" : var.worker_claude_oauth_token_secret_arn
    codex_api_key_secret_arn      = var.worker_codex_api_key_secret_arn == null ? "" : var.worker_codex_api_key_secret_arn
    codex_auth_json_secret_arn    = var.worker_codex_auth_json_secret_arn == null ? "" : var.worker_codex_auth_json_secret_arn
    image_version                 = each.value.image_version
    profile_name                  = each.key
    service_port                  = var.worker_control_port
    git_ssh_secret_arn            = var.worker_git_ssh_secret_arn == null ? "" : var.worker_git_ssh_secret_arn
    github_token_secret_arn       = var.worker_github_token_secret_arn == null ? "" : var.worker_github_token_secret_arn
    tailscale_auth_key_secret_arn = var.worker_tailscale_auth_key_secret_arn == null ? "" : var.worker_tailscale_auth_key_secret_arn
    ttl_minutes                   = var.worker_default_ttl_minutes
  }))

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name                          = "${var.name_prefix}-${each.key}"
      CloudAgentProject             = var.name_prefix
      CloudAgentRole                = "worker"
      CloudAgentProfile             = each.key
      CloudAgentDefaultTtlMinutes   = tostring(var.worker_default_ttl_minutes)
      CloudAgentCapabilities        = join(",", sort(tolist(each.value.capabilities)))
      CloudAgentDesktopDependencies = tostring(each.value.desktop_dependencies)
      CloudAgentImageVersion        = each.value.image_version
      CloudAgentSharedBrowser       = tostring(each.value.shared_browser)
      CloudAgentNestedVirtualization = tostring(each.value.nested_virtualization)
      CloudAgentAndroidSdk          = tostring(each.value.android_sdk)
      Ephemeral                     = "true"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Name              = "${var.name_prefix}-${each.key}"
      CloudAgentProject = var.name_prefix
      CloudAgentRole    = "worker"
      Ephemeral         = "true"
    }
  }

  lifecycle {
    create_before_destroy = true

    precondition {
      condition = !(
        var.worker_codex_api_key_secret_arn != null &&
        var.worker_codex_auth_json_secret_arn != null
      )
      error_message = "Set only one of worker_codex_api_key_secret_arn or worker_codex_auth_json_secret_arn."
    }


    precondition {
      condition = (
        var.worker_github_token_secret_arn == null ||
        var.worker_git_ssh_secret_arn != null
      )
      error_message = "worker_github_token_secret_arn requires worker_git_ssh_secret_arn so workers can push their output branch."
    }
  }

  depends_on = [
    aws_iam_role_policy.worker_github_credentials,
    aws_iam_role_policy.worker_git_credentials,
    aws_iam_role_policy_attachment.worker_ssm,
    aws_route_table_association.workers,
  ]
}

resource "aws_launch_template" "mac_worker" {
  for_each = var.mac_worker_profiles

  name_prefix   = "${var.name_prefix}-${each.key}-"
  image_id      = each.value.ami_id
  instance_type = each.value.instance_type

  update_default_version               = true
  instance_initiated_shutdown_behavior = "stop"

  placement {
    tenancy = "host"
  }

  tags = {
    CloudAgentProject = var.name_prefix
    CloudAgentProfile = each.key
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.worker.name
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  network_interfaces {
    associate_public_ip_address = true
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.worker.id]
    subnet_id                   = aws_subnet.workers.id
  }

  block_device_mappings {
    device_name = "/dev/sda1"

    ebs {
      delete_on_termination = false
      encrypted             = true
      volume_size           = each.value.root_volume_size_gib
      volume_type           = "gp3"
    }
  }

  user_data = base64encode(templatefile("${path.module}/templates/macos-ios-worker-user-data.sh.tftpl", {
    aws_region                    = var.aws_region
    claude_oauth_token_secret_arn = var.worker_claude_oauth_token_secret_arn == null ? "" : var.worker_claude_oauth_token_secret_arn
    codex_api_key_secret_arn      = var.worker_codex_api_key_secret_arn == null ? "" : var.worker_codex_api_key_secret_arn
    codex_auth_json_secret_arn    = var.worker_codex_auth_json_secret_arn == null ? "" : var.worker_codex_auth_json_secret_arn
    image_version                 = each.value.image_version
    macos                         = each.value.macos
    profile_name                  = each.key
    service_port                  = var.worker_control_port
    simulator_runtime             = each.value.simulator_runtime
    git_ssh_secret_arn            = var.worker_git_ssh_secret_arn == null ? "" : var.worker_git_ssh_secret_arn
    github_token_secret_arn       = var.worker_github_token_secret_arn == null ? "" : var.worker_github_token_secret_arn
    tailscale_auth_key_secret_arn = var.worker_tailscale_auth_key_secret_arn == null ? "" : var.worker_tailscale_auth_key_secret_arn
    xcode                         = each.value.xcode
  }))

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name                        = "${var.name_prefix}-${each.key}"
      CloudAgentProject           = var.name_prefix
      CloudAgentRole              = "worker"
      CloudAgentProfile           = each.key
      CloudAgentCapabilities      = "coding,ios-simulator"
      CloudAgentImageVersion      = each.value.image_version
      CloudAgentMacOS             = each.value.macos
      CloudAgentXcode             = each.value.xcode
      CloudAgentSimulatorRuntime  = each.value.simulator_runtime
      CloudAgentLifecycle         = "dedicated-host"
      Ephemeral                   = "false"
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Name              = "${var.name_prefix}-${each.key}"
      CloudAgentProject = var.name_prefix
      CloudAgentRole    = "worker"
      Ephemeral         = "false"
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_iam_role_policy_attachment.worker_ssm,
    aws_route_table_association.workers,
  ]
}

resource "aws_ssm_document" "recovery_diagnostics" {
  name            = "${var.name_prefix}-recovery-diagnostics"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Collect fixed controller or worker diagnostics. This document cannot execute job commands."
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "collectDiagnostics"
      inputs = {
        timeoutSeconds = "60"
        runCommand = [
          "set -eu",
          "echo '=== cloud-init ==='",
          "cloud-init status --long || true",
          "echo '=== failed units ==='",
          "systemctl --failed --no-pager || true",
          "echo '=== t3 services ==='",
          "systemctl status t3-controller.service cloud-agent-worker.service --no-pager || true",
          "echo '=== disk ==='",
          "df -h",
        ]
      }
    }]
  })

  tags = {
    Purpose = "recovery-only"
  }
}
