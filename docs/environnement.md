# Variables d’environnement

Dans les tableaux, `{{ENV_PREFIX}}` vaut `WHITECODE_` pour l’identité WhiteCode. Par exemple, `WHITECODE_CONFIG_HOME` désigne le dossier de configuration utilisateur. Les variables liées à un service ou à une option de compilation dépendent de la distribution installée.

| Variable | Effet |
|---|---|
| `{{ENV_PREFIX}}CONFIG_HOME` | Remplace `{{CONFIG_DIR}}` |
| `{{ENV_PREFIX}}PROVIDER` | Fournisseur d’API (`openai_compatible`, `openai`, `anthropic` ou `bedrock`) |
| `{{ENV_PREFIX}}MODEL_DEFAULT`, `{{ENV_PREFIX}}MODEL_BACKGROUND` | Gammes par défaut |
| `{{ENV_PREFIX}}SERVICE_<NOM>` | Surcharge d'une URL de service |
| `{{ENV_PREFIX}}RESPONSE_TOKEN_LIMIT` | Limite de jetons de sortie par réponse |
| `{{ENV_PREFIX}}REQUEST_TIMEOUT` | Délai d'une requête au fournisseur |
| `{{ENV_PREFIX}}DEBUG`, `{{ENV_PREFIX}}DEBUG_FILE` | Journal de débogage |
| `{{ENV_PREFIX}}NO_TELEMETRY` | Désactive la télémétrie |
| `{{ENV_PREFIX}}NO_ERROR_REPORTS` | Désactive la remontée d'erreurs |
| `{{ENV_PREFIX}}NO_AUTO_UPDATES` | Désactive la mise à jour automatique |
| `{{ENV_PREFIX}}OFFLINE_MINIMAL` | Coupe tout trafic non essentiel (télémétrie, options dynamiques, catalogues, mises à jour) |
| `{{ENV_PREFIX}}MINIMAL` | Équivalent au mode minimal |
| `{{ENV_PREFIX}}SHELL_INIT_FILE` | Script sourcé avant chaque commande shell |
| `{{ENV_PREFIX}}CHILD_PROCESS` | Positionnée à `1` par le produit pour les processus qu'il lance |
| `{{ENV_PREFIX}}EXTRA_CA_CERTS` | Certificats d'autorité supplémentaires |
| `{{ENV_PREFIX}}TLS_CLIENT_CERT`, `{{ENV_PREFIX}}TLS_CLIENT_KEY` | Authentification TLS mutuelle |
| `{{ENV_PREFIX}}DISABLE_STATE_CAPTURE` | Désactive la capture d'état par tour (profil interne) |
| `{{ENV_PREFIX}}FEATURE_OVERRIDES` | Surcharge d'options dynamiques (profil interne ou build de développement) |
| `{{ENV_PREFIX}}PLAN_CHECK_TOOL` | Active l'outil de vérification d'exécution de plan (profil interne) |
| `{{ENV_PREFIX}}PROMPT_HINTS` | Active ou désactive les suggestions de message |
| `{{ENV_PREFIX}}JOB_WORKSPACE` | Dossier d'un travail lancé à partir d'un modèle ; active la classification des fins de tour |
| `{{ENV_PREFIX}}PERSISTENT_MEMORY_DIR` | Emplacement persistant de la mémoire d'agent de portée locale en environnement distant |
| `{{ENV_PREFIX}}NO_SURVEYS` | Désactive les enquêtes de satisfaction |
| `{{ENV_PREFIX}}HIDE_DIAGNOSTIC` | Masque la commande de diagnostic |
| `{{ENV_PREFIX}}HIDE_SIGN_OUT` | Masque la commande de déconnexion |
| `{{ENV_PREFIX}}NO_EDITOR_EXTENSION_INSTALL` | Empêche l'installation automatique de l'extension IDE |
| `{{ENV_PREFIX}}TELEMETRY` | Active l'export OpenTelemetry vers l'infrastructure de l'organisation |
| `{{ENV_PREFIX}}DETAILED_TELEMETRY` | Active la télémétrie enrichie (bêta) |
| `{{ENV_PREFIX}}TELEMETRY_INCLUDE_CONTENT` | Autorise le contenu dans les traces enrichies |
| `{{ENV_PREFIX}}ORCHESTRATOR_ROLE` | Étiquette de type de collaboration ajoutée à la télémétrie |
| `{{ENV_PREFIX}}PERF_TRACE` | Active le traçage de performance (chemin ou `1`) |
| `{{ENV_PREFIX}}PROFILE` | Phases profilées (`startup`, `query`, `headless`, `all`) |
| `{{ENV_PREFIX}}SLOW_OP_WARN_MS` | Seuil des opérations lentes |
| `{{ENV_PREFIX}}SESSION_RECORDING` | Enregistrement asciicast de l'affichage (`1` ou chemin) |
| `{{ENV_PREFIX}}API_RECORDING`, `{{ENV_PREFIX}}API_RECORDING_DIR` | Enregistrement et rejeu des échanges avec le fournisseur |
| `{{ENV_PREFIX}}STREAM_PROFILE` | Sélectionne le profil de flux (`standard` ou `compact`) (équivalent à `ui.streamProfile`, sans contourner une valeur gérée) |
| `{{ENV_PREFIX}}SESSION_MIRROR` | Active le miroir de session distante |
| `{{ENV_PREFIX}}SERVER_TOKEN` | Jeton d'accès pour la connexion directe à un serveur |
| `{{ENV_PREFIX}}EXPERIMENT_BASELINE` | Active le mode de référence d'expérimentation |

## Variables des fournisseurs et du système

| Variable | Effet |
|---|---|
| `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` | Configuration du fournisseur Anthropic |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID` | Configuration du fournisseur OpenAI ou compatible |
| `AWS_REGION`, `AWS_PROFILE`, identifiants AWS standard | Fournisseur Bedrock |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (et minuscules) | Proxy réseau |
| `NO_COLOR`, `FORCE_COLOR`, `TERM`, `COLORTERM` | Rendu terminal |
| `EDITOR`, `VISUAL` | Éditeur externe |
| `OTEL_*` (`OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_EXPORTER_OTLP_*`, `{{ENV_PREFIX}}TELEMETRY_INCLUDE_PROMPTS`…) | Configuration de l'export OpenTelemetry |
| `XDG_CONFIG_HOME` | Emplacement de configuration |

## Priorité
Variable d'environnement > paramètre de fichier (hors portée `managed`) > défaut. Une variable ne peut jamais contourner un paramètre géré.
