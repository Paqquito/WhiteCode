# Personnaliser une distribution

Copiez [le fichier d’identité de WhiteCode](../identity/whitecode.identity.json), puis modifiez les sections `identity` (nom et domaine), `models` (libellés), `visual` (couleur et icône) et `services` (URL de vos services). Les variables comme `{{MODEL_DEFAULT}}` sont résolues lors du rendu d’un document de la distribution.

```sh
bun scripts/identity.ts validate mon-identite.json
bun scripts/build.ts --identity mon-identite.json --profile public
```

Dans les tableaux, **P** indique une valeur primaire, **D** une valeur dérivée, **O** une valeur optionnelle et **S** une valeur surchargeable à l’exécution.

## Identité

| Variable | Type | P/D/O | Défaut / dérivation | Contraintes | S |
|---|---|---|---|---|---|
| `SOCIETY` | Texte localisable | P | — | 1–64 caractères, non vide après suppression des espaces | Non |
| `SOCIETY_LEGAL` | Texte | D | `{{SOCIETY}}` | 1–128 caractères | Non |
| `SOCIETY_SLUG` | Identifiant | D | Nom de la société en kebab-case | `^[a-z][a-z0-9-]{1,31}$` | Non |
| `SOCIETY_DOMAIN` | Domaine | P | — | Nom de domaine valide | Non |
| `PRODUCT` | Texte localisable | P | — | 1–32 caractères | Non |
| `PRODUCT_SLUG` | Identifiant | D | Nom du produit en kebab-case | `^[a-z][a-z0-9-]{1,31}$` | Non |
| `PRODUCT_CLI` | Identifiant | D | `{{PRODUCT_SLUG}}` | `^[a-z][a-z0-9-]{1,31}$` | Non |
| `PRODUCT_BUNDLE_ID` | Identifiant inversé | D | domaine inversé de `{{SOCIETY_DOMAIN}}` + `.{{PRODUCT_SLUG}}` | `^[a-z0-9]+(\.[a-z0-9-]+)+$` | Non |
| `PRODUCT_TAGLINE` | Texte localisable | O | — | ≤ 120 caractères | Non |
| `ASSISTANT_NAME` | Texte localisable | D | `{{PRODUCT}}` | Nom par lequel l'assistant se présente | Non |

## Emplacements

| Variable | Type | P/D/O | Défaut / dérivation | Contraintes | S |
|---|---|---|---|---|---|
| `CONFIG_DIR` | Chemin utilisateur | D | `~/.{{PRODUCT_SLUG}}` | Commence par `~/` ou absolu | Non |
| `USER_STATE_FILE` | Chemin utilisateur | D | `{{CONFIG_DIR}}/state.json` | idem | Non |
| `PROJECT_DIR` | Nom de dossier | D | `.{{PRODUCT_SLUG}}` | Nom simple, sans séparateur | Non |
| `INSTRUCTIONS_FILE` | Nom de fichier | D | `{{PRODUCT_SLUG}}.instructions.md` | Se termine par `.md` | Non |
| `LOCAL_INSTRUCTIONS_FILE` | Nom de fichier | D | `{{PRODUCT_SLUG}}.instructions.local.md` | Se termine par `.md` | Non |
| `MEMORY_INDEX_FILE` | Nom de fichier | D | Identifiant en majuscules, suivi de `.memory.md` | Se termine par `.md` | Non |
| `LIVING_DOC_HEADER` | Texte | D | `# `, identifiant en majuscules, puis ` LIVING DOC:` | Commence par `#`, une seule ligne | Non |
| `MANAGED_DIR_LINUX` | Chemin absolu | D | `/etc/{{PRODUCT_SLUG}}` | Absolu | Non |
| `MANAGED_DIR_MACOS` | Chemin absolu | D | `/Library/Application Support/{{PRODUCT}}` | Absolu | Non |
| `MANAGED_DIR_WINDOWS` | Chemin absolu | D | `C:\ProgramData\{{PRODUCT}}` | Absolu | Non |
| `MANAGED_POLICY_DOMAIN` | Identifiant inversé | D | `{{PRODUCT_BUNDLE_ID}}` | Domaine des profils de gestion de poste | Non |
| `MANAGED_REGISTRY_KEY` | Clé de registre | D | `SOFTWARE\Policies\{{SOCIETY}}\{{PRODUCT}}` | Sans ruche en préfixe | Non |
| `INSTALL_DIR` | Chemin utilisateur | D | `~/.local/share/{{PRODUCT_SLUG}}` | — | Non |
| `BIN_LINK` | Chemin utilisateur | D | `~/.local/bin/{{PRODUCT_CLI}}` | — | Non |
| `TEMP_PREFIX` | Texte | D | `{{PRODUCT_SLUG}}-` | `^[a-z0-9-]+$` | Non |

