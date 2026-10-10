mock_provider "aws" {
  mock_data "aws_caller_identity" { defaults = { account_id = "000000000000" } }
  mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:ap-south-1:000000000000:key/00000000-0000-0000-0000-000000000000" } }
  mock_resource "aws_iam_role" { defaults = { arn = "arn:aws:iam::000000000000:role/fixture" } }
  mock_resource "aws_lb" { defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:000000000000:loadbalancer/app/fixture/0000000000000000" } }
  mock_resource "aws_lb_target_group" { defaults = { arn = "arn:aws:elasticloadbalancing:ap-south-1:000000000000:targetgroup/fixture/0000000000000000" } }
  mock_resource "aws_sqs_queue" { defaults = { arn = "arn:aws:sqs:ap-south-1:000000000000:fixture", url = "https://sqs.ap-south-1.amazonaws.com/000000000000/fixture" } }
  mock_resource "aws_s3_bucket" { defaults = { arn = "arn:aws:s3:::fixture-bucket" } }

}
variables {
  deployment_approved   = true
  certificate_arn       = "arn:aws:acm:ap-south-1:000000000000:certificate/fixture"
  allowed_origin        = "https://advisor.example.test"
  api_image             = "example.test/api@sha256:fixture"
  web_image             = "example.test/web@sha256:fixture"
  clamav_image          = "example.test/clamav@sha256:fixture"
  app_secret_arn        = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:app-fixture"
  worker_secret_arn     = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:worker-fixture"
  redis_auth_secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:cache-fixture"
  redis_auth_token      = "FixtureOnlyRedisPassword123456789"
  embedding_url         = "http://embedding.internal:11434"
  chat_url              = "http://chat.internal:11434"
}
run "security_baseline" {
  command = apply
  assert {
    condition     = !aws_db_instance.main.publicly_accessible && aws_db_instance.main.storage_encrypted && aws_db_instance.main.multi_az && aws_db_instance.main.deletion_protection
    error_message = "RDS must be private, encrypted, HA and deletion-protected."
  }
  assert {
    condition     = aws_elasticache_replication_group.main.transit_encryption_enabled && aws_elasticache_replication_group.main.at_rest_encryption_enabled
    error_message = "Cache transport and at-rest encryption are required."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.policies.block_public_policy && aws_s3_bucket_versioning.policies.versioning_configuration[0].status == "Enabled" && !aws_s3_bucket.policies.force_destroy
    error_message = "Policy objects must be private, versioned and protected from force deletion."
  }
  assert {
    condition     = aws_lb_listener.https.protocol == "HTTPS" && aws_lb.main.idle_timeout == 300 && !aws_ecs_service.api.network_configuration[0].assign_public_ip
    error_message = "HTTPS and private application tasks are required."
  }
  assert {
    condition     = aws_sqs_queue.ingestion.sqs_managed_sse_enabled && jsondecode(aws_sqs_queue.ingestion.redrive_policy).maxReceiveCount == 5
    error_message = "SQS must be encrypted with bounded poison retries."
  }
}
run "production_gate" {
  command = plan
  variables { deployment_approved = false }
  expect_failures = [var.deployment_approved]
}
