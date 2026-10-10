resource "aws_kms_key" "data" {
  description             = "${var.name} policy storage"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_s3_bucket" "policies" {
  bucket_prefix = "${var.name}-policies-"
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_public_access_block" "policies" {
  bucket                  = aws_s3_bucket.policies.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "policies" {
  bucket = aws_s3_bucket.policies.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "policies" {
  bucket = aws_s3_bucket.policies.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_policy" "tls" {
  bucket = aws_s3_bucket.policies.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.policies.arn, "${aws_s3_bucket.policies.arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } }] })
}
resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-ingestion-dlq"
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}
resource "aws_sqs_queue" "ingestion" {
  name                       = "${var.name}-ingestion"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 30
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_parameter_group" "main" {
  name   = var.name
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}
resource "aws_db_instance" "main" {
  identifier                      = var.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = "db.t4g.medium"
  allocated_storage               = 50
  max_allocated_storage           = 200
  db_name                         = "advisor"
  username                        = "advisor_owner"
  manage_master_user_password     = true
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  multi_az                        = true
  publicly_accessible             = false
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.main.name
  backup_retention_period         = 14
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-final-snapshot"
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade      = true
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = var.name
  description                = "Advisor private cache"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token
  auth_token_update_strategy = "SET"
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  snapshot_retention_limit   = 7
}
resource "aws_cognito_user_pool" "main" {
  name                     = var.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = "ACTIVE"
  password_policy {
    minimum_length    = 12
    require_lowercase = true
    require_uppercase = true
    require_numbers   = true
    require_symbols   = true
  }
}
resource "aws_cognito_user_pool_client" "main" {
  name                          = "${var.name}-web"
  user_pool_id                  = aws_cognito_user_pool.main.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
}
