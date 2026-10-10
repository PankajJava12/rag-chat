terraform {
  required_version = ">= 1.14.0, < 2.0.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}
provider "aws" {
  region                      = "ap-south-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true
  endpoints {
    s3  = "http://localhost:4566"
    sqs = "http://localhost:4566"
  }
}
resource "aws_s3_bucket" "validation" {
  bucket = "advisor-tf-validation"
}
resource "aws_s3_bucket_versioning" "validation" {
  bucket = aws_s3_bucket.validation.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_public_access_block" "validation" {
  bucket                  = aws_s3_bucket.validation.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "validation" {
  bucket = aws_s3_bucket.validation.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_sqs_queue" "dlq" {
  name                    = "advisor-tf-dlq"
  sqs_managed_sse_enabled = true
}
resource "aws_sqs_queue" "validation" {
  name                       = "advisor-tf-ingestion"
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 30
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq.arn, maxReceiveCount = 5 })
}
