resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 90
  kms_key_id        = aws_kms_key.logs.arn
}
resource "aws_kms_key" "logs" {
  description         = "Advisor audit/service log encryption"
  enable_key_rotation = true
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
    { Effect = "Allow", Principal = { Service = "logs.${var.region}.amazonaws.com" }, Action = ["kms:Encrypt", "kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:DescribeKey"], Resource = "*", Condition = { ArnEquals = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/ecs/${var.name}" } } }
  ] })
}
data "aws_caller_identity" "current" {}
resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.data.arn
  }
}
locals {
  trust = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
  secrets = {
    api    = var.app_secret_arn
    worker = var.worker_secret_arn
  }
  env = {
    NODE_ENV             = "production", DEPLOYMENT_TARGET = "aws", PRODUCTION_DEPLOYMENT_APPROVED = tostring(var.deployment_approved), AUTH_MODE = "cognito", STORAGE_PROVIDER = "s3", QUEUE_PROVIDER = "sqs", AWS_REGION = var.region,
    S3_BUCKET            = aws_s3_bucket.policies.id, S3_KMS_KEY_ID = aws_kms_key.data.arn, SQS_QUEUE_URL = aws_sqs_queue.ingestion.url,
    COGNITO_USER_POOL_ID = aws_cognito_user_pool.main.id, COGNITO_CLIENT_ID = aws_cognito_user_pool_client.main.id,
    ALLOWED_ORIGINS      = var.allowed_origin, OLLAMA_URL = var.embedding_url, OLLAMA_CHAT_URL = var.chat_url, ALLOW_EXTERNAL_AI = "true", CLAMAV_HOST = "127.0.0.1", API_PORT = "3000", WORKER_PORT = "3001"
  }
  logs = { logDriver = "awslogs", options = { "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-region" = var.region, "awslogs-stream-prefix" = "service" } }
}
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = local.trust
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secret_read" {
  role   = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [var.app_secret_arn, var.worker_secret_arn, var.redis_auth_secret_arn] }] })
}
resource "aws_iam_role" "task" {
  for_each           = local.secrets
  name               = "${var.name}-${each.key}"
  assume_role_policy = local.trust
}
resource "aws_iam_role_policy" "task" {
  for_each = local.secrets
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = each.key == "api" ? ["s3:GetObject", "s3:PutObject"] : ["s3:GetObject"], Resource = "${aws_s3_bucket.policies.arn}/*" },
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.policies.arn },
    { Effect = "Allow", Action = each.key == "api" ? ["kms:Decrypt", "kms:GenerateDataKey"] : ["kms:Decrypt"], Resource = aws_kms_key.data.arn, Condition = { StringEquals = { "kms:ViaService" = "s3.${var.region}.amazonaws.com" } } },
    { Effect = "Allow", Action = ["sqs:GetQueueAttributes"], Resource = aws_sqs_queue.ingestion.arn }
  ], each.key == "worker" ? [{ Effect = "Allow", Action = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage"], Resource = aws_sqs_queue.ingestion.arn }] : []) })
}
resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_ecs_task_definition" "app" {
  for_each                 = local.secrets
  family                   = "${var.name}-${each.key}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = "1024"
  memory                   = each.key == "api" ? "2048" : "4096"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode(concat([{
    name             = each.key, image = var.api_image, essential = true, user = "1000", readonlyRootFilesystem = true,
    command          = each.key == "api" ? ["node", "dist/apps/api/src/server.js"] : ["node", "dist/apps/worker/src/worker.js"],
    environment      = [for k, v in local.env : { name = k, value = v }],
    secrets          = concat([for key in concat(["DATABASE_URL", "STORAGE_ENCRYPTION_KEY"], each.key == "api" ? ["AUTH_SECRET"] : []) : { name = key, valueFrom = "${each.value}:${key}::" }], [{ name = "REDIS_URL", valueFrom = "${var.redis_auth_secret_arn}:REDIS_URL::" }]),
    mountPoints      = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }],
    portMappings     = [{ containerPort = each.key == "api" ? 3000 : 3001, protocol = "tcp" }],
    logConfiguration = local.logs,
    healthCheck      = { command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${each.key == "api" ? 3000 : 3001}/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""], interval = 30, timeout = 5, retries = 3, startPeriod = 60 },
    linuxParameters  = { initProcessEnabled = true, capabilities = { drop = ["ALL"] } },
    stopTimeout      = 30
  }], each.key == "api" ? [{ name = "web", image = var.web_image, essential = true, environment = [{ name = "API_UPSTREAM", value = "127.0.0.1:3000" }], portMappings = [{ containerPort = 8080, protocol = "tcp" }], logConfiguration = local.logs }] : [{ name = "clamav", image = var.clamav_image, essential = true, environment = [], portMappings = [{ containerPort = 3310, protocol = "tcp" }], logConfiguration = local.logs }]))
}
resource "aws_lb" "main" {
  name                       = var.name
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  idle_timeout               = 300
  enable_deletion_protection = true
}
resource "aws_lb_target_group" "web" {
  name        = var.name
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path    = "/health/ready"
    matcher = "200"
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["api"].arn
  desired_count   = var.desired_api_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 8080
  }
  depends_on = [aws_lb_listener.https, aws_route.nat]
}
resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app["worker"].arn
  desired_count   = var.desired_worker_count
  launch_type     = "FARGATE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  depends_on = [aws_route.nat]
}
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.name}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.ingestion.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 300
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
resource "aws_cloudwatch_metric_alarm" "dlq" {
  alarm_name          = "${var.name}-dlq"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
}
output "bucket" {
  value = aws_s3_bucket.policies.id
}
output "queue" {
  value = aws_sqs_queue.ingestion.url
}
output "database_endpoint" {
  value = aws_db_instance.main.address
}
output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}
output "cognito_pool" {
  value = aws_cognito_user_pool.main.id
}
output "alb_dns" {
  value = aws_lb.main.dns_name
}
