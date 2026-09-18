moved {
  from = aws_instance.controller
  to   = aws_instance.controller[0]
}

moved {
  from = aws_eip.controller
  to   = aws_eip.controller[0]
}

moved {
  from = aws_eip_association.controller
  to   = aws_eip_association.controller[0]
}

moved {
  from = aws_volume_attachment.controller_data
  to   = aws_volume_attachment.controller_data[0]
}

moved {
  from = aws_subnet.controller
  to   = aws_subnet.controller[0]
}

moved {
  from = aws_route_table_association.controller
  to   = aws_route_table_association.controller[0]
}

moved {
  from = aws_security_group.controller
  to   = aws_security_group.controller[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.controller_https
  to   = aws_vpc_security_group_egress_rule.controller_https[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.controller_worker_control
  to   = aws_vpc_security_group_egress_rule.controller_worker_control[0]
}

moved {
  from = aws_vpc_security_group_egress_rule.controller_worker_preview
  to   = aws_vpc_security_group_egress_rule.controller_worker_preview[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.worker_control
  to   = aws_vpc_security_group_ingress_rule.worker_control[0]
}

moved {
  from = aws_vpc_security_group_ingress_rule.worker_preview
  to   = aws_vpc_security_group_ingress_rule.worker_preview[0]
}

moved {
  from = aws_ebs_volume.controller_data
  to   = aws_ebs_volume.controller_data[0]
}

moved {
  from = aws_iam_role.controller
  to   = aws_iam_role.controller[0]
}

moved {
  from = aws_iam_role_policy_attachment.controller_ssm
  to   = aws_iam_role_policy_attachment.controller_ssm[0]
}

moved {
  from = aws_iam_role_policy.controller_artifacts
  to   = aws_iam_role_policy.controller_artifacts[0]
}

moved {
  from = aws_iam_role_policy.controller_worker_allocation
  to   = aws_iam_role_policy.controller_worker_allocation[0]
}

moved {
  from = aws_iam_instance_profile.controller
  to   = aws_iam_instance_profile.controller[0]
}
