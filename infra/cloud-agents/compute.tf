locals {
  controller_image_id = coalesce(var.controller_ami_id, data.aws_ami.amazon_linux_2023.id)
}

resource "aws_instance" "controller" {
  ami                         = local.controller_image_id
  instance_type               = var.controller_instance_type
  subnet_id                   = aws_subnet.controller.id
  vpc_security_group_ids      = [aws_security_group.controller.id]
  iam_instance_profile        = aws_iam_instance_profile.controller.name
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
    artifact_bucket = aws_s3_bucket.artifacts.id
    aws_region      = var.aws_region
    project_name    = var.name_prefix
    data_device     = "/dev/sdf"
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
  domain = "vpc"

  tags = {
    Name           = "${var.name_prefix}-controller"
    CloudAgentRole = "controller"
    Retention      = "permanent"
  }
}

resource "aws_eip_association" "controller" {
  allocation_id = aws_eip.controller.id
  instance_id   = aws_instance.controller.id
}

resource "aws_volume_attachment" "controller_data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.controller_data.id
  instance_id = aws_instance.controller.id
}

resource "aws_launch_template" "worker" {
  for_each = var.worker_profiles

  name_prefix   = "${var.name_prefix}-${each.key}-"
  image_id      = each.value.ami_id
  instance_type = each.value.instance_type

  update_default_version               = true
  instance_initiated_shutdown_behavior = "terminate"

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
    instance_metadata_tags      = "disabled"
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
    image_version = each.value.image_version
    profile_name  = each.key
    service_port  = var.worker_control_port
    ttl_minutes   = var.worker_default_ttl_minutes
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
