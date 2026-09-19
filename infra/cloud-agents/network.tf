resource "aws_vpc" "cloud_agents" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.name_prefix}-vpc"
  }
}

resource "aws_internet_gateway" "cloud_agents" {
  vpc_id = aws_vpc.cloud_agents.id

  tags = {
    Name = "${var.name_prefix}-igw"
  }
}

resource "aws_subnet" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  vpc_id                  = aws_vpc.cloud_agents.id
  cidr_block              = var.controller_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name_prefix}-controller"
    Role = "controller"
  }
}

resource "aws_subnet" "workers" {
  vpc_id                  = aws_vpc.cloud_agents.id
  cidr_block              = var.worker_subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.name_prefix}-workers"
    Role = "worker"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.cloud_agents.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.cloud_agents.id
  }

  tags = {
    Name = "${var.name_prefix}-public"
  }
}

resource "aws_route_table_association" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  subnet_id      = aws_subnet.controller[0].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "workers" {
  subnet_id      = aws_subnet.workers.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "controller" {
  count = var.controller_mode == "ec2" ? 1 : 0

  name_prefix = "${var.name_prefix}-controller-"
  description = "Permanent controller ingress and egress"
  vpc_id      = aws_vpc.cloud_agents.id

  tags = {
    Name = "${var.name_prefix}-controller"
    Role = "controller"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "controller_https" {
  for_each = var.controller_mode == "ec2" ? toset(var.controller_ingress_cidrs) : toset([])

  security_group_id = aws_security_group.controller[0].id
  description       = "HTTPS from a trusted owner network"
  cidr_ipv4         = each.value
  from_port         = var.controller_service_port
  to_port           = var.controller_service_port
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "controller_https" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id = aws_security_group.controller[0].id
  description       = "HTTPS to AWS APIs, providers, Git hosts, and package registries"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "controller_tailscale" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id = aws_security_group.controller[0].id
  description       = "Direct Tailscale connections; without it the tailnet falls back to relays over 443"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 41641
  to_port           = 41641
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_egress_rule" "controller_worker_control" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id            = aws_security_group.controller[0].id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "T3 traffic to disposable workers"
  from_port                    = var.worker_control_port
  to_port                      = var.worker_control_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "controller_worker_preview" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id            = aws_security_group.controller[0].id
  referenced_security_group_id = aws_security_group.worker.id
  description                  = "Preview proxy traffic to disposable workers"
  from_port                    = var.worker_preview_port_range.from
  to_port                      = var.worker_preview_port_range.to
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  description = "Disposable worker access from the permanent controller only"
  vpc_id      = aws_vpc.cloud_agents.id

  tags = {
    Name = "${var.name_prefix}-worker"
    Role = "worker"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "worker_control" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.controller[0].id
  description                  = "T3 traffic from the controller"
  from_port                    = var.worker_control_port
  to_port                      = var.worker_control_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "worker_preview" {
  count = var.controller_mode == "ec2" ? 1 : 0

  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.controller[0].id
  description                  = "Preview traffic from the controller proxy"
  from_port                    = var.worker_preview_port_range.from
  to_port                      = var.worker_preview_port_range.to
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "worker_https" {
  security_group_id = aws_security_group.worker.id
  description       = "HTTPS to the controller, AWS APIs, Git hosts, and package registries"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
