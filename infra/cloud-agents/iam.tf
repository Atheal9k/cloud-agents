locals {
  ec2_assume_role_services = ["ec2.amazonaws.com"]
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = local.ec2_assume_role_services
    }
  }
}

resource "aws_iam_role" "controller" {
  name_prefix        = "${var.name_prefix}-controller-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Role = "controller"
  }
}

resource "aws_iam_role" "worker" {
  name_prefix        = "${var.name_prefix}-worker-"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = {
    Role = "worker"
  }
}

resource "aws_iam_role_policy_attachment" "controller_ssm" {
  role       = aws_iam_role.controller.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "worker_ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "controller_artifacts" {
  statement {
    sid = "ListRetainedArtifacts"
    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    sid = "ManageRetainedArtifacts"
    actions = [
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/runs/*"]
  }
}

resource "aws_iam_role_policy" "controller_artifacts" {
  name   = "retained-artifacts"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller_artifacts.json
}

data "aws_iam_policy_document" "controller_credentials" {
  count = length(var.controller_credential_secret_arns) == 0 ? 0 : 1

  statement {
    sid = "ReadConfiguredControllerCredentials"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
    ]
    resources = var.controller_credential_secret_arns
  }
}

resource "aws_iam_role_policy" "controller_credentials" {
  count  = length(var.controller_credential_secret_arns) == 0 ? 0 : 1
  name   = "controller-credentials"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller_credentials[0].json
}

data "aws_iam_policy_document" "controller_worker_allocation" {
  statement {
    sid = "DiscoverWorkerTemplatesAndInstances"
    actions = [
      "ec2:DescribeInstances",
      "ec2:DescribeLaunchTemplates",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "LaunchTaggedWorkers"
    actions   = ["ec2:RunInstances"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/CloudAgentProject"
      values   = [var.name_prefix]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/CloudAgentRole"
      values   = ["worker"]
    }
  }

  statement {
    sid       = "TagWorkersDuringLaunch"
    actions   = ["ec2:CreateTags"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:CreateAction"
      values   = ["RunInstances"]
    }
  }

  statement {
    sid       = "TerminateOwnedWorkers"
    actions   = ["ec2:TerminateInstances"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/CloudAgentProject"
      values   = [var.name_prefix]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/CloudAgentRole"
      values   = ["worker"]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Ephemeral"
      values   = ["true"]
    }
  }

  statement {
    sid       = "RevokeWorkerRegistrationCredentials"
    actions   = ["ec2:DeleteTags"]
    resources = ["arn:${data.aws_partition.current.partition}:ec2:${var.aws_region}:${data.aws_caller_identity.current.account_id}:instance/*"]

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/CloudAgentProject"
      values   = [var.name_prefix]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/CloudAgentRole"
      values   = ["worker"]
    }

    condition {
      test     = "StringEquals"
      variable = "ec2:ResourceTag/Ephemeral"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["CloudAgentRegistrationCredential"]
    }
  }

  statement {
    sid       = "PassWorkerRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.worker.arn]
  }
}

resource "aws_iam_role_policy" "controller_worker_allocation" {
  name   = "worker-allocation"
  role   = aws_iam_role.controller.id
  policy = data.aws_iam_policy_document.controller_worker_allocation.json
}

data "aws_iam_policy_document" "worker_artifacts" {
  statement {
    sid = "WriteRunArtifacts"
    actions = [
      "s3:AbortMultipartUpload",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/runs/*"]
  }
}

resource "aws_iam_role_policy" "worker_artifacts" {
  name   = "write-run-artifacts"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_artifacts.json
}

data "aws_iam_policy_document" "worker_codex_credentials" {
  count = var.worker_codex_api_key_secret_arn == null ? 0 : 1

  statement {
    sid       = "ReadCodexApiKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.worker_codex_api_key_secret_arn]
  }
}

resource "aws_iam_role_policy" "worker_codex_credentials" {
  count  = var.worker_codex_api_key_secret_arn == null ? 0 : 1
  name   = "codex-api-key"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_codex_credentials[0].json
}

data "aws_iam_policy_document" "worker_codex_account_credentials" {
  count = var.worker_codex_auth_json_secret_arn == null ? 0 : 1

  statement {
    sid = "ReadAndRefreshCodexAccount"
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
    ]
    resources = [var.worker_codex_auth_json_secret_arn]
  }
}

resource "aws_iam_role_policy" "worker_codex_account_credentials" {
  count  = var.worker_codex_auth_json_secret_arn == null ? 0 : 1
  name   = "codex-account"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_codex_account_credentials[0].json
}

data "aws_iam_policy_document" "worker_claude_credentials" {
  count = var.worker_claude_oauth_token_secret_arn == null ? 0 : 1

  statement {
    sid       = "ReadClaudeOauthToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.worker_claude_oauth_token_secret_arn]
  }
}

resource "aws_iam_role_policy" "worker_claude_credentials" {
  count  = var.worker_claude_oauth_token_secret_arn == null ? 0 : 1
  name   = "claude-account"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker_claude_credentials[0].json
}

resource "aws_iam_instance_profile" "controller" {
  name_prefix = "${var.name_prefix}-controller-"
  role        = aws_iam_role.controller.name
}

resource "aws_iam_instance_profile" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  role        = aws_iam_role.worker.name
}
