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

output "hypervisor" {
  description = "Firecracker host templates in the execution account. Empty when packing is not enabled and EC2 workers remain the documented fallback."
  value = {
    execution_account_id = var.execution_account_id
    controller_account_id = var.controller_account_id
    role_arn             = try(aws_iam_role.hypervisor[0].arn, null)
    security_group_id    = try(aws_security_group.hypervisor[0].id, null)
    subnet_id            = try(aws_subnet.hypervisors[0].id, null)
    launch_templates = {
      for name, template in aws_launch_template.hypervisor : name => {
        id            = template.id
        version       = template.latest_version
        image_id      = var.hypervisor_profiles[name].ami_id
        image_version = var.hypervisor_profiles[name].image_version
        cpu_millis    = var.hypervisor_profiles[name].cpu_millis
        memory_mib    = var.hypervisor_profiles[name].memory_mib
        disk_gib      = var.hypervisor_profiles[name].disk_gib
      }
    }
  }
}

output "artifacts_bucket" {
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
