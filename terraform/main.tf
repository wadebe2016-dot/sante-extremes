###############################################################################
# Santé des extrêmes — LOT 2 : infrastructure AWS (eu-west-3 / Paris)
#
# Architecture :
#   Internet ──HTTPS──> ALB (ACM) ──> ECS Fargate (backend Express, 1 tâche)
#                                       │
#                                       ├── S3 « db »      : base SQLite (restore/backup)
#                                       └── S3 « uploads »  : justificatifs de paiement
#                                                  │
#                                            CloudFront (ACM us-east-1) ──> lecture publique
#
# Choix assumés :
#   - PAS de RDS : la base reste SQLite, persistée sur S3 (versioning activé).
#   - Par conséquent le service ECS tourne avec UNE SEULE tâche (mono-écrivain)
#     et le déploiement arrête l'ancienne tâche avant d'en démarrer une nouvelle.
#   - Aucun secret en dur : le mot de passe admin vit dans Secrets Manager,
#     la CI s'authentifie via OIDC (aucune clé AWS stockée dans GitHub).
#   - Pas de NAT Gateway (≈ 32 €/mois économisés) : les tâches sont en sous-réseau
#     public avec IP publique, protégées par le groupe de sécurité (ALB uniquement).
###############################################################################

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # État distant : décommenter APRÈS avoir créé le bucket (cf. docs/DEPLOYMENT.md § 2.1)
  # backend "s3" {
  #   bucket  = "sde-terraform-state-<ID_COMPTE>"
  #   key     = "prod/terraform.tfstate"
  #   region  = "eu-west-3"
  #   encrypt = true
  #   # Verrou d'état : use_lockfile exige Terraform >= 1.10.
  #   # Sur une version antérieure, utiliser dynamodb_table = "sde-terraform-locks".
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}

# CloudFront n'accepte que des certificats ACM émis dans us-east-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "courant" {}

data "aws_availability_zones" "disponibles" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  prefixe = "${var.project_name}-${var.environment}"

  api_fqdn = "${var.api_subdomain}.${var.domain_name}"
  cdn_fqdn = "${var.cdn_subdomain}.${var.domain_name}"

  compte = data.aws_caller_identity.courant.account_id

  # Deux zones de disponibilité suffisent pour un ALB ; on prend les deux premières.
  zones = slice(data.aws_availability_zones.disponibles.names, 0, 2)

  # Identifiants de comptes AWS propriétaires des journaux ALB (régions historiques).
  comptes_logs_elb = {
    "eu-west-1"    = "156460612806"
    "eu-west-2"    = "652711504416"
    "eu-west-3"    = "009996457667"
    "eu-central-1" = "054676820928"
    "us-east-1"    = "127311923021"
    "us-west-2"    = "797873946194"
  }

  logs_alb_actifs = var.enable_alb_access_logs && contains(keys(local.comptes_logs_elb), var.aws_region)

  tags = merge(
    {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "terraform"
      Lot         = "lot2-deploiement-aws"
    },
    var.extra_tags
  )
}

###############################################################################
# Réseau — VPC dédié, 2 sous-réseaux publics, endpoint S3 (trafic S3 hors Internet)
###############################################################################

resource "aws_vpc" "principal" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${local.prefixe}-vpc" }
}

resource "aws_internet_gateway" "principal" {
  vpc_id = aws_vpc.principal.id

  tags = { Name = "${local.prefixe}-igw" }
}

resource "aws_subnet" "publics" {
  count = length(local.zones)

  vpc_id                  = aws_vpc.principal.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = local.zones[count.index]
  map_public_ip_on_launch = true

  tags = { Name = "${local.prefixe}-public-${local.zones[count.index]}" }
}

resource "aws_route_table" "publique" {
  vpc_id = aws_vpc.principal.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.principal.id
  }

  tags = { Name = "${local.prefixe}-rtb-public" }
}

resource "aws_route_table_association" "publics" {
  count = length(aws_subnet.publics)

  subnet_id      = aws_subnet.publics[count.index].id
  route_table_id = aws_route_table.publique.id
}

# Endpoint passerelle S3 : gratuit, évite de facturer le trafic base/justificatifs.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.principal.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.publique.id]

  tags = { Name = "${local.prefixe}-vpce-s3" }
}

