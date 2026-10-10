variable "region" {
  default = "ap-south-1"
}
variable "name" {
  default = "advisor"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name))
    error_message = "Use a short lowercase resource prefix."
  }
}
variable "availability_zones" {
  type    = list(string)
  default = ["ap-south-1a", "ap-south-1b"]
  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Exactly two availability zones are required."
  }
}
variable "vpc_cidr" {
  default = "10.42.0.0/16"
}
variable "certificate_arn" {
  type = string
}
variable "allowed_origin" {
  type = string
}
variable "api_image" {
  type = string
}
variable "web_image" {
  type = string
}
variable "clamav_image" {
  type = string
}
variable "app_secret_arn" {
  type = string
}
variable "worker_secret_arn" {
  type = string
}
variable "redis_auth_secret_arn" {
  type = string
}
variable "redis_auth_token" {
  type      = string
  sensitive = true
}
variable "embedding_url" {
  type = string
}
variable "chat_url" {
  type = string
}
variable "deployment_approved" {
  type    = bool
  default = false
  validation {
    condition     = var.deployment_approved
    error_message = "AWS deployment is gated: LocalStack validation and explicit user approval are required."
  }
}
variable "desired_api_count" {
  default = 2
}
variable "desired_worker_count" {
  default = 1
}
