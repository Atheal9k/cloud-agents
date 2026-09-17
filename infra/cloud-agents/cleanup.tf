data "archive_file" "expired_worker_cleanup" {
  type        = "zip"
  source_file = "${path.module}/functions/cleanup_expired_workers.py"
  output_path = "${path.module}/build/cleanup_expired_workers.zip"
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "expired_worker_cleanup" {
  name_prefix        = "${var.name_prefix}-cleanup-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Role = "cleanup-backstop"
  }
}

resource "aws_cloudwatch_log_group" "expired_worker_cleanup" {
  name              = "/aws/lambda/${var.name_prefix}-expired-worker-cleanup"
  retention_in_days = 14
}

data "aws_iam_policy_document" "expired_worker_cleanup" {
  statement {
    sid       = "DescribeWorkers"
    actions   = ["ec2:DescribeInstances"]
    resources = ["*"]
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
    sid = "WriteCleanupLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.expired_worker_cleanup.arn}:*"]
  }
}

resource "aws_iam_role_policy" "expired_worker_cleanup" {
  name   = "terminate-expired-workers"
  role   = aws_iam_role.expired_worker_cleanup.id
  policy = data.aws_iam_policy_document.expired_worker_cleanup.json
}

resource "aws_lambda_function" "expired_worker_cleanup" {
  function_name = "${var.name_prefix}-expired-worker-cleanup"
  description   = "Independent backstop that terminates expired cloud-agent workers"
  role          = aws_iam_role.expired_worker_cleanup.arn
  runtime       = "python3.13"
  handler       = "cleanup_expired_workers.handler"
  architectures = ["arm64"]
  timeout       = 60
  memory_size   = 128

  filename         = data.archive_file.expired_worker_cleanup.output_path
  source_code_hash = data.archive_file.expired_worker_cleanup.output_base64sha256

  environment {
    variables = {
      CLOUD_AGENT_PROJECT = var.name_prefix
      DEFAULT_TTL_MINUTES = tostring(var.worker_default_ttl_minutes)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.expired_worker_cleanup,
    aws_iam_role_policy.expired_worker_cleanup,
  ]

  tags = {
    Role = "cleanup-backstop"
  }
}

resource "aws_cloudwatch_event_rule" "expired_worker_cleanup" {
  name                = "${var.name_prefix}-expired-worker-cleanup"
  description         = "Check tagged disposable workers for expired TTLs"
  schedule_expression = "rate(${var.cleanup_schedule_minutes} minutes)"
}

resource "aws_cloudwatch_event_target" "expired_worker_cleanup" {
  rule      = aws_cloudwatch_event_rule.expired_worker_cleanup.name
  target_id = "ExpiredWorkerCleanup"
  arn       = aws_lambda_function.expired_worker_cleanup.arn
}

resource "aws_lambda_permission" "expired_worker_cleanup" {
  statement_id  = "AllowEventBridgeCleanup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.expired_worker_cleanup.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.expired_worker_cleanup.arn
}
