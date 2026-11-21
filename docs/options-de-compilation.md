# Options de compilation

Le paramètre `--build-options` accepte un fichier JSON qui associe les noms ci-dessous à `true` ou `false`. Par exemple, `{"permission_auto_approve": false}` désactive l’approbation automatique dans le binaire produit. Le fichier `dist/build-options.json` indique les valeurs effectives pour la cible et le profil choisis.

| Option | Domaine | Fonctionnalité pilotée |
|---|---|---|
| `mode_assistant_persistent` | Modes | Mode assistant persistant |
| `mode_self_initiated` | Modes | Mode autonome proactif |
| `mode_brief` | Modes | Mode messages courts |
| `mode_orchestrator` | Modes | Mode coordinateur |
| `mode_resident_service` | Modes | Service résident |
| `mode_background_sessions` | Modes | Sessions d'arrière-plan |
| `mode_template_jobs` | Modes | Travaux à partir de modèles |
| `mode_experiment_baseline` | Modes | Mode de référence d'expérimentation |
| `remote_control` | Distance | Contrôle à distance |
| `remote_auto_connect` | Distance | Connexion automatique distante |
| `session_mirroring` | Distance | Miroir de session distante |
| `remote_environment_setup` | Distance | Configuration de l'environnement distant |
| `remote_direct_connect` | Distance | Connexion directe |
| `session_via_ssh` | Distance | Session distante SSH |
| `remote_self_hosted_runner` | Distance | Exécuteur auto-hébergé |
| `remote_provided_environment` | Distance | Exécuteur d'environnement fourni |
| `remote_deep_plan` | Distance | Planification approfondie distante |
| `inbound_channels` | Connecteurs | Canaux de notification entrante |
| `connector_published_skills` | Connecteurs | Compétences fournies par connecteur |
| `connector_structured_display` | Connecteurs | Sortie enrichie de connecteur |
| `connector_text_summary` | Connecteurs | Résumé des contenus de connecteur |
| `computer_control` | Intégrations | Pilotage de l'ordinateur |
| `browser_embedded` | Intégrations | Navigateur intégré |
| `ui_embedded_terminal` | Intégrations | Panneau terminal |
| `local_session_messaging` | Intégrations | Messagerie inter-sessions locale |
| `merge_request_subscriptions` | Intégrations | Abonnement aux événements de demande de fusion |
| `contribution_attribution` | Intégrations | Attribution des contributions |
| `deep_links` | Intégrations | Liens profonds |
| `user_file_delivery` | Communication | Envoi de fichier à l'utilisateur |
| `push_notifications` | Communication | Notifications poussées |
| `scheduled_triggers` | Planification | Déclencheurs planifiés locaux |
| `scheduled_triggers_remote` | Planification | Déclencheurs planifiés distants |
| `automation_scripts` | Planification | Flux de travail scriptés |
| `process_monitor` | Outils | Surveillance de processus |
| `output_review` | Outils | Revue de livrable |
| `context_overflow_probe` | Outils | Outil de test de débordement de sortie |
| `history_pruning` | Contexte | Élagage d'historique |
| `context_folding` | Contexte | Repli de contexte |
| `compaction_cache_edit` | Contexte | Micro-compaction avec cache |
| `compaction_on_overflow` | Contexte | Compaction réactive |
| `context_compaction_notices` | Contexte | Rappels de compaction |
| `context_token_target` | Contexte | Budget de jetons |
| `cache_miss_diagnostics` | Contexte | Détection de rupture de cache |
| `return_summary` | Contexte | Résumé de retour |
| `engine_speculation` | Moteur | Exécution spéculative |
| `thinking_max_keyword` | Contexte | Réflexion maximale par mot-clé |
| `memory_auto_extraction` | Mémoire | Extraction automatique de mémoire |
| `memory_team_shared` | Mémoire | Mémoire d'équipe partagée |
| `memory_consolidation` | Mémoire | Consolidation de mémoire (en mode assistant) |
| `memory_initial_state` | Mémoire | Instantané de mémoire d'agent |
| `memory_living_docs` | Mémoire | Documentation vivante automatique |
| `skill_discovery` | Extensions | Découverte de compétences |
| `skill_generator` | Extensions | Générateur de compétences |
| `skill_refinement` | Extensions | Amélioration de compétences |
| `skill_ai_app_building` | Extensions | Compétence d'aide au développement d'applications d'IA |
| `agent_forked` | Agents | Sous-agent bifurqué |
| `agent_verifier` | Agents | Agent de vérification intégré |
| `agent_explorer_planner` | Agents | Agents intégrés d'exploration et de planification |
| `permission_auto_approve` | Sécurité | Mode d'approbation automatique (classifieur d'approbation) |
| `permission_auto_approve_powershell` | Sécurité | Prise en charge de PowerShell par le classifieur d'approbation |
| `shell_classifier` | Sécurité | Classifieur de commandes shell |
| `sandbox_commands` | Sécurité | Bac à sable des commandes |
| `shell_syntax_analysis` | Sécurité | Analyse syntaxique shell |
| `shell_syntax_analysis_shadow` | Sécurité | Analyse syntaxique shell en mode fantôme |
| `hook_questions` | Crochets | Question posée par crochet |
| `ui_fast_find` | Interface | Recherche rapide dans la zone de saisie |
| `ui_history_browser` | Interface | Sélecteur d'historique |
| `ui_message_menu` | Interface | Actions sur les messages |
| `ui_native_clipboard_image` | Interface | Collage d'image depuis le presse-papiers natif |
| `ui_auto_theme` | Interface | Thème automatique suivant le système |
| `ui_companion` | Interface | Compagnon animé |
| `ui_year_in_review` | Interface | Rétrospective annuelle |
| `ui_merch` | Interface | Boutique d'articles promotionnels |
| `ui_attempt_stats` | Interface | Statistiques de tentatives |
| `ui_dictation` | Voix | Mode vocal |
| `settings_sync_upload` | Configuration | Synchronisation des paramètres (envoi) |
| `settings_sync_download` | Configuration | Synchronisation des paramètres (récupération) |
| `project_init_v2` | Commandes | Initialisation de projet, deuxième version |
| `cache_reset_command` | Commandes | Commande de réinitialisation du cache (profil interne) |
| `explain_context_command` | Commandes | Commande d'explication du contexte d'une réponse |
| `output_file_persistence` | Sessions | Persistance des fichiers produits |
| `api_background_retry` | API | Relance sans surveillance |
| `telemetry_enhanced` | Observabilité | Télémétrie enrichie |
| `telemetry_memory_metrics` | Observabilité | Télémétrie de forme de la mémoire |
| `telemetry_orchestrator_role` | Observabilité | Télémétrie par type de collaboration |
| `performance_tracing` | Observabilité | Traçage de performance |
| `diagnostics_slow_ops` | Observabilité | Journalisation des opérations lentes |
| `strict_failure` | Observabilité | Échec strict |
| `stream_compact_profile` | Observabilité | Sortie épurée en mode non interactif |
| `system_instructions_export` | Observabilité | Export des instructions système |
| `update_prerelease_channel` | Installation | Autorisation des versions de test |
| `telemetry_otel_export` | Observabilité | Export OpenTelemetry vers l'infrastructure de l'organisation |
| `telemetry_trace_export` | Observabilité | Export des traces de session OpenTelemetry |
| `diagnostics_profiling` | Observabilité | Profilage du démarrage, des requêtes et du mode non interactif |
| `diagnostics_debug_log` | Observabilité | Journal de débogage |
| `diagnostics_terminal_recording` | Observabilité | Enregistrement de session terminal |
| `diagnostics_api_replay` | Observabilité | Enregistrement et rejeu d'API |
| `planning_progress_check` | Outils | Vérification de l'exécution d'un plan approuvé |
| `tools_terminal_session` | Outils | Terminal persistant piloté |
| `tools_code_runtime` | Outils | Environnement d'exécution interactif par script |
| `context_file_listing` | Commandes | Liste des fichiers présents dans le contexte |
| `hosted_agent_management` | Commandes | Consultation, publication et suivi des définitions d’agents hébergés |
| `merge_request_fix` | Commandes | Correction des échecs et commentaires d’une demande de fusion |
| `session_metadata_backfill` | Sessions | Complément et réindexation des métadonnées des sessions existantes |
| `diagnostics_context_inspection` | Observabilité | Inspection détaillée de la prochaine requête sans envoi |
| `diagnostics_tool_call_inspection` | Observabilité | Inspection d’un appel d’outil enregistré |
| `diagnostics_environment_inspection` | Observabilité | Affichage masqué des variables reconnues et de leur effet |
| `session_handoff` | Sessions | Commande de transfert et envoi interne de session avec état Git |
| `feedback_issue_report` | Communication | Préparation et publication relue d’un ticket d’anomalie produit |
| `onboarding_restart` | Commandes | Relance interne du parcours d’accueil en conservant les réglages |
| `diagnostics_performance_report` | Observabilité | Capture et transmission relue d’un rapport de performance |
| `feedback_positive_report` | Communication | Signalement d’un échange positif avec pièce jointe consentie |
| `remote_failure_injection` | Distance | Injection locale d’une défaillance de contrôle à distance |
| `session_publish` | Sessions | Publication confirmée d’une transcription avec lien d’accès |
| `session_summary` | Sessions | Résumé annexe affiché sans modifier le contexte |
| `diagnostics_session_version` | Observabilité | Commande interne affichant la version du processus de session |
| `remote_task_suggestions` | Outils | Proposition consentie d’une tâche distante annexe |
| `permission_test` | Outils | Outil sans effet éprouvant le circuit de permission en test |
| `skill_filler_text` | Extensions | Génération locale de texte de remplissage pour le test |
| `skill_session_rescue` | Extensions | Diagnostic des sessions bloquées et transmission proposée |
| `ui_frustration_detection` | Interface | Détection interne de formulations négatives et proposition de partage |
| `ui_dev_bar` | Interface | Barre des opérations lentes des constructions internes ou de développement |
| `ui_internal_notices` | Interface | Mode discret et indications d’état réservés au profil interne |
| `config_feature_overrides` | Configuration | Surcharges locales d’options dynamiques pour le test interne ou de développement |
| `state_capture` | Sessions | Capture et téléversement internes de l’état Git par tour |
| `model_fast_output` | API | Activation du débit de sortie accru d’un modèle éligible |
| `model_advisor` | API | Consultation d'un modèle conseiller et commande de choix associée |
| `engine_tool_summaries` | Moteur | Résumés de lots d’outils demandés par l’hôte du kit |
| `engine_control_channel` | Moteur | Canal de contrôle négocié du kit d’intégration |
| `browser_user_control` | Intégrations | Pilotage du navigateur de l’utilisateur par extension et connecteur |
| `storage_encryption` | Sessions | Chiffrement local des magasins de contenus et accès autorisé |
| `diagnostics_build_inventory` | Observabilité | Vue interne de l’inventaire des options dans /status, sans conditionner sa génération obligatoire |
| `libc_variant_musl` / `libc_variant_glibc` | Build | Variante de bibliothèque C cible |
