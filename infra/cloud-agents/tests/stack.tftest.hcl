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

  assert {
    condition     = aws_iam_role.controller.name_prefix != aws_iam_role.worker.name_prefix
    error_message = "The controller and workers must use separate IAM roles."
  }

  assert {
    condition     = aws_instance.controller.disable_api_termination
    error_message = "The permanent controller must default to termination protection."
  }

  assert {
    condition     = aws_instance.controller.root_block_device[0].encrypted
    error_message = "The controller root volume must be encrypted."
  }

  assert {
    condition     = aws_ebs_volume.controller_data.encrypted
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
    condition     = aws_vpc_security_group_ingress_rule.worker_control.referenced_security_group_id == aws_security_group.controller.id
    error_message = "Worker control ingress must be scoped to the controller security group."
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.controller_worker_control.referenced_security_group_id == aws_security_group.worker.id
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

run "sandbox_apply" {
  command = apply

  providers = {
    archive = archive.mock
    aws     = aws.mock
  }

  variables {
    allow_retained_data_destroy       = true
    controller_termination_protection = false
    name_prefix                       = "t3-ca03-test"
  }

  assert {
    condition     = aws_s3_bucket.artifacts.force_destroy
    error_message = "An isolated sandbox must opt in before teardown can remove retained artifacts."
  }

  assert {
    condition     = !aws_instance.controller.disable_api_termination
    error_message = "An isolated sandbox must disable controller termination protection before teardown."
  }
}
