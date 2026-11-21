# Ancrage d'une politique dans la distribution

Une distribution peut rendre son fichier géré `policy.json` obligatoire en déclarant `policyAnchor` à la racine de son fichier d'identité. L'ancrage est embarqué dans le binaire et inclus dans l'empreinte de l'identité ; il ne fait pas partie des paramètres de session.

L'éditeur prépare et valide le fichier de politique, calcule son empreinte, puis compile la distribution avec l'identité correspondante. Exemple PowerShell pour obtenir l'empreinte des octets du fichier :

```powershell
(Get-FileHash -LiteralPath 'C:\Distribution\policy.json' -Algorithm SHA256).Hash.ToLowerInvariant()
```

Dans l'identité, ajouter cet objet en remplaçant l'empreinte illustrative par le résultat calculé :

```json
"policyAnchor": {
  "organizationId": "organisation-exemple",
  "policySha256": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

L'identifiant comprend de 1 à 128 caractères : lettres ou chiffres, point, tiret ou soulignement ; il commence par une lettre ou un chiffre. L'empreinte comprend 64 caractères hexadécimaux minuscules. Un ancrage incomplet, invalide ou contenant un champ inconnu fait échouer la validation de l'identité.

Compiler avec le profil de distribution :

```powershell
bun scripts/build.ts --identity 'identity/distribution.identity.json'
```

L'administrateur déploie les octets exacts de la politique dans le dossier géré de cette identité (`MANAGED_DIR_WINDOWS`, `MANAGED_DIR_MACOS` ou `MANAGED_DIR_LINUX`). Il protège le fichier et ses parents conformément à [protection.md](protection.md). L'obligation reste présente si le fichier est supprimé, remplacé, rendu illisible ou si une nouvelle session démarre. Les paramètres utilisateur, projet, locaux, les options de lancement et l'environnement ne peuvent la retirer. Le rechargement vérifie aussi l'empreinte avant d'adopter une version.

Sans champ `perimeter`, le périmètre est inconnu : une politique non autorisée ou sémantiquement invalide bloque toutes les fonctions d'agent avec le code 4, avant tout modèle, extension ou crochet. L'aide reste disponible ; `/diagnose` et `diagnostic validate` présentent un diagnostic local minimal. `config validate --scope managed --json` signale l'erreur avec le code 2. Le diagnostic n'applique aucune préférence provenant d'un fichier dont l'empreinte n'est pas autorisée.

L’éditeur peut ajouter `"perimeter": "remote"` dans `policyAnchor`. Les restrictions obligatoires ne s'appliquent alors qu'aux sessions distantes ; les préférences facultatives autorisées restent globales. Une politique distante absente, corrompue ou non autorisée laisse fonctionner le terminal, l'exécution automatisée locale, les outils locaux et le canal de contrôle sur entrée/sortie standard. Le diagnostic local réussit en code 0 en signalant les fonctions distantes indisponibles ; la validation du fichier reste en code 2.

Le périmètre distant inclut `--control-listen`, `--control-connect` et `connector-server start --transport network`, même sur une adresse locale. Les entrées réservées aux sessions distantes, SSH et accès distant sont protégées. Une source invalide refuse ces entrées en code 4 avant l'ouverture réseau. Dans une session distante déjà ouverte, une corruption bloque les actions concernées et les nouvelles connexions. Les appels imbriqués conservent le périmètre distant ; aucune option d'appel ne peut le rendre local. Les autres valeurs de `perimeter` sont refusées à la compilation.

Pour rétablir le fonctionnement, l'administrateur restaure le fichier autorisé puis l'utilisateur redémarre. Toute modification des octets, y compris un commentaire ou un changement de mise en forme, exige une nouvelle distribution autorisant la nouvelle empreinte. L'ancrage n'est ni une clé ni un secret.

Voir aussi l’[inscription du poste](inscription.md) et le [cache hors ligne](cache.md).
