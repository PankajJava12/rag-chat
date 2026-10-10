#!/bin/sh
set -eu
export AWS_DEFAULT_REGION=ap-south-1
awslocal s3api head-bucket --bucket advisor-policies-local 2>/dev/null || awslocal s3api create-bucket --bucket advisor-policies-local --create-bucket-configuration LocationConstraint=ap-south-1
awslocal s3api put-bucket-versioning --bucket advisor-policies-local --versioning-configuration Status=Enabled
awslocal s3api put-public-access-block --bucket advisor-policies-local --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awslocal s3api put-bucket-encryption --bucket advisor-policies-local --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
awslocal sqs create-queue --queue-name advisor-ingestion-dlq --attributes '{"MessageRetentionPeriod":"1209600","SqsManagedSseEnabled":"true"}' >/dev/null
awslocal sqs create-queue --queue-name advisor-ingestion --attributes '{"VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"0","SqsManagedSseEnabled":"true","RedrivePolicy":"{\"deadLetterTargetArn\":\"arn:aws:sqs:ap-south-1:000000000000:advisor-ingestion-dlq\",\"maxReceiveCount\":\"5\"}"}' >/dev/null
touch /tmp/advisor-ready
