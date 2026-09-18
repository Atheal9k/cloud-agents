mock_provider "aws" {
  alias = "mock"

  mock_data "aws_ami" {
    defaults = {
      id = "ami-0123456789abcdef0"
    }
  }

  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-west-1a"]
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/t3-ca03-test"
    }
  }

  mock_resource "aws_lambda_function" {
    defaults = {
      arn = "arn:aws:lambda:us-west-1:123456789012:function:t3-ca03-test-cleanup"
    }
  }

  mock_resource "aws_cloudwatch_event_rule" {
    defaults = {
      arn = "arn:aws:events:us-west-1:123456789012:rule/t3-ca03-test-cleanup"
    }
  }
}

mock_provider "archive" {
  alias = "mock"
}

run "protected_plan" {
  command = plan

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    controller_mode = "ec2"
    controller_credential_secret_arns = [
      "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-victor-key-AbCdEf",
      "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-github-token-AbCdEf",
    ]
    worker_claude_oauth_token_secret_arn = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-claude-oauth-AbCdEf"
    worker_codex_auth_json_secret_arn    = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-codex-auth-json-AbCdEf"
    worker_tailscale_auth_key_secret_arn = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-tailscale-auth-AbCdEf"
    worker_profiles = {
      linux-web = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca27.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
      }
      linux-web-browser = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca35.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
        capabilities         = ["coding", "web-preview", "shared-browser"]
        desktop_dependencies = true
        shared_browser       = true
      }
    }
  }

  assert {
    condition     = aws_iam_role.controller[0].name_prefix != aws_iam_role.worker.name_prefix
    error_message = "The controller and workers must use separate IAM roles."
  }

  assert {
    condition = alltrue([
      strcontains(base64decode(aws_launch_template.worker["linux-web-browser"].user_data), "T3CODE_SHARED_BROWSER_THREAD_ID"),
      strcontains(base64decode(aws_launch_template.worker["linux-web-browser"].user_data), "T3CODE_SHARED_BROWSER_COMMAND"),
      strcontains(base64decode(aws_launch_template.worker["linux-web-browser"].user_data), "T3CODE_SHARED_BROWSER_PERMISSION_COMMAND"),
      one([
        for specification in aws_launch_template.worker["linux-web-browser"].tag_specifications :
        specification.tags["CloudAgentSharedBrowser"]
        if specification.resource_type == "instance"
      ]) == "true",
    ])
    error_message = "The browser profile must bind the shared viewer lifecycle to the allocation attempt."
  }

  assert {
    condition = alltrue([
      aws_vpc_security_group_ingress_rule.worker_control[0].from_port != 8443,
      aws_vpc_security_group_ingress_rule.worker_preview[0].from_port != 8443,
      aws_vpc_security_group_ingress_rule.worker_preview[0].to_port != 8443,
    ])
    error_message = "Amazon DCV must not have direct worker security-group ingress."
  }

  assert {
    condition     = length(aws_iam_role_policy.controller_credentials) == 1
    error_message = "Configured Git and GitHub master credentials must be readable only by the controller role."
  }

  assert {
    condition = alltrue([
      length(aws_iam_role_policy.worker_codex_credentials) == 0,
      length(aws_iam_role_policy.worker_codex_account_credentials) == 1,
      length(aws_iam_role_policy.worker_claude_credentials) == 1,
      length(aws_iam_role_policy.worker_tailscale_credentials) == 1,
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-codex-auth-json-AbCdEf"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "install -d -o cloudagent -g cloudagent -m 0700 /run/t3-worker/credentials"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cli_auth_credentials_store = \"file\""),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-codex-auth-sync.path"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-claude-oauth-AbCdEf"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "CLAUDE_CODE_OAUTH_TOKEN"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-tailscale-auth-AbCdEf"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "--auth-key=\"file:"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "tailscale serve --bg --yes --https=443"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "CloudAgentWorkerRouteUrl"),
    ])
    error_message = "Configured Codex and Claude subscriptions must be fetched by the disposable worker without embedding credential values."
  }

  assert {
    condition     = aws_instance.controller[0].disable_api_termination
    error_message = "The permanent controller must default to termination protection."
  }

  assert {
    condition     = aws_instance.controller[0].root_block_device[0].encrypted
    error_message = "The controller root volume must be encrypted."
  }

  assert {
    condition     = aws_ebs_volume.controller_data[0].encrypted
    error_message = "The retained controller data volume must be encrypted."
  }

  assert {
    condition     = !aws_s3_bucket.artifacts.force_destroy
    error_message = "Retained artifacts must resist deletion by default."
  }

  assert {
    condition     = one(one(aws_s3_bucket_server_side_encryption_configuration.artifacts.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Run artifacts must use server-side encryption."
  }

  assert {
    condition     = aws_launch_template.worker["linux-web"].block_device_mappings[0].ebs[0].encrypted
    error_message = "Disposable worker root volumes must be encrypted."
  }

  assert {
    condition     = aws_launch_template.worker["linux-web"].image_id == "ami-0123456789abcdef0"
    error_message = "Workers must launch from the explicitly selected baked image."
  }

  assert {
    condition = (
      aws_launch_template.worker["linux-web"].tags["CloudAgentProject"] == "t3-cloud-agents" &&
      aws_launch_template.worker["linux-web"].tags["CloudAgentProfile"] == "linux-web"
    )
    error_message = "The controller must be able to discover exactly one launch template by project and profile."
  }

  assert {
    condition     = aws_iam_role_policy.controller_worker_allocation[0].role == aws_iam_role.controller[0].id
    error_message = "Only the controller role may allocate and terminate workers."
  }

  assert {
    condition     = aws_launch_template.worker["linux-web"].metadata_options[0].instance_metadata_tags == "enabled"
    error_message = "The root registration unit must be able to read attempt-bound launch tags."
  }

  assert {
    condition = alltrue([
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "0.0.42-ca27.1"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "systemctl start cloud-agent-worker.service"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-worker-registration.service"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "startup-timings.pending.json"),
      !strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), aws_s3_bucket.artifacts.id),
    ])
    error_message = "Worker bootstrap must validate the pinned image, start its baked services, and omit controller-owned configuration."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.worker_control[0].referenced_security_group_id == aws_security_group.controller[0].id
    error_message = "Worker control ingress must be scoped to the controller security group."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.controller_worker_control[0].referenced_security_group_id == aws_security_group.worker.id
    error_message = "Controller control egress must be scoped to the worker security group."
  }

  assert {
    condition     = !can(jsondecode(aws_ssm_document.recovery_diagnostics.content).parameters)
    error_message = "The recovery document must not accept a task command or other runtime parameters."
  }

  assert {
    condition     = aws_cloudwatch_event_target.expired_worker_cleanup.arn == aws_lambda_function.expired_worker_cleanup.arn
    error_message = "The independent schedule must invoke expired-worker cleanup."
  }
}

