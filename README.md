# Agent de programmation en ligne de commande — dépôt de développement

Ce dépôt réalise, en salle blanche, le produit décrit par les fiches de `specs/` (seule source de vérité). Le produit est en marque blanche : son nom, sa commande, ses dossiers et ses variables d'environnement viennent du **fichier d'identité** (SPEC-CAD-002), jamais du code.

- Identité de développement (fictive) : `identity/dev.identity.json` — commande `pilote-dev`, préfixe `PILOTE_DEV_`.
- Seconde identité de test : `identity/test-omega.identity.json`.
- Catalogue de modèles de développement : `identity/dev.models.json` — **vide** : le dépôt ne nomme aucun fournisseur ni modèle par défaut (D-09).



## Prérequis

Bun 1.4.2 ou plus récent.

```bash
bun install
```

## Commandes

| Commande | Rôle |
|---|---|
| `bun run gen` | Résout l'identité et le catalogue et génère les constantes de build (`src/identity/generated/`, non versionné). |
| `bun run typecheck` | Vérification stricte des types. |
| `bun run check` | Contrôles statiques : en-têtes de traçabilité, confinement de l'environnement et des API propres à Bun, aucune valeur d'identité dans le code. |
| `bun test` | Tests (sans réseau : fournisseur simulé et serveur local). |
| `bun run trace` | Vérifie que chaque critère revendiqué (`tests/claims.json`) est couvert ; matrice dans `build/trace-matrix.md`. |
| `bun scripts/build.ts` | Exécutable autonome pour la plateforme courante dans `dist/` (`--all` : les 8 cibles). |
| `bun scripts/identity.ts validate <fichier>` | Outil de marque : `validate`, `resolve`, `show`. |

## Configurer un fournisseur (serveur local compatible OpenAI)

Aucun fournisseur n'est configuré par défaut : sans configuration, le produit s'arrête (code 2) en expliquant quoi renseigner. Chaque développeur déclare son serveur et ses modèles dans **ses paramètres utilisateur** (`~/.pilote-dev/config.json`), jamais dans le dépôt :

```json
{
  "api": { "provider": "openai_compatible", "baseUrl": "http://127.0.0.1:11434/v1" },
  "models": {
    "identifierMap": { "large": "<modèle>", "medium": "<modèle>", "small": "<modèle>" },
    "extraCatalog": [
      { "id": "<modèle>", "provider": "openai_compatible", "family": "local", "label": "Local",
        "contextWindow": 32768, "maxOutputTokens": 4096, "capabilities": { "toolCalling": true } }
    ]
  }
}
```

Le modèle doit prendre en charge les **appels d'outils du protocole** (`toolCalling`) : un modèle qui écrit l'appel sous forme de texte ne convient pas. La clé est facultative (`OPENAI_API_KEY`) ; l'URL peut aussi venir de `OPENAI_BASE_URL`.

```bash
bun src/main.ts --non-interactive "Résume le fichier README.md"
```

Test d'intégration facultatif sur ce serveur :

```bash
TEST_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:11434/v1 TEST_OPENAI_COMPATIBLE_MODEL=<modèle> bun test tests/openai-compatible.test.ts
```

Options utiles : `--result-format json|jsonl`, `--request-format jsonl` (un message par ligne : `{"type":"user","content":"…"}`), `--max-iterations 5`, `--approval-mode no_prompt|planning|auto_edit` (`no_prompt` par défaut en non interactif ; `unrestricted` avec `--allow-unrestricted-mode`), `--allow-rule "edit_file(src/**)"`, `--toolset read_file,find_files`, `--allow-project-trust` (lit les paramètres du projet pour cette seule exécution). La transcription est écrite sous `~/.pilote-dev/sessions/`.

Outils livrés : `read_file` (texte, notebooks, images), `write_file`, `edit_file`, `update_notebook_cell`, `find_files`, `search_content` (utilise ripgrep s'il est installé, sinon une recherche intégrée). `run_shell` (shell POSIX : `tools.shell.default`, sinon `SHELL`, sinon `bash` ; sous Windows, celui de Git pour Windows) et `run_powershell` (PowerShell 7 ou 5.1) ; sans règle `allow`, une commande est demandée, donc refusée en `no_prompt` : autorisez les commandes utiles, par exemple `--allow-rule "run_shell(npm test)"`.

L'adaptateur `anthropic` est facultatif : `"api": { "provider": "anthropic" }` et la clé de l'utilisateur dans `ANTHROPIC_API_KEY`.

## Sous-commandes d'administration

```bash
bun src/main.ts model list
```

`<famille> <opération>` : `model list`, `model show <nom>` et `config validate [<fichier>]` sont livrées, avec `--json` pour une sortie structurée ; une famille seule affiche son aide. Fournisseurs livrés : `openai_compatible` (référence), `openai` (`OPENAI_API_KEY`) et `anthropic` (facultatif). `bun run models-verify` vérifie le catalogue auprès de l'API Models des fournisseurs, avec les clés de votre environnement.

## Jeu d'évaluation

Le contrat de comportement (`prompts/contract/`) est évalué par les scénarios de `eval/` (voir `eval/README.md`) :

```bash
bun scripts/eval.ts --suite eval/suite.json --family generic --report build/eval-report.json
```

Le produit est lancé cinq fois par scénario avec le fournisseur de vos paramètres utilisateur ; le script indique si la version est diffusable (règle de SPEC-MOT-045) et écrit le rapport.

Limites d'une exécution : `--max-iterations`, `--max-duration <secondes>`, `--max-cost 2.50` (plafond dans la devise du catalogue, admission de chaque requête sur une borne de coût).

## Conventions

- Chaque module commence par `// Implements: SPEC-…` ou `// Supports: SPEC-…`.
- Chaque test commence par l'identifiant du critère vérifié (`SPEC-OUT-002/CA-01 — …`), d'une décision (`D-05 — …`), d'un écart (`E-022 — …`) ou par `TECH —`.
- Identifiants de code et commentaires en anglais ; documentation en français ; textes destinés au modèle en anglais, rédigés à neuf (`prompts/`).
