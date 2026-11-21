# WhiteCode

WhiteCode est un assistant de programmation en ligne de commande. Il peut lire un dépôt, proposer des modifications et exécuter des outils avec les autorisations de l’utilisateur. Pour l’utiliser avec une interface graphique, suivez le [guide de WhiteCode Desktop](https://github.com/Paqquito/WhiteCode-Desktop#readme).

## Construire et lancer le moteur

Installez Git et Bun 1.4.2. Depuis le dossier où vous souhaitez cloner le projet, exécutez les commandes suivantes.

```sh
git clone https://github.com/Paqquito/WhiteCode.git
cd WhiteCode
bun install --frozen-lockfile
bun scripts/build.ts --identity identity/whitecode.identity.json --profile public
bun dist/whitecode.js --help
```

Le même dossier `dist/` contient un exécutable autonome pour votre système, nommé `whitecode.exe` sous Windows et `whitecode` sous Linux et macOS.

## Configurer le premier modèle

Pour un serveur compatible avec l’API OpenAI, créez le fichier `~/.whitecode/config.json` dans votre dossier personnel. Remplacez `mon-modele` par l’identifiant exact servi par votre serveur. Adaptez l’adresse et les limites de jetons à ce modèle. Il doit prendre en charge les appels d’outils.

```json
{
  "api": { "provider": "openai_compatible", "baseUrl": "http://127.0.0.1:11434/v1" },
  "models": {
    "identifierMap": { "large": "mon-modele", "medium": "mon-modele", "small": "mon-modele" },
    "extraCatalog": [
      {
        "id": "mon-modele",
        "provider": "openai_compatible",
        "family": "local",
        "label": "Mon modèle",
        "contextWindow": 32768,
        "maxOutputTokens": 4096,
        "capabilities": { "toolCalling": true }
      }
    ]
  }
}
```

Si votre serveur exige une clé, définissez `OPENAI_API_KEY` dans l’environnement du processus. Vérifiez les paramètres, puis lancez une première demande depuis le dépôt.

```sh
bun dist/whitecode.js config validate
bun dist/whitecode.js --non-interactive "Résume le fichier README.md"
```

## Configuration et vérifications

- [Paramètres et emplacements des fichiers](docs/parametres.md) · [Variables d’environnement](docs/environnement.md)
- [Connexion à un serveur MCP](docs/connecteurs-http.md) · [Autorisations des connecteurs](docs/connecteurs-autorisation.md)
- [Clés et dossiers autorisés](docs/cles-et-dossiers.md) · [Stockage chiffré des sessions](docs/stockage-chiffre.md)
- [Personnaliser une distribution](docs/marque-blanche.md) · [Options de compilation](docs/options-de-compilation.md) · [Installation native et mises à jour](docs/installation-native.md)
- [Déployer une politique d’organisation](docs/administration/inscription.md) · [Services d’organisation](docs/administration/services.md) · [Configurer une application de forge](docs/installation-forge.md)

Après une modification, `bun run typecheck` vérifie les types, `bun run check` contrôle les sources, `bun run trace` vérifie la couverture des critères et `bun run test` lance les tests.

## Licence

WhiteCode est distribué sous [licence MIT](LICENSE). Les [notices des dépendances](THIRD_PARTY_NOTICES.txt) accompagnent la distribution. L’exécutable les affiche avec `--licenses`. Après une mise à jour des dépendances, régénérez-les avec `bun ../WhiteCode-Extensions/scripts/dependency-notices.ts .`.
