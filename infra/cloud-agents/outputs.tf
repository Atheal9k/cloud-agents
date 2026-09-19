output "aws_region" {
  description = "AWS region containing the personal cloud-agent stack."
  value       = var.aws_region
}

output "controller" {
  description = "Controller deployment mode and EC2 references when controller_mode is ec2."
  value = var.controller_mode == "ec2" ? {
    mode              = var.controller_mode
    instance_id       = aws_instance.controller[0].id
    public_ip         = aws_eip.controller[0].public_ip
    role_arn          = aws_iam_role.controller[0].arn
    data_volume       = aws_ebs_volume.controller_data[0].id
    security_group_id = aws_security_group.controller[0].id
    url               = "https://${local.controller_hostname}"
    image_ref         = var.controller_image_ref
    } : {
    mode              = var.controller_mode
    instance_id       = null
    public_ip         = null
    role_arn          = null
    data_volume       = null
    security_group_id = null
    url               = null
    image_ref         = null
  }
}

output "worker" {
  description = "References consumed by the future allocation reactor."
  value = {
    role_arn          = aws_iam_role.worker.arn
    security_group_id = aws_security_group.worker.id
    subnet_id         = aws_subnet.workers.id
    launch_templates = merge(
      {
        for name, template in aws_launch_template.worker : name => {
          id            = template.id
          version       = template.latest_version
          image_id      = var.worker_profiles[name].ami_id
          image_version = var.worker_profiles[name].image_version
        }
      },
      {
        for name, template in aws_launch_template.mac_worker : name => {
          id            = template.id
          version       = template.latest_version
          image_id      = var.mac_worker_profiles[name].ami_id
          image_version = var.mac_worker_profiles[name].image_version
        }
      },
    )
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
