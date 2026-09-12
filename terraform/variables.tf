###############################################################################
# Santé des extrêmes — LOT 2 : variables d'infrastructure
#
# Aucune valeur sensible ici : le mot de passe admin est généré puis stocké
# dans AWS Secrets Manager, et la CI s'authentifie par OIDC.
# Surcharger au besoin dans terraform/terraform.tfvars (non versionné).
###############################################################################

# --- Identité du projet ------------------------------------------------------

variable "project_name" {
  description = "Préfixe court utilisé pour nommer toutes les ressources"
  type        = string
  default     = "sde"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.project_name))
    error_message = "project_name : minuscules, chiffres et tirets, 2 à 16 caractères."
  }
}

variable "environment" {
  description = "Environnement déployé (prod, staging…)"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging", "dev"], var.environment)
    error_message = "environment doit valoir prod, staging ou dev."
  }
}

variable "aws_region" {
  description = "Région AWS de déploiement (Paris par défaut, la plus proche du Cameroun avec Fargate)"
  type        = string
  default     = "eu-west-3"
}

variable "extra_tags" {
  description = "Étiquettes additionnelles appliquées à toutes les ressources"
  type        = map(string)
  default     = {}
}

# --- Domaines ----------------------------------------------------------------

variable "domain_name" {
  description = "Domaine racine géré chez Cloudflare"
  type        = string
  default     = "atlastech.cm"
}

variable "api_subdomain" {
  description = "Sous-domaine de l'API (CNAME vers l'ALB)"
  type        = string
  default     = "sde-api"
}

variable "cdn_subdomain" {
  description = "Sous-domaine de diffusion des justificatifs (CNAME vers CloudFront)"
  type        = string
  default     = "sde-cdn"
}

variable "certificate_validation_timeout" {
  description = "Délai maximal d'attente de la validation DNS des certificats ACM"
  type        = string
  default     = "45m"
}

variable "alb_ssl_policy" {
  description = "Politique TLS du listener HTTPS de l'ALB"
  type        = string
  default     = "ELBSecurityPolicy-TLS13-1-2-2021-06"
}

# --- Réseau ------------------------------------------------------------------

variable "vpc_cidr" {
  description = "Plage d'adresses du VPC"
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr doit être un CIDR IPv4 valide (ex. 10.20.0.0/16)."
  }
}

variable "allowed_ingress_cidrs" {
  description = "Plages autorisées à joindre l'ALB (restreindre pour un environnement privé)"
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "cors_allowed_origins" {
  description = "Origines navigateur autorisées par le backend (tableau public web)"
  type        = list(string)
  default     = ["*"]
}

# --- Conteneur et service ECS ------------------------------------------------

variable "container_port" {
  description = "Port d'écoute du backend Express dans le conteneur"
  type        = number
  default     = 3000
}

variable "image_tag" {
  description = "Étiquette d'image ECR déployée au premier apply (la CI prend ensuite le relais avec le SHA du commit)"
  type        = string
  default     = "latest"
}

variable "ecr_images_to_keep" {
  description = "Nombre d'images conservées dans le dépôt ECR (les plus anciennes expirent)"
  type        = number
  default     = 10

  validation {
    condition     = var.ecr_images_to_keep >= 2
    error_message = "ecr_images_to_keep doit valoir au moins 2 pour permettre un retour arrière."
  }
}

variable "task_cpu" {
  description = "Unités de CPU Fargate (256 = 0,25 vCPU)"
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.task_cpu)
    error_message = "task_cpu doit valoir 256, 512, 1024, 2048 ou 4096."
  }
}

variable "task_memory" {
  description = "Mémoire de la tâche Fargate en Mio (doit être compatible avec task_cpu)"
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "Architecture du processeur Fargate (ARM64 = ~20 % moins cher)"
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture doit valoir X86_64 ou ARM64."
  }
}

variable "enable_ecs_exec" {
  description = "Autoriser aws ecs execute-command (shell de diagnostic dans la tâche)"
  type        = bool
  default     = true
}

variable "enable_container_insights" {
  description = "Activer Container Insights sur le cluster (métriques détaillées, facturées)"
  type        = bool
  default     = false
}

# --- Persistance SQLite sur S3 ----------------------------------------------

variable "db_object_key" {
  description = "Clé S3 du fichier SQLite persisté"
  type        = string
  default     = "sqlite/sde.db"
}

variable "db_sync_interval_seconds" {
  description = "Période de sauvegarde de la base vers S3 (une sauvegarde a aussi lieu à l'arrêt de la tâche)"
  type        = number
  default     = 300

  validation {
    condition     = var.db_sync_interval_seconds >= 30 && var.db_sync_interval_seconds <= 3600
    error_message = "db_sync_interval_seconds doit être compris entre 30 et 3600."
  }
}

variable "db_backup_retention_days" {
  description = "Durée de conservation des versions antérieures de la base (jours)"
  type        = number
  default     = 90
}

# --- Justificatifs de paiement ----------------------------------------------

variable "upload_max_file_size" {
  description = "Taille maximale d'un justificatif en octets"
  type        = number
  default     = 5242880
}

variable "uploads_transition_ia_days" {
  description = "Âge (jours) à partir duquel les justificatifs passent en Standard-IA"
  type        = number
  default     = 90
}

variable "cloudfront_price_class" {
  description = "Classe de prix CloudFront (PriceClass_100 = Europe + Amérique du Nord)"
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.cloudfront_price_class)
    error_message = "cloudfront_price_class doit valoir PriceClass_100, PriceClass_200 ou PriceClass_All."
  }
}

# --- Journalisation et supervision ------------------------------------------

variable "log_retention_days" {
  description = "Rétention des journaux applicatifs CloudWatch (jours)"
  type        = number
  default     = 30
}

variable "enable_alb_access_logs" {
  description = "Écrire les journaux d'accès de l'ALB dans un bucket S3 dédié"
  type        = bool
  default     = false
}

variable "alb_logs_retention_days" {
  description = "Rétention des journaux d'accès ALB (jours)"
  type        = number
  default     = 30
}

# --- Intégration continue GitHub --------------------------------------------

variable "github_repository" {
  description = "Dépôt autorisé à déployer, au format proprietaire/depot"
  type        = string
  default     = "Wadebe/sante-extremes"

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository doit être au format proprietaire/depot."
  }
}

variable "github_allowed_refs" {
  description = "Références GitHub autorisées à assumer le rôle de déploiement"
  type        = list(string)
  default     = ["ref:refs/heads/master", "ref:refs/heads/main", "environment:production"]
}

variable "create_github_oidc_provider" {
  description = "Créer le fournisseur OIDC GitHub (mettre à false s'il existe déjà dans le compte)"
  type        = bool
  default     = true
}

# --- Garde-fous --------------------------------------------------------------

variable "enable_deletion_protection" {
  description = "Protéger l'ALB contre la suppression et conserver les images ECR au destroy"
  type        = bool
  default     = true
}

variable "secret_recovery_window_days" {
  description = "Fenêtre de récupération d'un secret supprimé (0 = suppression immédiate)"
  type        = number
  default     = 7
}