###############################################################################
# Groupes de sécurité
###############################################################################

resource "aws_security_group" "alb" {
  name        = "${local.prefixe}-alb-sg"
  description = "Entrees HTTP/HTTPS publiques vers l'ALB"
  vpc_id      = aws_vpc.principal.id

  tags = { Name = "${local.prefixe}-alb-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  for_each = toset(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirige vers HTTPS)"
  cidr_ipv4         = each.value
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  for_each = toset(var.allowed_ingress_cidrs)

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  cidr_ipv4         = each.value
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_sortie" {
  security_group_id = aws_security_group.alb.id
  description       = "Sortie vers les taches ECS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_security_group" "ecs" {
  name        = "${local.prefixe}-ecs-sg"
  description = "Taches Fargate : entree uniquement depuis l'ALB"
  vpc_id      = aws_vpc.principal.id

  tags = { Name = "${local.prefixe}-ecs-sg" }
}

resource "aws_vpc_security_group_ingress_rule" "ecs_depuis_alb" {
  security_group_id            = aws_security_group.ecs.id
  description                  = "Trafic applicatif depuis l'ALB uniquement"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "ecs_sortie" {
  security_group_id = aws_security_group.ecs.id
  description       = "Sortie Internet (ECR, S3, Secrets Manager, CloudWatch)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

###############################################################################
# S3 — base SQLite, justificatifs, journaux ALB
###############################################################################

# --- Base SQLite persistée (source de vérité entre deux démarrages de tâche) ---
resource "aws_s3_bucket" "base" {
  bucket = "${local.prefixe}-db-${local.compte}"

  tags = { Name = "${local.prefixe}-db" }
}

resource "aws_s3_bucket_ownership_controls" "base" {
  bucket = aws_s3_bucket.base.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "base" {
  bucket = aws_s3_bucket.base.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Le versioning EST la sauvegarde de la base : chaque synchronisation crée une version.
resource "aws_s3_bucket_versioning" "base" {
  bucket = aws_s3_bucket.base.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "base" {
  bucket = aws_s3_bucket.base.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "base" {
  bucket = aws_s3_bucket.base.id

  rule {
    id     = "purge-anciennes-versions-base"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days           = var.db_backup_retention_days
      newer_noncurrent_versions = 30 # on garde toujours les 30 dernières versions
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }

  depends_on = [aws_s3_bucket_versioning.base]
}

# --- Justificatifs de paiement (servis via CloudFront) ---
resource "aws_s3_bucket" "televersements" {
  bucket = "${local.prefixe}-uploads-${local.compte}"

  tags = { Name = "${local.prefixe}-uploads" }
}

resource "aws_s3_bucket_ownership_controls" "televersements" {
  bucket = aws_s3_bucket.televersements.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "televersements" {
  bucket = aws_s3_bucket.televersements.id

  block_public_acls       = true
  block_public_policy     = false # la policy CloudFront (OAC) doit rester applicable
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_versioning" "televersements" {
  bucket = aws_s3_bucket.televersements.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "televersements" {
  bucket = aws_s3_bucket.televersements.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "televersements" {
  bucket = aws_s3_bucket.televersements.id

  rule {
    id     = "archivage-justificatifs"
    status = "Enabled"

    filter {
      prefix = "cotisations/"
    }

    transition {
      days          = var.uploads_transition_ia_days
      storage_class = "STANDARD_IA"
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 3
    }
  }
}

# Accès en lecture réservé à la distribution CloudFront (Origin Access Control).
data "aws_iam_policy_document" "televersements_cloudfront" {
  statement {
    sid    = "AutoriserLectureCloudFront"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.televersements.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.medias.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "televersements" {
  bucket = aws_s3_bucket.televersements.id
  policy = data.aws_iam_policy_document.televersements_cloudfront.json

  depends_on = [aws_s3_bucket_public_access_block.televersements]
}

# --- Journaux d'accès ALB (optionnels) ---
resource "aws_s3_bucket" "journaux" {
  count = local.logs_alb_actifs ? 1 : 0

  bucket        = "${local.prefixe}-alb-logs-${local.compte}"
  force_destroy = true

  tags = { Name = "${local.prefixe}-alb-logs" }
}

resource "aws_s3_bucket_public_access_block" "journaux" {
  count = local.logs_alb_actifs ? 1 : 0

  bucket = aws_s3_bucket.journaux[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "journaux" {
  count = local.logs_alb_actifs ? 1 : 0

  bucket = aws_s3_bucket.journaux[0].id

  rule {
    id     = "purge-journaux"
    status = "Enabled"

    filter {}

    expiration {
      days = var.alb_logs_retention_days
    }
  }
}

data "aws_iam_policy_document" "journaux" {
  count = local.logs_alb_actifs ? 1 : 0

  statement {
    sid    = "AutoriserEcritureELB"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.comptes_logs_elb[var.aws_region]}:root"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.journaux[0].arn}/alb/AWSLogs/${local.compte}/*"]
  }
}

resource "aws_s3_bucket_policy" "journaux" {
  count = local.logs_alb_actifs ? 1 : 0

  bucket = aws_s3_bucket.journaux[0].id
  policy = data.aws_iam_policy_document.journaux[0].json
}

###############################################################################
# Certificats ACM — API (régional) et CDN (us-east-1 pour CloudFront)
#
# Validation DNS : les enregistrements sont exposés en sortie Terraform puis
# créés chez Cloudflare par scripts/cloudflare-dns.sh (cf. docs/DEPLOYMENT.md).
###############################################################################

resource "aws_acm_certificate" "api" {
  domain_name       = local.api_fqdn
  validation_method = "DNS"

  tags = { Name = "${local.prefixe}-cert-api" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "api" {
  certificate_arn         = aws_acm_certificate.api.arn
  validation_record_fqdns = [for enr in aws_acm_certificate.api.domain_validation_options : enr.resource_record_name]

  timeouts {
    create = var.certificate_validation_timeout
  }
}

resource "aws_acm_certificate" "cdn" {
  provider = aws.us_east_1

  domain_name       = local.cdn_fqdn
  validation_method = "DNS"

  tags = { Name = "${local.prefixe}-cert-cdn" }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "cdn" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.cdn.arn
  validation_record_fqdns = [for enr in aws_acm_certificate.cdn.domain_validation_options : enr.resource_record_name]

  timeouts {
    create = var.certificate_validation_timeout
  }
}

###############################################################################
# Load balancer applicatif
###############################################################################

resource "aws_lb" "principal" {
  name               = "${local.prefixe}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.publics[*].id

  idle_timeout               = 65
  enable_http2               = true
  drop_invalid_header_fields = true
  enable_deletion_protection = var.enable_deletion_protection

  dynamic "access_logs" {
    for_each = local.logs_alb_actifs ? [1] : []

    content {
      bucket  = aws_s3_bucket.journaux[0].id
      prefix  = "alb"
      enabled = true
    }
  }

  tags = { Name = "${local.prefixe}-alb" }

  depends_on = [aws_s3_bucket_policy.journaux]
}

resource "aws_lb_target_group" "api" {
  name        = "${local.prefixe}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.principal.id

  deregistration_delay = 20

  health_check {
    enabled             = true
    path                = "/api/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.prefixe}-tg" }
}

# Tout le trafic clair est redirigé vers HTTPS : l'API n'est jamais servie en HTTP.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.principal.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = var.alb_ssl_policy
  certificate_arn   = aws_acm_certificate_validation.api.certificate_arn

  # Action par défaut = refus : seules les requêtes portant le bon en-tête Host
  # (règle ci-dessous) atteignent l'application. Les scans visant directement
  # le nom DNS de l'ALB n'obtiennent rien d'exploitable.
  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "application/json"
      message_body = "{\"error\":\"Requete non autorisee\"}"
      status_code  = "403"
    }
  }
}

# Le domaine public est le seul Host accepté.
resource "aws_lb_listener_rule" "host_attendu" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = [local.api_fqdn]
    }
  }
}

###############################################################################
# Registre d'images ECR
###############################################################################

resource "aws_ecr_repository" "backend" {
  name                 = "${local.prefixe}-backend"
  image_tag_mutability = "MUTABLE"
  force_delete         = !var.enable_deletion_protection

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = { Name = "${local.prefixe}-backend" }
}

resource "aws_ecr_lifecycle_policy" "backend" {
  repository = aws_ecr_repository.backend.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Conserver les ${var.ecr_images_to_keep} dernieres images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.ecr_images_to_keep
        }
        action = { type = "expire" }
      }
    ]
  })
}

###############################################################################
# Secret applicatif — mot de passe administrateur (jamais en dur)
###############################################################################

resource "random_password" "admin" {
  length           = 24
  special          = true
  override_special = "!#$%&*+-=?"
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${local.prefixe}/admin-password"
  description             = "Mot de passe administrateur du backend Sante des extremes"
  recovery_window_in_days = var.secret_recovery_window_days

  tags = { Name = "${local.prefixe}-admin-password" }
}

resource "aws_secretsmanager_secret_version" "admin" {
  secret_id     = aws_secretsmanager_secret.admin.id
  secret_string = random_password.admin.result

  # La valeur est ensuite pilotée hors Terraform (rotation manuelle) : on ne
  # la réécrit pas à chaque apply et elle ne transite jamais par le dépôt.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

###############################################################################
# Rôles IAM des tâches ECS
###############################################################################

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# --- Rôle d'exécution : tirer l'image, écrire les logs, lire le secret ---
resource "aws_iam_role" "execution" {
  name               = "${local.prefixe}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = { Name = "${local.prefixe}-ecs-execution" }
}

resource "aws_iam_role_policy_attachment" "execution_base" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "LireSecretAdmin"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.admin.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${local.prefixe}-execution-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# --- Rôle de tâche : accès S3 (base + justificatifs) et ECS Exec ---
resource "aws_iam_role" "tache" {
  name               = "${local.prefixe}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json

  tags = { Name = "${local.prefixe}-ecs-task" }
}

data "aws_iam_policy_document" "tache" {
  statement {
    sid    = "SynchroniserBaseSqlite"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:DeleteObject",
    ]

    resources = ["${aws_s3_bucket.base.arn}/*"]
  }

  statement {
    sid       = "ListerBucketBase"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.base.arn]
  }

  statement {
    sid       = "DeposerJustificatifs"
    effect    = "Allow"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.televersements.arn}/cotisations/*"]
  }

  statement {
    sid       = "ListerBucketJustificatifs"
    effect    = "Allow"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.televersements.arn]
  }

  # Session shell de diagnostic (aws ecs execute-command)
  statement {
    sid    = "SessionsEcsExec"
    effect = "Allow"

    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]

    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "tache" {
  name   = "${local.prefixe}-task-policy"
  role   = aws_iam_role.tache.id
  policy = data.aws_iam_policy_document.tache.json
}

###############################################################################
# Cluster, définition de tâche et service ECS Fargate
###############################################################################

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${local.prefixe}-backend"
  retention_in_days = var.log_retention_days

  tags = { Name = "${local.prefixe}-backend-logs" }
}

resource "aws_ecs_cluster" "principal" {
  name = "${local.prefixe}-cluster"

  setting {
    name  = "containerInsights"
    value = var.enable_container_insights ? "enabled" : "disabled"
  }

  tags = { Name = "${local.prefixe}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "principal" {
  cluster_name       = aws_ecs_cluster.principal.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

resource "aws_ecs_task_definition" "backend" {
  family                   = "${local.prefixe}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.tache.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([
    {
      name      = "backend"
      image     = "${aws_ecr_repository.backend.repository_url}:${var.image_tag}"
      essential = true

      portMappings = [
        {
          name          = "http"
          containerPort = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.container_port) },
        { name = "DB_PATH", value = "/app/data/sde.db" },
        { name = "AWS_REGION", value = var.aws_region },

        # Justificatifs de paiement
        { name = "AWS_BUCKET", value = aws_s3_bucket.televersements.id },
        { name = "S3_MAX_FILE_SIZE", value = tostring(var.upload_max_file_size) },
        { name = "PUBLIC_MEDIA_BASE_URL", value = "https://${local.cdn_fqdn}" },

        # Persistance de la base SQLite sur S3
        { name = "S3_DB_BUCKET", value = aws_s3_bucket.base.id },
        { name = "S3_DB_KEY", value = var.db_object_key },
        { name = "DB_SYNC_INTERVAL_SECONDS", value = tostring(var.db_sync_interval_seconds) },

        # Origines autorisées côté navigateur (tableau public)
        { name = "CORS_ORIGINS", value = join(",", var.cors_allowed_origins) },
      ]

      secrets = [
        {
          name      = "ADMIN_PASSWORD"
          valueFrom = aws_secretsmanager_secret.admin.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "backend"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get({host:'127.0.0.1',port:${var.container_port},path:'/api/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      # SIGTERM doit atteindre l'entrypoint pour déclencher la sauvegarde finale.
      stopTimeout = 60
      linuxParameters = {
        initProcessEnabled = true
      }
    }
  ])

  tags = { Name = "${local.prefixe}-backend" }
}

# ATTENTION : desired_count reste à 1 et le déploiement remplace la tâche en
# « stop-then-start ». SQLite n'admet qu'un seul écrivain, deux tâches
# simultanées provoqueraient une perte d'écritures lors de la synchro S3.
resource "aws_ecs_service" "backend" {
  name            = "${local.prefixe}-backend"
  cluster         = aws_ecs_cluster.principal.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  enable_execute_command = var.enable_ecs_exec
  propagate_tags         = "SERVICE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = 60
  wait_for_steady_state              = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.publics[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true # pas de NAT Gateway : l'IP publique sert à joindre ECR
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "backend"
    container_port   = var.container_port
  }

  # L'image déployée est pilotée par la CI ; Terraform ne la ramène pas en arrière.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy.tache,
  ]
}

###############################################################################
# CloudFront — diffusion des justificatifs (bucket privé + OAC)
###############################################################################

resource "aws_cloudfront_origin_access_control" "televersements" {
  name                              = "${local.prefixe}-uploads-oac"
  description                       = "Acces CloudFront au bucket des justificatifs"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "medias" {
  enabled         = true
  comment         = "${local.prefixe} — justificatifs de cotisation"
  price_class     = var.cloudfront_price_class
  http_version    = "http2and3"
  is_ipv6_enabled = true

  aliases = [local.cdn_fqdn]

  origin {
    origin_id                = "s3-televersements"
    domain_name              = aws_s3_bucket.televersements.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.televersements.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-televersements"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Politique managée « CachingOptimized »
    cache_policy_id = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.cdn.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  tags = { Name = "${local.prefixe}-cdn" }
}

###############################################################################
# CI/CD — fournisseur OIDC GitHub et rôle de déploiement (aucune clé statique)
###############################################################################

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]

  tags = { Name = "${local.prefixe}-github-oidc" }
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    # one() renvoie null quand le fournisseur n'est pas créé par ce module :
    # on retombe alors sur l'ARN du fournisseur OIDC déjà présent dans le compte.
    principals {
      type = "Federated"
      identifiers = [
        coalesce(
          one(aws_iam_openid_connect_provider.github[*].arn),
          "arn:aws:iam::${local.compte}:oidc-provider/token.actions.githubusercontent.com"
        )
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Seules les références listées (branche / environnement) peuvent déployer.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [for reference in var.github_allowed_refs : "repo:${var.github_repository}:${reference}"]
    }
  }
}

resource "aws_iam_role" "deploiement_github" {
  name                 = "${local.prefixe}-github-deploy"
  description          = "Role assume par GitHub Actions pour construire et deployer le backend"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600

  tags = { Name = "${local.prefixe}-github-deploy" }
}

data "aws_iam_policy_document" "deploiement_github" {
  statement {
    sid       = "JetonEcr"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "PousserImage"
    effect = "Allow"

    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]

    resources = [aws_ecr_repository.backend.arn]
  }

  statement {
    sid    = "DeployerService"
    effect = "Allow"

    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:DescribeTasks",
      "ecs:ListTasks",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
    ]

    resources = ["*"]
  }

  statement {
    sid       = "TransmettreRolesDeTache"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.tache.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploiement_github" {
  name   = "${local.prefixe}-github-deploy"
  role   = aws_iam_role.deploiement_github.id
  policy = data.aws_iam_policy_document.deploiement_github.json
}

###############################################################################
# Supervision — alarmes essentielles
###############################################################################

resource "aws_cloudwatch_metric_alarm" "cibles_indisponibles" {
  alarm_name          = "${local.prefixe}-aucune-cible-saine"
  alarm_description   = "Aucune tache backend saine derriere l'ALB"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    LoadBalancer = aws_lb.principal.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }

  tags = { Name = "${local.prefixe}-aucune-cible-saine" }
}

resource "aws_cloudwatch_metric_alarm" "erreurs_5xx" {
  alarm_name          = "${local.prefixe}-erreurs-5xx"
  alarm_description   = "Taux d'erreurs 5xx applicatives anormal"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.principal.arn_suffix
  }

  tags = { Name = "${local.prefixe}-erreurs-5xx" }
}

###############################################################################
# Sorties — consommées par scripts/deploy.sh, scripts/cloudflare-dns.sh et la CI
###############################################################################

output "api_url" {
  description = "URL publique de l'API (a configurer dans l'application mobile)"
  value       = "https://${local.api_fqdn}/api"
}

output "cdn_url" {
  description = "URL publique de diffusion des justificatifs"
  value       = "https://${local.cdn_fqdn}"
}

output "alb_dns_name" {
  description = "Nom DNS de l'ALB — cible du CNAME sde-api chez Cloudflare"
  value       = aws_lb.principal.dns_name
}

output "alb_zone_id" {
  description = "Zone hebergee de l'ALB (utile pour un alias Route 53)"
  value       = aws_lb.principal.zone_id
}

output "cloudfront_domain_name" {
  description = "Domaine CloudFront — cible du CNAME sde-cdn chez Cloudflare"
  value       = aws_cloudfront_distribution.medias.domain_name
}

output "cloudfront_distribution_id" {
  description = "Identifiant de distribution (invalidation de cache)"
  value       = aws_cloudfront_distribution.medias.id
}

output "ecr_repository_url" {
  description = "Depot ECR du backend"
  value       = aws_ecr_repository.backend.repository_url
}

output "ecs_cluster_name" {
  description = "Nom du cluster ECS"
  value       = aws_ecs_cluster.principal.name
}

output "ecs_service_name" {
  description = "Nom du service ECS"
  value       = aws_ecs_service.backend.name
}

output "ecs_task_family" {
  description = "Famille de definition de tache"
  value       = aws_ecs_task_definition.backend.family
}

output "db_bucket" {
  description = "Bucket S3 hebergeant la base SQLite"
  value       = aws_s3_bucket.base.id
}

output "uploads_bucket" {
  description = "Bucket S3 des justificatifs de paiement"
  value       = aws_s3_bucket.televersements.id
}

output "admin_password_secret_arn" {
  description = "ARN du secret contenant le mot de passe admin (valeur jamais exposee)"
  value       = aws_secretsmanager_secret.admin.arn
}

output "github_deploy_role_arn" {
  description = "Role a renseigner dans le secret GitHub AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.deploiement_github.arn
}

output "log_group_name" {
  description = "Groupe de journaux CloudWatch du backend"
  value       = aws_cloudwatch_log_group.backend.name
}

# Enregistrements CNAME de validation ACM, consommés par scripts/cloudflare-dns.sh
output "certificate_validation_records" {
  description = "Enregistrements DNS a creer chez Cloudflare pour valider les certificats"
  value = concat(
    [
      for enr in aws_acm_certificate.api.domain_validation_options : {
        name  = enr.resource_record_name
        type  = enr.resource_record_type
        value = enr.resource_record_value
        usage = "acm-api"
      }
    ],
    [
      for enr in aws_acm_certificate.cdn.domain_validation_options : {
        name  = enr.resource_record_name
        type  = enr.resource_record_type
        value = enr.resource_record_value
        usage = "acm-cdn"
      }
    ]
  )
}

# Enregistrements applicatifs (crées par scripts/cloudflare-dns.sh apply)
output "dns_records" {
  description = "CNAME publics a creer chez Cloudflare (mode DNS only)"
  value = [
    {
      name    = local.api_fqdn
      type    = "CNAME"
      value   = aws_lb.principal.dns_name
      proxied = false
    },
    {
      name    = local.cdn_fqdn
      type    = "CNAME"
      value   = aws_cloudfront_distribution.medias.domain_name
      proxied = false
    },
  ]
}