## Identifiants techniques

| Variable | Type | P/D/O | Défaut / dérivation | Contraintes | S |
|---|---|---|---|---|---|
| `ENV_PREFIX` | Préfixe | D | Identifiant en majuscules, mots séparés par des tirets bas, suivi de `_` | `^[A-Z][A-Z0-9_]*_$` | Non |
| `URL_SCHEME` | Schéma d'URL | D | `{{PRODUCT_SLUG}}` | `^[a-z][a-z0-9+.-]*$` | Non |
| `HINT_TAG` | Nom de balise | D | `{{PRODUCT_SLUG}}-hint` | `^[a-z][a-z0-9-]*$` | Non |
| `KEYCHAIN_SERVICE` | Texte | D | `{{PRODUCT}} credentials` | — | Non |
| `NATIVE_HOST_NAME` | Identifiant | D | Identifiant de distribution en minuscules, suivi de `.browser_host` | `^[a-z0-9_.]+$` (contrainte des navigateurs) | Non |
| `SELF_MCP_SERVER_NAME` | Identifiant | D | `{{PRODUCT_SLUG}}` | — | Non |
| `USER_AGENT` | Gabarit | D | `{{PRODUCT_CLI}}/<version>` | Le jeton `<version>` est remplacé au build | Non |
| `HTTP_HEADER_PREFIX` | Préfixe | D | `x-{{PRODUCT_SLUG}}-` | Minuscules | Non |
| `TELEMETRY_EVENT_PREFIX` | Préfixe | D | Identifiant en snake_case, suivi de `_` | `^[a-z][a-z0-9_]*_$` | Non |
| `PROCESS_TITLE` | Texte | D | `{{PRODUCT_CLI}}` | — | Non |
| `PACKAGE_NAME` | Nom de paquet | D | `@{{SOCIETY_SLUG}}/{{PRODUCT_SLUG}}` | Règles du registre de paquets | Non |

## Profils

| Variable | Type | P/D/O | Défaut / dérivation | Contraintes | S |
|---|---|---|---|---|---|
| `INTERNAL_PROFILE` | Identifiant | D | `internal` | `^[a-z][a-z0-9-]*$` | Non |

## Gammes de modèles

| Variable | Type | P/D/O | Défaut / dérivation | Contraintes | S |
|---|---|---|---|---|---|
| `MODEL_LARGE`, `MODEL_MEDIUM`, `MODEL_SMALL` | Objet `{ label, ids: { <fournisseur>: <identifiant> } }` | P (au moins une gamme) | — | `label` 1–32 caractères ; identifiants facultatifs pour les modèles configurés par l’utilisateur | Non |
| `MODEL_DEFAULT` | Référence de gamme | D | `MODEL_MEDIUM` si défini, sinon la première gamme définie | Doit référencer une gamme définie | Oui |
| `MODEL_BACKGROUND` | Référence de gamme | D | `MODEL_SMALL` si défini, sinon `MODEL_DEFAULT` | idem | Oui |


## Services de la société
Toutes les URL doivent être en `https://`, sauf `localhost` / `127.0.0.1` en mode développement.

