resource "aws_s3_bucket" "artifacts" {
  bucket_prefix = "${var.name_prefix}-artifacts-"
  force_destroy = var.allow_retained_data_destroy

  tags = {
    Name      = "${var.name_prefix}-artifacts"
    Retention = "retained"
  }

  lifecycle {
    prevent_destroy = !var.allow_retained_data_destroy
  }
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }

    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  depends_on = [aws_s3_bucket_versioning.artifacts]

  rule {
    id     = "run-artifact-retention"
    status = "Enabled"

    filter {
      prefix = "runs/"
    }

    expiration {
      days = var.artifact_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.artifact_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "artifact_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifact_bucket.json
}

resource "aws_ebs_volume" "controller_data" {
  count = var.controller_mode == "ec2" ? 1 : 0

  availability_zone = aws_subnet.controller[0].availability_zone
  encrypted         = true
  size              = var.controller_data_volume_size_gib
  type              = "gp3"

  tags = {
    Name      = "${var.name_prefix}-controller-data"
    Role      = "controller"
    Retention = "retained"
  }

  lifecycle {
    prevent_destroy = !(var.allow_controller_data_destroy || var.allow_retained_data_destroy)
  }
}
