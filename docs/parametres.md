### 6.1 Catalogue complet

| Clé | Type | Défaut | Portées | Fiche propriétaire |
|---|---|---|---|---|
| `agents.allowProjectAgents` | Booléen | Vrai | U G | SPEC-AGT-005 |
| `agents.defaultModel` | Alias | Hérité | U P | SPEC-OUT-016 |
| `agents.disabledBuiltIns` | Liste | Vide | U G | SPEC-AGT-002 |
| `agents.loadProjectInstructions` | Booléen | Vrai | U | SPEC-AGT-001 |
| `agents.maxDepth` | Entier | 2 | U G | SPEC-OUT-016 (aussi : SPEC-AGT-001) |
| `agents.maxParallel` | Entier | 10 | U G | SPEC-OUT-016 (aussi : SPEC-MOD-028) |
| `agents.messaging.crossSession` | Booléen | Faux | U G | SPEC-OUT-017 (aussi : SPEC-OUT-018, SPEC-INT-016) |
| `agents.messaging.maxBytes` | Entier | 64 Kio | U | SPEC-OUT-017 |
| `agents.progressSummaryIntervalSeconds` | Entier | 45 | U | SPEC-AGT-025 |
| `agents.teams.displayBackend` | Énuméré (`auto`, `multiplexer`, `split-terminal`, `in-process`) | `auto` | U | SPEC-AGT-012 |
| `agents.teams.enabled` | Booléen | Vrai | U G | SPEC-OUT-019 (aussi : SPEC-AGT-011) |
| `agents.teams.maxMembers` | Entier | 8 | U G | SPEC-OUT-019 |
| `agents.teams.orphanTimeoutMinutes` | Entier | 15 | U | SPEC-AGT-015 |
| `agents.teams.permissionTimeoutSeconds` | Entier | 600 | U | SPEC-AGT-014 |
| `agents.teams.shutdownTimeoutSeconds` | Entier | 60 | U | SPEC-AGT-011 |
| `api.maxRetries` | Entier | 8 | U G | SPEC-API-003 (vue par domaine) |
| `api.provider` | Énumération | `anthropic` | U G | SPEC-API-001 (vue par domaine) |
| `api.streamIdleTimeout` | Durée | 90 s | U G | SPEC-API-002 (vue par domaine) |
| `api.unattendedRetry.interval` | Durée | 5 min | U G | SPEC-API-004 (vue par domaine) |
| `api.unattendedRetry.maxWait` | Durée | 6 h | U G | SPEC-API-004 (vue par domaine) |
| `assistant.installDirectory` | Chemin | Dossier personnel | U | SPEC-MOD-026 |
| `attribution.commitTrailer` | Texte | Mention construite avec `{{GIT_COAUTHOR_NAME}}` et `{{GIT_COAUTHOR_EMAIL}}` | U P G | SPEC-INT-010 |
| `attribution.notes` | Booléen | Faux | U P G | SPEC-INT-010 |
| `attribution.pullRequest` | Texte | `{{PR_FOOTER}}` | U P G | SPEC-INT-010 |
| `auth.cloudCredentialRefresh` | Objet (`aws.refresh`, `aws.export`, `gcp.refresh`) | — | U G | SPEC-API-015 |
| `auth.credentialHelperTtl` | Durée | 5 min | U G | SPEC-API-014 |
| `auth.credentialHelper` | Commande | — | U G | SPEC-API-014 |
| `auth.credentialStore` | Énuméré (`auto`, `keychain`, `file`) | `auto` | U G | SPEC-PER-027 |
| `auth.forceOrganization` | Identifiant | — | G | SPEC-API-012 |
| `auth.loginMethod` | Énumération | — | G | SPEC-API-012 |
| `browser.enabled` | Booléen | Faux | U | SPEC-INT-011 |
| `commands.allowProjectCommands` | Booléen | Vrai | U P G | SPEC-CMD-001 |
| `commands.confirmDestructive` | Booléen | Vrai | U G | SPEC-CMD-001 |
| `commands.disabled` | Liste de noms | Vide | U P G | SPEC-CMD-001 |
| `commands.maxNestingDepth` | Entier | 3 | U | SPEC-CMD-001 |
| `config.confirmDestructive` | Booléen | Vrai | U G | SPEC-MOD-012 |
| `config.defaultScope` | Énuméré | `utilisateur` | U | SPEC-MOD-012 |
| `config.featureFlagsRefreshInterval` | Durée | 1 h | G | SPEC-CFG-014 (vue par domaine) |
| `config.migrationBackupRetention` | Entier (jours) | 30 | U G | SPEC-CFG-009 (vue par domaine) |
| `config.reloadDebounce` | Durée | 400 ms | U | SPEC-CFG-005 (vue par domaine) |
| `config.toolAllowlist` | Liste | Liste fournie | G | SPEC-OUT-039 |
| `context.allowCustomSystemInstructions` | Booléen | Vrai | G | SPEC-MOT-004 (vue par domaine) |
| `context.attachments.maxTokens` | Entier | 12 000 | U G | SPEC-MOT-006 |
| `context.attachments.maxTotalTokens` | Entier | 60 000 | U G | SPEC-MOT-006 |
| `context.autoCompact.enabled` | Booléen | Vrai | U | SPEC-MOT-012 |
| `context.autoCompact.maxFailures` | Entier | 3 | U | SPEC-MOT-012 |
| `context.autoCompact.triggerRatio` | Nombre | 0,90 | U | SPEC-MOT-012 |
| `context.autoCompact.urgentRatio` | Nombre | 0,88 | U | SPEC-MOT-012 |
| `context.autoCompact.warnRatio` | Nombre | 0,80 | U | SPEC-MOT-012 |
| `context.cachedMicroCompact.keepRecent` | Entier | 10 | U | SPEC-MOT-015 |
| `context.cachedMicroCompact.minAgeMinutes` | Entier | 10 | U | SPEC-MOT-015 |
| `context.cachedMicroCompact.triggerRatio` | Nombre | 0,5 | U | SPEC-MOT-015 |
| `context.compaction.restoreFiles` | Entier | 5 | U | SPEC-MOT-011 |
| `context.compaction.restoreTokens` | Entier | 40 000 | U | SPEC-MOT-011 |
| `context.folding.commitRatio` | Nombre | 0,85 | U | SPEC-MOT-020 |
| `context.folding.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-020 |
| `context.folding.maxExpandTokens` | Entier | 4 000 | U | SPEC-OUT-044 |
| `context.folding.prepareRatio` | Nombre | 0,6 | U | SPEC-MOT-020 |
| `context.gitGuidance.enabled` | Booléen | Vrai | U P G | SPEC-MOT-003 (aussi : SPEC-INT-017) |
| `context.gitStatus.enabled` | Booléen | Vrai | U P G | SPEC-MOT-003 (aussi : SPEC-INT-017) |
| `context.ideContext` | Booléen | Vrai | U | SPEC-MOT-006 (aussi : SPEC-INT-003) |
| `context.instructions.excludes` | Liste | Vide | U P L G | SPEC-MOT-005 |
| `context.instructions.fileWarnSize` | Taille | 40 Ko | U | SPEC-MOT-005 |
| `context.instructions.includeDepth` | Entier | 4 | U G | SPEC-MOT-005 |
| `context.instructions.loadFromAdditionalDirs` | Booléen | Faux | U | SPEC-PER-011 |
| `context.microCompact.enabled` | Booléen | Vrai | U | SPEC-MOT-013 |
| `context.microCompact.idleMinutes` | Entier | 60 | U | SPEC-MOT-013 |
| `context.microCompact.keepRecent` | Entier | 8 | U | SPEC-MOT-013 |
| `context.microCompact.triggerRatio` | Nombre | 0,6 | U | SPEC-MOT-013 |
| `context.promptFamily` | Énuméré (`auto`, `generic` ou famille du catalogue) | `auto` | U G | SPEC-MOT-045 |
| `context.providerContextManagement.enabled` | Booléen | Vrai | U G | SPEC-MOT-014 |
| `context.providerContextManagement.targetTokens` | Entier | 50 000 | U | SPEC-MOT-014 |
| `context.pruning.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-019 |
| `context.pruning.nudgeEveryTokens` | Entier | 15 000 | U | SPEC-MOT-019 |
| `context.reactiveCompact.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-016 |
| `context.reminders.compaction` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-018 |
| `context.reminders.maxTokens` | Entier | 2 000 | G | SPEC-MOT-007 |
| `context.reminders.todoInterval` | Entier (itérations) | 8 | U | SPEC-OUT-021 (aussi : SPEC-MOT-007) |
| `context.sessionMemoryCompact.keepRecentMessages` | Entier | 6 | U | SPEC-MOT-017 |
| `context.sessionMemoryCompact.keepRecentTokens` | Entier | 12 000 | U | SPEC-MOT-017 |
| `context.systemInstructionsBudget` | Entier | 20 000 | U G | SPEC-MOT-003 |
| `context.tokenBudget.completionRatio` | Nombre | 0,9 | U | SPEC-MOT-022 |
| `context.tokenBudget.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-022 |
| `cost.priceOverrides` | Objet | — | U G | SPEC-OBS-021 |
| `daemon.installAsService` | Booléen | Faux | U | SPEC-MOD-021 |
| `daemon.workers` | Liste | Selon les fonctions activées | U | SPEC-MOD-021 |
| `debug.diagnosticLogs.retentionDays` | Entier | 7 | U | SPEC-OBS-020 |
| `debug.retentionDays` | Entier | 30 | U | SPEC-OBS-012 |
| `deepLinks.registration` | `enabled` / `disabled` | `enabled` | U G | SPEC-MOD-030 |
| `engine.autonomous.maxWait` | Durée | 1 h | U | SPEC-OUT-023 |
| `engine.autonomous.tickInterval` | Durée | 5 min | U | SPEC-OUT-023 |
| `engine.cacheBreakDetection.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-034 |
| `engine.cacheBreakDetection.maxTrackedThreads` | Entier | 20 | U | SPEC-MOT-034 |
| `engine.cancelGracePeriod` | Durée | 3 s | U G | SPEC-MOT-002 |
| `engine.control.allowEscalation` | Booléen | Faux | U G (jamais P ni L) | SPEC-MOD-006 |
| `engine.control.enabled` | Booléen | Faux | U P | SPEC-MOD-006 |
| `engine.control.maxInFlight` | Entier | 32 | U | SPEC-MOD-006 |
| `engine.control.responseTimeoutMs` | Entier | 120 000 | U P | SPEC-MOD-006 |
| `engine.control.toolSummaries` | Booléen | Faux | Hôte (négocié) | SPEC-MOT-031 |
| `engine.limits.maxCost` | Montant décimal (devise de référence, § 5.5) | — | U P G | SPEC-MOD-005 |
| `engine.limits.maxDurationSeconds` | Entier | — | U P G | SPEC-MOD-005 |
| `engine.limits.maxIterations` | Entier | 50 | U P G | SPEC-MOD-005 |
| `engine.limits.warnRatio` | Nombre | 0,8 | U | SPEC-MOD-005 |
| `engine.loopGuard.enabled` | Booléen | Vrai | U G | SPEC-MOT-046 |
| `engine.loopGuard.threshold` | Entier | 3 | U G | SPEC-MOT-046 |
| `engine.maxOutputContinuations` | Entier | 3 | U P G | SPEC-MOT-001 |
| `engine.maxQueuedMessages` | Entier | 20 | U | SPEC-MOT-008 (vue par domaine) |
| `engine.maxStopHookContinuations` | Entier | 5 | U P G | SPEC-MOT-001 |
| `engine.nonInteractive.defaultPermissionMode` | Mode | `no_prompt` | U P¹ L¹ G | SPEC-MOD-002 |
| `engine.nonInteractive.persistSession` | Booléen | Vrai | U P | SPEC-MOD-002 |
| `engine.nonInteractive.progressToStderr` | Booléen | Faux | U | SPEC-MOD-002 |
| `engine.output.format` | Énuméré | `texte` | U P | SPEC-MOD-003 |
| `engine.output.includeThinking` | Booléen | Faux | U P | SPEC-MOD-003 |
| `engine.output.maxEventSize` | Entier (octets) | 1 048 576 | U | SPEC-MOD-003 |
| `engine.output.schemaMaxDepth` | Entier | 12 | U | SPEC-MOD-004 |
| `engine.output.schemaRetries` | Entier | 2 | U P | SPEC-MOD-004 |
| `engine.output.schemaStrictExtraction` | Booléen | Faux | U P | SPEC-MOD-004 |
| `engine.outputReserveTokens` | Entier | 16 000 | G | SPEC-MOT-010 |
| `engine.speculation.enabled` | Booléen | Faux | U G | SPEC-MOT-029 |
| `engine.startup.connectorTimeoutMs` | Entier | 10 000 | U P | SPEC-MOD-010 |
| `engine.startup.deferredMaintenance` | Booléen | Vrai | U | SPEC-MOD-010 |
| `engine.startup.extensionTimeoutMs` | Entier | 3 000 | U P | SPEC-MOD-010 |
| `engine.startup.verboseLog` | Booléen | Faux | U | SPEC-MOD-010 |
| `engine.toolConcurrency` | Entier | 8 | U P G | SPEC-MOT-002 |
| `engine.toolTimeout` | Durée | 30 min | U P G | SPEC-MOT-002 |
| `engine.unknownModelContextWindow` | Entier | 128 000 | G | SPEC-MOT-010 |
| `environment.variables` | Objet nom → valeur | — | U G | SPEC-CFG-007 |
| `extensions.allowFlagged` | Liste | — | G | SPEC-EXT-010 (vue par domaine) |
| `extensions.allowPrerelease` | Booléen | faux | U G | SPEC-EXT-006 (vue par domaine) |
| `extensions.archiveMaxSize` | Taille | 500 Mo | U G | SPEC-EXT-018 (vue par domaine) |
| `extensions.autoInstallProjectExtensions` | Booléen | Faux | U G | SPEC-EXT-003 (vue par domaine) |
| `extensions.autoUpdate` | Énumération | `notify` | U G | SPEC-EXT-006 (vue par domaine) |
| `extensions.blockedCatalogs` | Liste | — | G | SPEC-EXT-009 (vue par domaine) |
| `extensions.blocked` | Liste | — | G | SPEC-EXT-009 (vue par domaine) |
| `extensions.catalogs` | Objet | — | U P L G | SPEC-EXT-002 (vue par domaine) |
| `extensions.enabled` | Objet | — | U P L G | SPEC-EXT-002 (vue par domaine) |
| `extensions.lspRecommendationThreshold` | Entier | 5 | U G | SPEC-EXT-018 (vue par domaine) |
| `extensions.managedOnly` | Booléen | Faux | G | SPEC-EXT-009 (vue par domaine) |
| `extensions.options` | Objet | — | U P L G | SPEC-EXT-002 (vue par domaine) |
| `extensions.recommendations` | Booléen | vrai | U G | SPEC-EXT-003 (vue par domaine) |
| `extensions.strictCatalogs` | Liste | — | G | SPEC-EXT-009 (vue par domaine) |
| `extensions.trustMessage` | Texte | — | G | SPEC-EXT-009 (vue par domaine) |
| `extensions.updateInterval` | Durée | 24 h | U G | SPEC-EXT-006 (vue par domaine) |
| `git.mergeRequestStatus.enabled` | Booléen | Vrai | U | SPEC-INT-008 |
| `git.mergeRequestStatus.refreshSeconds` | Entier | 60 | U | SPEC-INT-008 |
| `hooksConfig.asyncKillOnExit` | Booléen | faux | U G | SPEC-HOK-007 (vue par domaine) |
| `hooksConfig.commandTimeout` | Durée | 60 s | U G | SPEC-HOK-001 (vue par domaine) |
| `hooksConfig.disabled` | Booléen | Faux | U L G | SPEC-HOK-012 (vue par domaine) |
| `hooksConfig.fileWatch.burstLimit` | Entier | 200 | U | SPEC-HOK-013 (vue par domaine) |
| `hooksConfig.fileWatch.debounce` | Durée | 300 ms | U | SPEC-HOK-013 (vue par domaine) |
| `hooksConfig.http.allowedEnvVars` | Liste | — | U G | SPEC-HOK-004 (vue par domaine) |
| `hooksConfig.http.allowedUrls` | Liste | — | U G | SPEC-HOK-004 (vue par domaine) |
| `hooksConfig.http.timeout` | Durée | 10 s | U G | SPEC-HOK-001 (vue par domaine) |
| `hooksConfig.managedOnly` | Booléen | Faux | G | SPEC-HOK-012 (vue par domaine) |
| `hooksConfig.maxAsync` | Entier | 8 | U G | SPEC-HOK-007 (vue par domaine) |
| `hooksConfig.outputMaxSize` | Taille | 64 Ko | U G | SPEC-HOK-001 (vue par domaine) |
| `hooksConfig.payloadMaxSize` | Taille | 256 Ko | U G | SPEC-HOK-001 (vue par domaine) |
| `hooksConfig.questionMaxRounds` | Entier | 3 | U G | SPEC-HOK-007 (vue par domaine) |
| `hooks` | Objet événement → liste | — | U P L G | SPEC-HOK-002 (vue par domaine) |
| `ide.autoConnect` | Booléen | Faux | U | SPEC-INT-001 |
| `ide.autoInstallExtension` | Booléen | Vrai | U G | SPEC-INT-005 |
| `ide.diagnostics.enabled` | Booléen | Vrai | U | SPEC-INT-004 |
| `ide.diagnostics.maxItems` | Entier | 30 | U | SPEC-INT-004 |
| `ide.diagnostics.timeoutMs` | Entier | 2000 | U | SPEC-INT-004 |
| `ide.selection.maxLines` | Entier | 2000 | U | SPEC-INT-003 |
| `ide.showDiffs` | Booléen | Vrai | U | SPEC-INT-002 |
| `integrations.computerControl.deniedApps` | Liste | Catégories sensibles | G | SPEC-INT-015 |
| `integrations.computerControl.enabled` | Booléen | Faux | U G | SPEC-INT-015 |
| `integrations.keepAwake` | Booléen | Vrai | U | SPEC-INT-022 |
| `integrations.mergeRequests.eventFilter` | Liste | Tous sauf bruit | U | SPEC-OUT-046 |
| `integrations.teamChat.channelSuggestions` | Booléen | Vrai | U | SPEC-INT-014 |
| `jobs.classifierTimeoutSeconds` | Entier | 60 | U | SPEC-MOT-043 |
| `lsp.maxRestarts` | Entier | 3 | U | SPEC-INT-006 |
| `lsp.passiveDiagnostics` | Booléen | Vrai | U | SPEC-INT-006 |
| `lsp.servers` | Objet | — | U P | SPEC-INT-006 |
| `maintenance.keepVersions` | Entier | 2 | U | SPEC-INS-007 |
| `mcp.accountConnectors` | Booléen | Vrai | U G | SPEC-MCP-017 (vue par domaine) |
| `mcp.allowList` | Liste | — | G | SPEC-MCP-021 (vue par domaine) |
| `mcp.authTimeout` | Durée | 5 min | U | SPEC-OUT-029 |
| `mcp.channelRateLimit` | Entier (messages par minute) | 30 | U G | SPEC-MCP-013 (vue par domaine) |
| `mcp.connectTimeout` | Durée | 30 s | U G | SPEC-MCP-002 (vue par domaine) |
| `mcp.connectorText.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-035 |
| `mcp.denyList` | Liste | — | G | SPEC-MCP-021 (vue par domaine) |
| `mcp.disabledProjectServers` | Liste | — | U L | SPEC-PER-019 (vue par domaine) |
| `mcp.eagerToolsThreshold` | Entier | 15 | U G | SPEC-MCP-009 (vue par domaine) |
| `mcp.enableProjectServers` | Booléen | Faux | U | SPEC-PER-019 (vue par domaine) |
| `mcp.enabledProjectServers` | Liste | — | U | SPEC-PER-019 (vue par domaine) |
| `mcp.headersCommandTimeout` | Durée | 10 s | U G | SPEC-MCP-008 |
| `mcp.headersCommandTtl` | Durée | 15 min | U G | SPEC-MCP-008 |
| `mcp.identityProvider` | Objet | — | G | SPEC-MCP-007 (vue par domaine) |
| `mcp.inboundChannels` | Liste | — | U G | SPEC-MCP-013 (vue par domaine) |
| `mcp.managedServersOnly` | Booléen | Faux | G | SPEC-MCP-021 (vue par domaine) |
| `mcp.maxOutputTokens` | Entier | 25 000 | U G | SPEC-OUT-027 (aussi : SPEC-OUT-028) |
| `mcp.maxParallelConnects` | Entier | 10 | U G | SPEC-MCP-022 (vue par domaine) |
| `mcp.maxReconnects` | Entier | 6 | U G | SPEC-MCP-022 (vue par domaine) |
| `mcp.outputInlineLimit` | Entier | 20 000 | U G | SPEC-MCP-009 (vue par domaine) |
| `mcp.projectServers.autoApprove` | Booléen | Faux | U | SPEC-PER-019 |
| `mcp.richOutputMaxLines` | Entier | 40 | U G | SPEC-MCP-015 (vue par domaine) |
| `mcp.sdkToolTimeout` | Durée | 5 min | U G | SPEC-MCP-002 (vue par domaine) |
| `mcp.serve.capabilities` | Liste | Lecture + `run_agent` | U P | SPEC-MOD-008 |
| `mcp.serve.maxAgentDepth` | Entier | 2 | U | SPEC-MOD-008 |
| `mcp.serve.maxConcurrency` | Entier | 4 | U | SPEC-MOD-008 |
| `mcp.serve.rootDirectory` | Chemin | Dossier courant | U G | SPEC-MOD-008 |
| `mcp.skillsFromServers` | Liste | — | U G | SPEC-MCP-014 (vue par domaine) |
| `mcp.toolDescriptionMax` | Entier | 2 000 | U G | SPEC-MCP-009 (vue par domaine) |
| `mcp.toolTimeout` | Durée | 10 min | U G | SPEC-OUT-027 |
| `mcp.wsPingInterval` | Durée | 30 s | U G | SPEC-MCP-002 (vue par domaine) |
| `memory.assistant.dailyLog` | Booléen | Vrai en mode assistant | U | SPEC-MOT-042 |
| `memory.autoExtraction.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-038 |
| `memory.autoExtraction.exitWaitSeconds` | Entier | 45 | U | SPEC-MOT-038 |
| `memory.automatic.enabled` | Booléen | Vrai | U G | SPEC-MOT-036 |
| `memory.consolidation.minHours` | Entier | 48 | U | SPEC-MOT-039 |
| `memory.consolidation.minSessions` | Entier | 4 | U | SPEC-MOT-039 |
| `memory.consolidationEnabled` | Booléen | Vrai | U | SPEC-MOT-039 |
| `memory.directory` | Chemin | — | U | SPEC-MOT-036 |
| `memory.indexMaxBytes` | Entier | 20 480 | U | SPEC-MOT-036 |
| `memory.indexMaxLines` | Entier | 150 | U | SPEC-MOT-036 |
| `memory.livingDocs.enabled` | Booléen | Faux | U P | SPEC-MOT-032 |
| `memory.livingDocs.everyTurns` | Entier | 10 | U | SPEC-MOT-032 |
| `memory.livingDocs.header` | Texte | `{{LIVING_DOC_HEADER}}` | P | SPEC-MOT-032 |
| `memory.recall.enabled` | Booléen | Vrai | U | SPEC-MOT-037 |
| `memory.recall.maxItems` | Entier | 4 | U | SPEC-MOT-037 |
| `memory.recall.staleAfterDays` | Entier | 30 | U | SPEC-MOT-037 |
| `memory.session.enabled` | Booléen | Vrai | U | SPEC-MOT-040 |
| `memory.session.updateEveryTokens` | Entier | 8 000 | U | SPEC-MOT-040 |
| `memory.session.updateEveryToolCalls` | Entier | 4 | U | SPEC-MOT-040 |
| `memory.team.enabled` | Booléen | Vrai si l'option est construite | U G | SPEC-MOT-041 |
| `models.advisor` | Nom | — | U G | SPEC-MOT-027 |
| `models.allowList` | Liste | Toutes les gammes | U G | SPEC-API-007 (vue par domaine) |
| `models.effort` | Énuméré (`low`, `medium`, `high`) | `high` | U P | SPEC-MOT-025 |
| `models.fallbackAfterOverloads` | Entier | 3 | U G | SPEC-API-005 (vue par domaine) |
| `models.fallbackCooldown` | Durée | 10 min | U G | SPEC-API-005 (vue par domaine) |
| `models.fallback` | Nom | Modèle intermédiaire | U P G | SPEC-MOD-005 |
| `models.fastOutput.enabled` | Booléen | Faux | U | SPEC-MOT-026 |
| `models.identifierMap` | Objet gamme → identifiant | — | U G | SPEC-API-007 (vue par domaine) |
| `models.selected` | Texte | `{{MODEL_DEFAULT}}` | U P G C | SPEC-MOT-001 |
| `modes.brief` | Booléen | Faux | U | SPEC-MOD-029 |
| `modes.coordinator` | Booléen | Faux | U P | SPEC-MOD-028 |
| `modes.proactive.intervalMinutes` | Entier | 30 | U | SPEC-MOD-027 |
| `notifications.channel` | auto / terminal / système / sonnerie / désactivé | auto | U | SPEC-INT-020 |
| `notifications.minTurnSeconds` | Entier | 30 | U | SPEC-INT-020 |
| `notifications.mobile` | Booléen | Vrai | U | SPEC-INT-013 |
| `permissions.allowRules` | Liste de règles | Vide | U P L G C | SPEC-PER-001 |
| `permissions.askRules` | Liste de règles | Vide | U P L G C | SPEC-PER-001 |
| `permissions.autoApprove.allow` | Liste de consignes | Valeurs fournies | U G | SPEC-PER-004 |
| `permissions.autoApprove.block` | Liste de consignes | Valeurs fournies | U G | SPEC-PER-004 |
| `permissions.autoApprove.environment` | Liste de consignes | Vide | U G | SPEC-PER-004 |
| `permissions.autoApprove.orgConsent` | Booléen | Faux | G | SPEC-PER-018 |
| `permissions.decisionHooks` | Liste d'identités qualifiées (portée, emplacement du fichier de déclaration, identifiant, empreinte de la déclaration) | Vide | U G (jamais P ni L) | SPEC-PER-001 |
| `permissions.delegateTimeoutMs` | Entier | 60 000 | U | SPEC-PER-028 |
| `permissions.denials.maxConsecutive` | Entier | 4 | U G | SPEC-PER-014 |
| `permissions.denials.maxTotal` | Entier | 25 | U G | SPEC-PER-014 |
| `permissions.denyRules` | Liste de règles | Vide | U P L G C | SPEC-PER-001 |
| `permissions.detachedWaitTimeout` | Durée | 30 min | U G | SPEC-PER-001 |
| `permissions.disableAutoApproveMode` | Booléen | Faux | G | SPEC-PER-003 (aussi : SPEC-PER-004) |
| `permissions.disableUnrestrictedMode` | Booléen | Faux | G | SPEC-PER-003 (aussi : SPEC-PER-017) |
| `permissions.explainer.enabled` | Booléen | Vrai | U G | SPEC-PER-013 |
| `permissions.extraDirectories` | Liste de chemins | Vide | U G | SPEC-PER-011 |
| `permissions.initialMode` | Mode | `ask` | U P¹ L¹ G | SPEC-PER-003 (aussi : SPEC-PER-001) |
| `permissions.managedRulesOnly` | Booléen | Faux | G | SPEC-PER-001 |
| `permissions.protectedPaths` | Liste de motifs | Liste fournie | G | SPEC-PER-010 |
| `permissions.shell.maxParseComplexity` | Entier | 500 nœuds | G | SPEC-PER-007 |
| `permissions.trustedDirectories` | Liste de motifs | Vide | G | SPEC-PER-016 |
| `planning.defaultResumeMode` | Mode | `ask` | U | SPEC-OUT-024 |
| `planning.directory` | Chemin | Dossier de session | U G | SPEC-OUT-024 |
| `policy.refreshIntervalMinutes` | Entier | 60 | G | SPEC-PER-020 |
| `policy.requiredKeys` | Liste de clés | Vide | G | SPEC-CFG-003 |
| `remote.capacity` | Entier | 1 | U | SPEC-MOD-013 |
| `remote.controlAtStartup` | Booléen | Selon SPEC-MOD-016 | U | SPEC-MOD-013 (aussi : SPEC-MOD-016) |
| `remote.defaultEnvironment` | Texte | — | U | SPEC-MOD-014 |
| `remote.runner.concurrency` | Entier | 1 | U | SPEC-MOD-024 |
| `remote.runner.labels` | Liste | Détectées | U | SPEC-MOD-024 |
| `remote.sshHosts` | Liste | — | U | SPEC-MOD-020 |
| `remote.suggestions.maxPerSession` | Entier | 2 | U | SPEC-OUT-047 |
| `remote.transport.allowPlaintextLoopback` | Booléen | Vrai | U | SPEC-MOD-007 |
| `remote.transport.allowedOrigins` | Liste | Vide | U G | SPEC-MOD-007 |
| `remote.transport.keepAliveSeconds` | Entier | 30 | U | SPEC-MOD-007 |
| `remote.transport.listenAddress` | Adresse | Bouclage local | U G | SPEC-MOD-007 (aussi : SPEC-MOD-019) |
| `remote.transport.maxFrameBytes` | Entier | 4 194 304 | U | SPEC-MOD-007 |
| `remote.transport.resumeWindowSeconds` | Entier | 120 | U | SPEC-MOD-007 |
| `remote.triggers.enabled` | Booléen | Vrai si l'option est construite | U G | SPEC-OUT-032 |
| `sandbox.allowUnsandboxedCommands` | Booléen | Vrai | G | SPEC-PER-015 |
| `sandbox.autoAllowSandboxed` | Booléen | Vrai | U G | SPEC-PER-015 |
| `sandbox.enabled` | Booléen | Faux | U P G | SPEC-PER-015 |
| `sandbox.excludedCommands` | Liste | Vide | U G | SPEC-PER-015 |
| `sandbox.network.allowedDomains` | Liste | Vide | U G | SPEC-PER-015 |
| `schedule.enabled` | Booléen | Vrai | U G | SPEC-PLA-001 |
| `schedule.maxActive` | Entier | 50 | U G | SPEC-OUT-031 |
| `schedule.maxAgeDays` | Entier | 7 | U | SPEC-OUT-031 (aussi : SPEC-PLA-001) |
| `sessions.assistant.segmentArchive` | Booléen | Vrai en mode assistant | U | SPEC-MOT-042 |
| `sessions.background.maxConcurrent` | Entier | 4 | U | SPEC-MOD-022 |
| `sessions.background.taskSummaryEveryTurns` | Entier | 5 | U | SPEC-MOT-044 |
| `sessions.outputFiles.maxCount` | Entier | 200 | C G | SPEC-SES-013 (vue par domaine) |
| `sessions.outputFiles.maxSize` | Taille | 50 Mo | C G | SPEC-SES-013 (vue par domaine) |
| `sessions.pasteInlineThreshold` | Entier | 4 000 | U G | SPEC-SES-017 (vue par domaine) |
| `sessions.pasteMaxSize` | Taille | 20 Mo | U G | SPEC-SES-017 (vue par domaine) |
| `sessions.presenceTimeout` | Durée | 60 s | G | SPEC-SES-011 (vue par domaine) |
| `sessions.promptHistoryMax` | Entier | 1 000 | U | SPEC-SES-016 (vue par domaine) |
| `sessions.retentionDays` | Entier | 30 | U G | SPEC-CFG-013 (vue par domaine) |
| `sessions.searchCandidates` | Entier | 40 | U | SPEC-SES-010 (vue par domaine) |
| `sessions.snapshotMaxFileSize` | Taille | 5 Mo | U G | SPEC-SES-006 (vue par domaine) |
| `sessions.stateCapture.forgeOrganizations` | Liste | — | G | SPEC-SES-014 (vue par domaine) |
| `sessions.stateCapture.maxFileSize` | Taille | 1 Mo | G | SPEC-SES-014 (vue par domaine) |
| `settingsSync.autoUpload` | Booléen | Faux | U | SPEC-CFG-006 (vue par domaine) |
| `settingsSync.include` | Liste | paramètres | U | SPEC-CFG-006 (vue par domaine) |
| `skills.aiApiGuide.enabled` | Booléen | Vrai si l'option est construite | U G | SPEC-EXT-034 |
| `skills.batch.maxAgents` | Entier | 20 | U G | SPEC-EXT-021 |
| `skills.defectScan.agentTimeout` | Durée | 5 min | U G | SPEC-EXT-036 |
| `skills.defectScan.fleetSize` | Entier (1 à 16) | 4 | U G | SPEC-EXT-036 |
| `skills.defectScan.maxDuration` | Durée (au plus 60 min) | 15 min | U G | SPEC-EXT-036 |
| `skills.discovery.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-OUT-038 |
| `skills.discovery.perTurn` | Entier | 5 | U | SPEC-OUT-038 |
| `skills.discovery.remote` | Booléen | Faux | U G | SPEC-EXT-038 |
| `skills.improvement.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-EXT-039 |
| `skills.improvement.everyTurns` | Entier | 6 | U | SPEC-EXT-039 |
| `skills.listingBudgetRatio` | Nombre | 0,01 | U | SPEC-OUT-037 |
| `skills.maxDepth` | Entier | 3 | U G | SPEC-EXT-019 (vue par domaine) |
| `skills.maxDescriptionChars` | Entier | 250 | U | SPEC-OUT-037 |
| `skills.maxDescriptionsTokens` | Entier | 4 000 | U G | SPEC-EXT-019 (vue par domaine) |
| `skills.usage.halfLifeDays` | Entier | 7 | U | SPEC-EXT-040 |
| `storage.encryption.enabled` | Booléen | Faux | U G (jamais P ni L) | SPEC-SES-001 |
| `tasks.keepFinishedMinutes` | Entier | 10 | U | SPEC-AGT-016 |
| `tasks.maxOutputBytes` | Entier | 100 Mo | U | SPEC-AGT-016 |
| `tasks.outputTailBytes` | Entier | 32 Kio | U | SPEC-OUT-020 |
| `tasks.showList` | Booléen | Vrai | U | SPEC-OUT-020 |
| `telemetry.enabled` | Booléen | Vrai | U G | SPEC-OBS-001 |
| `telemetry.headersCommand` | Commande | — | U G | SPEC-OBS-002 |
| `telemetry.organizationMetrics` | Booléen | Vrai (si éligible) | G | SPEC-OBS-003 |
| `telemetry.otel.includeSessionId` | Booléen | Vrai | U G | SPEC-OBS-002 |
| `thinking.budgetTokens` | Entier | 16 000 | U | SPEC-MOT-023 |
| `thinking.enabled` | Booléen | Vrai | U | SPEC-MOT-023 |
| `thinking.maxKeyword` | Texte | `deepthink` | U | SPEC-MOT-024 |
| `thinking.mode` | Énuméré | `adaptatif` | U | SPEC-MOT-023 |
| `thinking.summaries.visible` | Booléen | Faux | U | SPEC-MOT-023 |
| `tools.browser.allowDownloads` | Booléen | Faux | G | SPEC-OUT-014 |
| `tools.browser.allowLocalhost` | Booléen | Vrai | U G | SPEC-OUT-014 |
| `tools.browser.allowedDomains` | Liste | Vide | U G | SPEC-OUT-014 |
| `tools.captureTerminal.maxLines` | Entier | 2 000 | U | SPEC-OUT-015 |
| `tools.deferral.mode` | Énuméré (`auto`, `toujours`, `jamais`) | `auto` | U G | SPEC-OUT-030 |
| `tools.deferral.thresholdRatio` | Nombre | 0,1 | U | SPEC-OUT-030 |
| `tools.edit.diagnosticsMaxOtherFiles` | Entier | 5 | U G | SPEC-INT-006 |
| `tools.edit.diagnosticsMaxPerFile` | Entier | 20 | U G | SPEC-INT-006 |
| `tools.edit.diagnosticsWait` | Durée | 3 s | U G | SPEC-INT-006 |
| `tools.edit.lenientMatching` | Booléen | Vrai | U G | SPEC-OUT-004 |
| `tools.edit.minSimilarity` | Nombre | 0,80 | G | SPEC-OUT-004 |
| `tools.fetch.cacheTtl` | Durée | 15 min | U | SPEC-OUT-012 |
| `tools.fetch.maxBytes` | Entier | 10 Mo | G | SPEC-OUT-012 |
| `tools.fetch.preapprovedDomains` | Liste | Liste fournie par la distribution | G | SPEC-OUT-012 |
| `tools.fetch.timeout` | Durée | 30 s | G | SPEC-OUT-012 |
| `tools.find.maxResults` | Entier | 250 | U G | SPEC-OUT-006 |
| `tools.find.timeout` | Durée | 20 s | G | SPEC-OUT-006 |
| `tools.lsp.maxLocations` | Entier | 100 | U | SPEC-OUT-040 |
| `tools.lsp.timeout` | Durée | 30 s | U | SPEC-OUT-040 |
| `tools.monitor.batchWindow` | Durée | 2 s | U | SPEC-OUT-022 |
| `tools.monitor.maxLinesPerMinute` | Entier | 600 | U | SPEC-OUT-022 |
| `tools.powershell.loadProfile` | Booléen | Faux | U | SPEC-OUT-009 |
| `tools.powershell.path` | Chemin | Détection automatique | U G | SPEC-OUT-009 |
| `tools.read.defaultLines` | Entier | 1 500 | U G | SPEC-OUT-002 |
| `tools.read.maxBytesWithoutRange` | Taille | 384 Ko | G | SPEC-OUT-002 |
| `tools.read.maxLineLength` | Entier | 2 500 | G | SPEC-OUT-002 |
| `tools.read.pdfMaxPages` | Entier | 15 | G | SPEC-OUT-002 |
| `tools.respectIgnoreFiles` | Booléen | Vrai | U P | SPEC-OUT-006 |
| `tools.resultInlineLimit` | Entier | 40 000 | U G | SPEC-OUT-001 |
| `tools.scriptMode.enabled` | Booléen | Faux | G | SPEC-OUT-011 |
| `tools.scriptMode.timeout` | Durée | 60 s | U | SPEC-OUT-011 |
| `tools.search.defaultLimit` | Entier | 200 | U G | SPEC-OUT-007 |
| `tools.search.maxLineLength` | Entier | 400 | G | SPEC-OUT-007 |
| `tools.search.timeout` | Durée | 30 s | G | SPEC-OUT-007 |
| `tools.shell.autoBackgroundAfter` | Durée | 2 min | U | SPEC-AGT-017 |
| `tools.shell.defaultTimeout` | Durée | 3 min | U G | SPEC-OUT-008 |
| `tools.shell.default` | Chemin ou nom | Shell de l'utilisateur | U G | SPEC-OUT-008 |
| `tools.shell.maxTimeout` | Durée | 20 min | G | SPEC-OUT-008 |
| `tools.shell.outputLimit` | Entier (caractères) | 24 000 | G | SPEC-OUT-008 |
| `tools.terminalSession.enabled` | Booléen | Faux (profil interne : vrai) | U G | SPEC-OUT-010 |
| `tools.terminalSession.keepOnExit` | Booléen | Faux | U | SPEC-OUT-010 |
| `tools.webSearch.enabled` | Booléen | Vrai | U G | SPEC-OUT-013 |
| `tools.webSearch.maxUsesPerTurn` | Entier | 8 | G | SPEC-OUT-013 |
| `tools.webSearch.provider` | Nom | Service du fournisseur de modèles | G | SPEC-OUT-013 |
| `tools.worktree.copyFiles` | Liste de motifs | Fichiers d'environnement locaux | P | SPEC-OUT-026 |
| `tools.worktree.directory` | Chemin relatif | Dossier du projet réservé | P | SPEC-OUT-026 |
| `tools.write.maxSize` | Taille | 10 Mo | G | SPEC-OUT-003 |
| `ui.activityIndicator.hints` | Objet | — | U P G | SPEC-IHM-022 (vue par domaine) |
| `ui.activityIndicator.phrasesMode` | `remplacer` \ | `ajouter` | U | SPEC-IHM-022 |
| `ui.activityIndicator.phrases` | Liste | Liste fournie | U | SPEC-IHM-022 |
| `ui.announcements` | Liste de textes | — | G | SPEC-CFG-011 (vue par domaine) |
| `ui.attachments.maxCount` | Entier | 20 | U | SPEC-IHM-010 |
| `ui.attachments.maxImagePixels` | Entier | 2 000 000 | U | SPEC-IHM-010 |
| `ui.attachments.maxTotalBytes` | Entier | 20 971 520 | U | SPEC-IHM-010 |
| `ui.clipboard.useOsc52` | auto / toujours / jamais | auto | U | SPEC-INT-018 |
| `ui.colorMode` | Énuméré (`auto`, `aucune`, `16`, `256`, `complet`) | `auto` | U | SPEC-IHM-001 |
| `ui.companion.enabled` | Booléen | Faux | U G (jamais P ni L) | SPEC-IHM-032 |
| `ui.completion.enabled` | Booléen | Vrai | U | SPEC-IHM-009 |
| `ui.completion.fileProvider` | Objet (commande) | — | U | SPEC-IHM-009 (vue par domaine) |
| `ui.completion.fuzzy` | Booléen | Vrai | U | SPEC-IHM-009 |
| `ui.completion.maxFileEntries` | Entier | 20 000 | U | SPEC-IHM-009 |
| `ui.completion.maxVisible` | Entier | 10 | U | SPEC-IHM-009 |
| `ui.completion.timeoutMs` | Entier | 200 | U | SPEC-IHM-009 |
| `ui.diff.contextLines` | Entier | 3 | U P | SPEC-IHM-005 |
| `ui.diff.intralineHighlight` | Booléen | Vrai | U | SPEC-IHM-005 |
| `ui.diff.layout` | Énuméré (`auto`, `cote-a-cote`, `empile`) | `auto` | U | SPEC-IHM-005 |
| `ui.diff.maxDisplayedLines` | Entier | 500 | U | SPEC-IHM-005 |
| `ui.diff.showInvisibleChanges` | Booléen | Vrai | U | SPEC-IHM-005 |
| `ui.drafts.maxStashed` | Entier | 10 | U | SPEC-IHM-011 |
| `ui.exitConfirmation` | Booléen | Vrai | U | SPEC-MOD-001 |
| `ui.exitDoublePressWindow` | Durée | 1,5 s | U | SPEC-MOT-009 |
| `ui.externalEditor` | Commande | `VISUAL` / `EDITOR` | U | SPEC-INT-019 |
| `ui.fileDelivery.maxBytes` | Entier | 50 Mo | U G | SPEC-OUT-035 |
| `ui.footerLine.command` | Commande | — | U | SPEC-IHM-021 |
| `ui.footerLine.padding` | Entier | 0 | U P | SPEC-IHM-021 |
| `ui.footerLine.timeoutMs` | Entier | 1 500 | U | SPEC-IHM-021 |
| `ui.hints.enabled` | Booléen | Vrai | U | SPEC-IHM-023 |
| `ui.history.enabled` | Booléen | Vrai | U G | SPEC-IHM-008 |
| `ui.history.maxEntries` | Entier | 5 000 | U | SPEC-IHM-008 |
| `ui.history.retentionDays` | Entier | 90 | U | SPEC-IHM-008 |
| `ui.history.scope` | Énuméré (`dossier`, `global`) | `dossier` | U | SPEC-IHM-008 |
| `ui.input.editMode` | Énuméré (`standard`, `modal`) | `standard` | U | SPEC-IHM-007 (aussi : SPEC-IHM-013) |
| `ui.input.maxChars` | Entier | 100 000 | U | SPEC-IHM-007 |
| `ui.input.modalCountLimit` | Entier | 999 | U | SPEC-IHM-013 |
| `ui.input.modalStartMode` | Énuméré (`insertion`, `commande`) | `insertion` | U | SPEC-IHM-013 |
| `ui.input.persistDraft` | Booléen | Vrai | U | SPEC-IHM-007 |
| `ui.input.warnChars` | Entier | 20 000 | U | SPEC-IHM-007 |
| `ui.inputMaxHeight` | Entier | 10 | U | SPEC-IHM-002 |
| `ui.inputMinHeight` | Entier | 1 | U | SPEC-IHM-002 |
| `ui.keybindings.bindings` | Association identifiant → combinaison | Vide | U | SPEC-IHM-014 (aussi : SPEC-IHM-041) |
| `ui.keybindings.showFooterHints` | Booléen | Vrai | U | SPEC-IHM-014 |
| `ui.keybindings.strictConflicts` | Booléen | Faux | U | SPEC-IHM-014 |
| `ui.language` | Texte | système | U P L | SPEC-IHM-020 (vue par domaine) |
| `ui.links.editorScheme` | Texte | Automatique | U | SPEC-IHM-035 |
| `ui.maxFramesPerSecond` | Entier | 30 | U | SPEC-IHM-001 |
| `ui.merch.enabled` | Booléen | Faux | U G (jamais P ni L) | SPEC-CMD-043 |
| `ui.messageActions.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-IHM-017 |
| `ui.minColumns` | Entier | 60 | U | SPEC-IHM-001 |
| `ui.mouse.capture` | Booléen | Faux | U | SPEC-IHM-034 |
| `ui.notifications.agentEnabled` | Booléen | Vrai | U | SPEC-OUT-036 |
| `ui.notifications.channel` | Énuméré (`auto`, `terminal`, `systeme`, `mobile`) | `auto` | U | SPEC-OUT-036 |
| `ui.notifications.durationMs` | Entier | 4 000 | U | SPEC-IHM-024 |
| `ui.notifications.maxPerHour` | Entier | 6 | U | SPEC-OUT-036 |
| `ui.paste.collapseThreshold` | Entier (caractères) | 2 000 | U | SPEC-IHM-010 |
| `ui.paste.detectHeuristic` | Booléen | Vrai | U | SPEC-IHM-010 |
| `ui.paste.maxChars` | Entier | 500 000 | U | SPEC-IHM-010 |
| `ui.promptSuggestions` | Booléen | Vrai | U | SPEC-MOT-028 |
| `ui.queue.autoSend` | Booléen | Vrai | U | SPEC-IHM-011 |
| `ui.queue.maxMessages` | Entier | 10 | U | SPEC-IHM-011 |
| `ui.reducedMotion` | Booléen | Faux | U | SPEC-IHM-038 |
| `ui.render.slowFrameMs` | Entier | 50 | U | SPEC-OBS-010 |
| `ui.replayOnResume` | Énuméré (`condensé`, `complet`, `aucun`) | `condensé` | U | SPEC-MOD-001 |
| `ui.responseStyle` | Nom | `default` | U P | SPEC-MOT-033 |
| `ui.retainedLines` | Entier | 2 000 | U | SPEC-IHM-002 |
| `ui.returnSummary.afterMinutes` | Entier | 20 | U | SPEC-MOT-030 |
| `ui.returnSummary.enabled` | Booléen | Vrai si l'option est construite | U | SPEC-MOT-030 |
| `ui.richText.enabled` | Booléen | Vrai | U | SPEC-IHM-003 |
| `ui.richText.inlineImages` | Booléen | Vrai | U | SPEC-IHM-003 |
| `ui.richText.maxNestingLevel` | Entier | 6 | U | SPEC-IHM-003 |
| `ui.richText.maxRenderedChars` | Entier | 200 000 | U | SPEC-IHM-003 |
| `ui.screenReaderMode` | Booléen | Faux | U | SPEC-IHM-038 |
| `ui.search.debounceMs` | Entier | 150 | U | SPEC-IHM-018 |
| `ui.search.maxMatches` | Entier | 500 | U | SPEC-IHM-018 |
| `ui.sessionSummary` | Booléen | Vrai | U | SPEC-MOD-001 |
| `ui.shellMode.addToContext` | Énuméré (`toujours`, `demander`, `jamais`) | `toujours` | U | SPEC-IHM-012 |
| `ui.shellMode.enabled` | Booléen | Vrai | U P G | SPEC-IHM-012 |
| `ui.shellMode.maxOutputBytes` | Entier | 65 536 | U | SPEC-IHM-012 |
| `ui.shellMode.timeoutMs` | Entier | 120 000 | U | SPEC-IHM-012 |
| `ui.shortMessages.maxAttachmentBytes` | Entier | 10 Mo | U | SPEC-OUT-034 |
| `ui.streamProfile` | `standard` / `compact` | `standard` | U G | SPEC-OBS-022 |
| `ui.surveys.enabled` | Booléen | Vrai | U G | SPEC-IHM-037 |
| `ui.surveys.sampleRate` | Décimal 0–1 | Défini par le produit | G | SPEC-IHM-037 (vue par domaine) |
| `ui.syntaxHighlighting.enabled` | Booléen | Vrai | U | SPEC-IHM-004 |
| `ui.syntaxHighlighting.extraLanguages` | Association extension → langage | Vide | U P | SPEC-IHM-004 |
| `ui.syntaxHighlighting.maxBytes` | Entier | 262 144 | U | SPEC-IHM-004 |
| `ui.syntaxHighlighting.timeoutMs` | Entier | 50 | U | SPEC-IHM-004 |
| `ui.terminalTitleFromSessionName` | Booléen | vrai | U | SPEC-IHM-004 (vue par domaine) |
| `ui.terminalTitle` | Booléen | Vrai | U | SPEC-IHM-036 |
| `ui.theme` | Énuméré | `dark` (ou `auto` si l'option est construite) | U | SPEC-IHM-020 |
| `ui.transcript.collapseThreshold` | Entier (lignes) | 20 | U | SPEC-IHM-006 |
| `ui.transcript.defaultDetail` | Énuméré (`resume`, `normal`, `complet`) | `normal` | U | SPEC-IHM-006 |
| `ui.transcript.showThinking` | Booléen | Vrai | U | SPEC-IHM-006 |
| `ui.unicodeLevel` | Énuméré (`complet`, `restreint`, `ascii`) | `complet` | U | SPEC-IHM-001 |
| `ui.welcome.compact` | Booléen | Faux | U | SPEC-IHM-025 |
| `ui.welcome.hideAccount` | Booléen | Faux | U | SPEC-IHM-025 |
| `ui.wrapTables` | Booléen | Faux | U | SPEC-IHM-002 |
| `ui.yearInReview.enabled` | Booléen | Faux | U G (jamais P ni L) | SPEC-IHM-033 |
| `updates.automatic.enabled` | Booléen | Vrai | U G | SPEC-INS-002 |
| `updates.channel` | `stable` / `latest` | `stable` | U G | SPEC-INS-002 |
| `updates.minimumAllowedVersion` | Version | — | G | SPEC-INS-002 |
| `voice.autoSubmit` | Booléen | Faux | U | SPEC-VOX-001 |
| `voice.extraTerms` | Liste | — | U P | SPEC-VOX-003 |
| `voice.input.enabled` | Booléen | Faux | U | SPEC-VOX-001 |
| `voice.language` | Code de langue | Langue de l'interface | U | SPEC-VOX-001 |
| `workflows.directories` | Liste | Dossiers standard | U P | SPEC-OUT-042 (aussi : SPEC-PLA-003) |
| `workflows.maxParallel` | Entier | 4 | U G | SPEC-OUT-042 (aussi : SPEC-PLA-003) |
| `worktree.cleanupPrompt` | Booléen | Vrai | U | SPEC-INT-007 |
| `worktree.copyIgnored` | Liste de motifs | — | P | SPEC-INT-007 |