| Variable | Usage | P/D/O | S |
|---|---|---|---|
| `SERVICE_DOCS` | Documentation en ligne | P | Oui |
| `SERVICE_DOWNLOADS` | Téléchargement des binaires et mises à jour | P | Oui |
| `SERVICE_SUPPORT` | Support / signalement | O | Oui |
| `SERVICE_FEEDBACK` | Envoi de retours | O | Oui |
| `SERVICE_STATUS` | Page d'état des services | O | Oui |
| `SERVICE_TERMS` | Conditions d'utilisation | O | Oui |
| `SERVICE_PRIVACY` | Politique de confidentialité | O | Oui |
| `SERVICE_RELEASE_NOTES` | Notes de version | O | Oui |
| `SERVICE_CONSOLE` | Console d'administration (clés d'API, organisation) | O | Oui |
| `SERVICE_WEB_APP` | Application web (sessions distantes, partage) | O | Oui |
| `SERVICE_OAUTH_AUTHORIZE` / `SERVICE_OAUTH_TOKEN` | Points d'autorisation OAuth 2.0 de la connexion au compte de la société | O | Oui |
| `OAUTH_CLIENT_ID` | Identifiant client OAuth | O (requis si OAuth) | Oui |
| `SERVICE_REMOTE_SESSIONS` | Exécution de sessions à distance | O | Oui |
| `SERVICE_SPEECH_TO_TEXT` | Transcription de la parole pour le mode vocal | O | Oui |
| `SERVICE_TELEMETRY` | Collecte de télémétrie | O | Oui |
| `SERVICE_FEATURE_FLAGS` | Service d'options dynamiques | O | Oui |
| `SERVICE_ERROR_REPORTING` | Remontée d'erreurs | O | Oui |
| `SERVICE_MARKETPLACE` | Catalogue officiel d'extensions | O | Oui |
| `SERVICE_MCP_REGISTRY` | Registre de serveurs MCP | O | Oui |
| `SERVICE_DESKTOP_APP` | Application de bureau | O | Non |
| `SERVICE_MOBILE_IOS` / `SERVICE_MOBILE_ANDROID` | Applications mobiles | O | Non |
| `SERVICE_BROWSER_EXTENSION` | Extension de navigateur (Chrome) | O | Non |
| `IDE_EXTENSION_ID_VSCODE` | Identifiant de l'extension IDE (VS Code) | O | Non |
| `IDE_PLUGIN_ID_JETBRAINS` | Identifiant du plugin IDE (JetBrains) | O | Non |
| `GIT_FORGE_APP` | Application de forge Git (GitHub) à installer | O | Non |
| `TEAM_CHAT_APP` | Application de messagerie d'équipe (Slack) | O | Non |
| `SERVICE_MERCH` | Boutique d'articles promotionnels | O | Non |

## Attribution Git

| Variable | Type | P/D/O | Défaut / dérivation | S |
|---|---|---|---|---|
| `GIT_COAUTHOR_NAME` | Texte | D | `{{PRODUCT}}` | Non |
| `GIT_COAUTHOR_EMAIL` | E-mail | D | `noreply@{{SOCIETY_DOMAIN}}` | Non |
| `PR_FOOTER` | Texte localisable | D | « Généré avec {{PRODUCT}} » suivi d'un lien vers `{{SERVICE_DOCS}}` | Non |
| `BRANCH_PREFIX` | Texte | D | `{{PRODUCT_SLUG}}/` | Non |

## Identité visuelle

| Variable | Type | P/D/O | Défaut / dérivation | S |
|---|---|---|---|---|
| `BRAND_COLOR_PRIMARY` | Couleur `#RRGGBB` | P | — | Non |
| `BRAND_COLOR_ACCENT` | Couleur `#RRGGBB` | D | `{{BRAND_COLOR_PRIMARY}}` | Non |
| `LOGO_TEXT` | Ressource texte (art ASCII) | O | Nom du produit en capitales | Non |
| `ICON` | Ressource image (PNG ≥ 512 px ou SVG) | O | Icône neutre générique | Non |
| `COMPANION_NAME` | Texte localisable | O | Si absent, le compagnon animé est désactivé | Non |

## Textes de marque

| Variable | Type | P/D/O | Défaut / dérivation | S |
|---|---|---|---|---|
| `IDENTITY_STATEMENT` | Texte localisable | D | « Tu es {{ASSISTANT_NAME}}, l'assistant de développement de {{SOCIETY}}. » | Non |
| `WELCOME_MESSAGE` | Texte localisable | O | « Bienvenue dans {{PRODUCT}} » | Non |
| `LEGAL_NOTICE` | Texte localisable | O | — | Non |

## Compatibilité et conformité

| Clé | Type | Rôle |
|---|---|---|
| `previousIdentities` | Liste d'objets `{ PRODUCT_SLUG, CONFIG_DIR, PROJECT_DIR, INSTRUCTIONS_FILE, ENV_PREFIX, URL_SCHEME }` | Identités précédentes pour la migration. |
| `forbiddenTerms` | Liste de chaînes | Termes interdits pour le contrôle anti-fuite. Vide par défaut. |
| `scanExceptions` | Liste d'objets `{ terme, contexte, justification }` | Exceptions autorisées. |
| `allowLegacyReads` | Booléen, défaut faux | Autorise la lecture des emplacements de compatibilité. |
