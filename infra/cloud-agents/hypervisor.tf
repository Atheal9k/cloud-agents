locals {
  hypervisor_enabled = length(var.hypervisor_profiles) > 0
}

resource "aws_subnet" "hypervisors" {
  count = local.hypervisor_enabled ? 1 : 0

  vpc_id                  = aws_vpc.cloud_agents.id
  cidr_block              = var.hypervisor_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = {
    Name            = "${var.name_prefix}-hypervisors"
    CloudAgentRole  = "hypervisor"
    Retention       = "permanent"
    ExecutionAccount = var.execution_account_id
  }
}

resource "aws_route_table_association" "hypervisors" {
  count = local.hypervisor_enabled ? 1 : 0

  subnet_id      = aws_subnet.hypervisors[0].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "hypervisor" {
  count = local.hypervisor_enabled ? 1 : 0

  name_prefix = "${var.name_prefix}-hypervisor-"
  description = "Firecracker hypervisor hosts; guests have no security-group identity of their own"
  vpc_id      = aws_vpc.cloud_agents.id

  tags = {
    Name           = "${var.name_prefix}-hypervisor"
    CloudAgentRole = "hypervisor"
    Retention      = "permanent"
  }
}

resource "aws_vpc_security_group_egress_rule" "hypervisor_outbound" {
  count = local.hypervisor_enabled ? 1 : 0

  security_group_id = aws_security_group.hypervisor[0].id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
  description       = "Hypervisors pull kernels and register with the controller; guests do not inherit this rule."
}

resource "aws_iam_role" "hypervisor" {
  count = local.hypervisor_enabled ? 1 : 0

  name_prefix        = "${var.name_prefix}-hypervisor-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Role           = "hypervisor"
    CloudAgentRole = "hypervisor"
    Retention      = "permanent"
  }
}

resource "aws_iam_instance_profile" "hypervisor" {
  count = local.hypervisor_enabled ? 1 : 0

  name_prefix = "${var.name_prefix}-hypervisor-"
  role        = aws_iam_role.hypervisor[0].name
}

data "aws_iam_policy_document" "hypervisor_runtime" {
  count = local.hypervisor_enabled ? 1 : 0

  statement {
    sid       = "DescribeSelf"
    actions   = ["ec2:DescribeInstances", "ec2:DescribeTags"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "hypervisor_runtime" {
  count  = local.hypervisor_enabled ? 1 : 0
  name   = "hypervisor-runtime"
  role   = aws_iam_role.hypervisor[0].id
  policy = data.aws_iam_policy_document.hypervisor_runtime[0].json
}

resource "aws_launch_template" "hypervisor" {
  for_each = var.hypervisor_profiles

  name_prefix   = "${var.name_prefix}-${each.key}-hv-"
  image_id      = each.value.ami_id
  instance_type = each.value.instance_type

  update_default_version = true

  tags = {
    CloudAgentProject = var.name_prefix
    CloudAgentRole    = "hypervisor"
    CloudAgentProfile = each.key
    Retention         = "permanent"
  }

  iam_instance_profile {
    name = aws_iam_instance_profile.hypervisor[0].name
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  network_interfaces {
    associate_public_ip_address = false
    delete_on_termination       = true
    device_index                = 0
    security_groups             = [aws_security_group.hypervisor[0].id]
    subnet_id                   = aws_subnet.hypervisors[0].id
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

  user_data = base64encode(templatefile("${path.module}/templates/hypervisor-cloud-init.sh.tftpl", {
    aws_region                  = var.aws_region
    image_version               = each.value.image_version
    profile_name                = each.key
    cpu_millis                  = each.value.cpu_millis
    memory_mib                  = each.value.memory_mib
    disk_gib                    = each.value.disk_gib
    cpu_oversubscribe_ratio     = each.value.cpu_oversubscribe_ratio
    guest_profiles              = join(",", sort(tolist(each.value.guest_profiles)))
    controller_account_id       = var.controller_account_id
    execution_account_id        = var.execution_account_id
  }))

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name                      = "${var.name_prefix}-${each.key}-hypervisor"
      CloudAgentProject         = var.name_prefix
      CloudAgentRole            = "hypervisor"
      CloudAgentProfile         = each.key
      CloudAgentImageVersion    = each.value.image_version
      CloudAgentVirtualization  = each.value.virtualization
      Retention                 = "permanent"
      Ephemeral                 = "false"
      ExecutionAccount          = var.execution_account_id
    }
  }

  tag_specifications {
    resource_type = "volume"

    tags = {
      Name           = "${var.name_prefix}-${each.key}-hypervisor"
      CloudAgentRole = "hypervisor"
      Retention      = "permanent"
      Ephemeral      = "false"
    }
  }

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = var.execution_account_id != null && var.controller_account_id != null
      error_message = "Firecracker hypervisors require execution_account_id and controller_account_id."
    }

    precondition {
      condition     = var.execution_account_id != var.controller_account_id
      error_message = "Hypervisors must live in a dedicated execution account, not the controller account."
    }

    precondition {
      condition     = var.execution_account_id == data.aws_caller_identity.current.account_id
      error_message = "Apply hypervisor profiles from the execution account so guests never share the controller's AWS identity."
    }
  }
}

check "hypervisor_cleanup_cannot_target_hosts" {
  assert {
    condition = alltrue([
      for template in aws_launch_template.hypervisor : (
        one([
          for specification in template.tag_specifications :
          specification.tags["CloudAgentRole"]
          if specification.resource_type == "instance"
        ]) == "hypervisor" &&
        one([
          for specification in template.tag_specifications :
          specification.tags["Ephemeral"]
          if specification.resource_type == "instance"
        ]) == "false"
      )
    ])
    error_message = "Cleanup must not treat Firecracker hypervisors as expired workers."
  }
}