run "local_controller_plan" {
  command = plan

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    controller_mode = "local"
    controller_credential_secret_arns = [
      "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-victor-key-AbCdEf",
    ]
    worker_codex_auth_json_secret_arn    = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-codex-auth-json-AbCdEf"
    worker_tailscale_auth_key_secret_arn = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-tailscale-auth-AbCdEf"
    worker_profiles = {
      linux-web = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca27.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
      }
    }
  }

  assert {
    condition = alltrue([
      length(aws_instance.controller) == 0,
      length(aws_eip.controller) == 0,
      length(aws_ebs_volume.controller_data) == 0,
      length(aws_subnet.controller) == 0,
      length(aws_security_group.controller) == 0,
      length(aws_iam_role.controller) == 0,
      length(aws_iam_instance_profile.controller) == 0,
      length(aws_iam_role_policy.controller_credentials) == 0,
      length(aws_iam_role_policy.controller_worker_allocation) == 0,
    ])
    error_message = "Local-controller mode must not provision permanent EC2 controller resources."
  }

  assert {
    condition = alltrue([
      length(aws_vpc_security_group_ingress_rule.worker_control) == 0,
      length(aws_vpc_security_group_ingress_rule.worker_preview) == 0,
      length(aws_launch_template.worker) == 1,
      length(aws_iam_role_policy.worker_codex_account_credentials) == 1,
      length(aws_iam_role_policy.worker_tailscale_credentials) == 1,
      output.controller.mode == "local",
      output.controller.instance_id == null,
    ])
    error_message = "Local-controller mode must retain outbound-routed worker infrastructure without opening worker ingress."
  }
}

run "api_key_plan" {
  command = plan

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    worker_claude_oauth_token_secret_arn = null
    worker_codex_api_key_secret_arn      = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-codex-api-key-AbCdEf"
    worker_codex_auth_json_secret_arn    = null
    worker_tailscale_auth_key_secret_arn = null
    worker_profiles = {
      linux-web = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca27.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
      }
    }
  }

  assert {
    condition = alltrue([
      length(aws_iam_role_policy.worker_codex_credentials) == 1,
      length(aws_iam_role_policy.worker_codex_account_credentials) == 0,
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "cloud-agent-codex-api-key-AbCdEf"),
      strcontains(base64decode(aws_launch_template.worker["linux-web"].user_data), "codex login --with-api-key"),
    ])
    error_message = "The existing Codex API-key authentication mode must remain available."
  }
}

run "ambiguous_codex_authentication" {
  command = plan

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    worker_codex_api_key_secret_arn      = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-codex-api-key-AbCdEf"
    worker_codex_auth_json_secret_arn    = "arn:aws:secretsmanager:us-west-1:123456789012:secret:cloud-agent-codex-auth-json-AbCdEf"
    worker_tailscale_auth_key_secret_arn = null
    worker_profiles = {
      linux-web = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca27.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
      }
    }
  }

  expect_failures = [aws_launch_template.worker]
}

run "sandbox_apply" {
  command = apply

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    allow_retained_data_destroy          = true
    controller_mode                      = "ec2"
    controller_termination_protection    = false
    name_prefix                          = "t3-ca03-test"
    worker_claude_oauth_token_secret_arn = null
    worker_codex_api_key_secret_arn      = null
    worker_codex_auth_json_secret_arn    = null
    worker_tailscale_auth_key_secret_arn = null
    worker_profiles = {
      linux-web = {
        ami_id               = "ami-0123456789abcdef0"
        image_version        = "0.0.42-ca27.1"
        instance_type        = "t3.medium"
        root_volume_size_gib = 30
      }
    }
  }

  assert {
    condition     = aws_s3_bucket.artifacts.force_destroy
    error_message = "An isolated sandbox must opt in before teardown can remove retained artifacts."
  }

  assert {
    condition     = !aws_instance.controller[0].disable_api_termination
    error_message = "An isolated sandbox must disable controller termination protection before teardown."
  }

  assert {
    condition = alltrue([
      length(aws_iam_role_policy.worker_codex_credentials) == 0,
      length(aws_iam_role_policy.worker_codex_account_credentials) == 0,
      length(aws_iam_role_policy.worker_claude_credentials) == 0,
      length(aws_iam_role_policy.worker_tailscale_credentials) == 0,
    ])
    error_message = "Workers must not receive provider-secret access unless provider authentication is configured."
  }
}
