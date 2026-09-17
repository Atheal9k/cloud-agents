output "aws_region" {
  description = "AWS region containing the personal cloud-agent stack."
  value       = var.aws_region
}

output "controller" {
  description = "Stable references for the permanent controller."
  value = {
    instance_id       = aws_instance.controller.id
    public_ip         = aws_eip.controller.public_ip
    role_arn          = aws_iam_role.controller.arn
    data_volume       = aws_ebs_volume.controller_data.id
    security_group_id = aws_security_group.controller.id
  }
}

output "worker" {
  description = "References consumed by the future allocation reactor."
  value = {
    role_arn          = aws_iam_role.worker.arn
    security_group_id = aws_security_group.worker.id
    subnet_id         = aws_subnet.workers.id
    launch_templates = {
      for name, template in aws_launch_template.worker : name => {
        id      = template.id
        version = template.latest_version
      }
    }
  }
}

output "artifact_bucket_name" {
  description = "Encrypted retained bucket for run results."
  value       = aws_s3_bucket.artifacts.id
}

output "recovery_diagnostics_document_name" {
  description = "Fixed SSM diagnostics document for operational recovery."
  value       = aws_ssm_document.recovery_diagnostics.name
}

output "cleanup_backstop_function_name" {
  description = "Lambda that terminates expired tagged workers independently of the controller."
  value       = aws_lambda_function.expired_worker_cleanup.function_name
}
