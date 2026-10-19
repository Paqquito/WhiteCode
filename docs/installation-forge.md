# Installer l’application de forge

`/install-forge-app` est proposé dans les distributions qui renseignent `GIT_FORGE_APP`. Lancez-le dans un dépôt Git, avec Git et `gh` installés. Authentifiez vous-même `gh` au préalable : l’assistant n’effectue aucune connexion et ne demande jamais votre mot de passe ni le jeton de connexion de la forge. Le compte actif doit administrer le dépôt choisi et son autorisation doit permettre la publication de fichiers de flux. Si la forge refuse ce droit, faites ajuster vous-même les autorisations de l’outil avant de relancer le parcours.

La société doit fournir son déploiement et les quatre valeurs de `git.forgeApp`, dans les paramètres **utilisateur ou gérés** :

| Valeur | Contrat |
|---|---|
| `workflow` | `propriétaire/dépôt/.github/workflows/nom.yml@` suivi du SHA complet de 40 chiffres hexadécimaux minuscules. Le dépôt appartient au même hôte de forge que le dépôt choisi. |
| `installationCheckUrl` | Point de vérification HTTPS de la société, sans identifiants, paramètres ni fragment dans l’adresse. |
| `secretName` | Préfixe du secret Actions, en majuscules, chiffres et traits de soulignement ; `GITHUB` et les préfixes commençant par `GITHUB_` sont refusés, car le nom généré commencerait par le préfixe réservé `GITHUB_`. Chaque installation ajoute un suffixe aléatoire cryptographique de 32 chiffres hexadécimaux. Le préfixe est limité aux 67 premiers caractères pour respecter la limite de 100 caractères du nom concret. |
| `secretInput` | Nom de l’entrée secrète obligatoire du flux réutilisable. |

Le flux fourni doit déclarer `on.workflow_call`, une entrée `mode` de type `string` acceptant `mention` et `review`, et le secret obligatoire `secretInput`. Il ne doit demander aucune autre entrée ni secret obligatoire. Il contient les tâches qui exécutent réellement le déploiement de la société. La distribution ne choisit aucune action tierce ni aucun service de modèle par défaut. Les dépôts privés doivent autoriser l’utilisation de ce flux depuis le dépôt appelant dans les réglages de la forge.

Le service de vérification accepte une requête `POST` JSON :

```json
{"version":1,"application":"identifiant-fourni-par-la-societe","repository":"proprietaire/depot","repositoryId":123}
```

Après avoir vérifié l’installation active auprès de la forge avec ses propres identifiants d’application, il répond avec les mêmes trois valeurs et `"version":1,"installed":true`. Il doit vérifier le dépôt exact, et non seulement l’installation au niveau de l’organisation. L’assistant ne lui transmet aucun identifiant de forge ni secret de service. Une confirmation humaine seule ne suffit pas. Une réponse incorrecte ou un échec TLS arrête le parcours.

Choisissez le dépôt puis les mentions ou la revue automatique. Relisez le flux épinglé, les permissions et le nom concret du secret affichés. Ce nom propre à l’installation est repris dans le flux et la demande de fusion. Après confirmation, installez vous-même l’application dans la page ouverte, puis confirmez pour lancer la vérification. Une annulation est contrôlée immédiatement avant l’ouverture du navigateur. Saisissez ensuite un secret de service dédié dans le champ masqué : il part directement vers `gh secret set` par son entrée standard. Les sorties de cette commande sont ignorées, y compris en cas d’erreur.

Le nom concret est vérifié avant le consentement, puis de nouveau juste avant le dépôt ; s’il existe déjà, le parcours refuse le setter. Un secret portant uniquement le préfixe configuré est conservé. Le suffixe aléatoire de 128 bits évite les collisions des installations ordinaires, y compris simultanées. `gh secret set` réalise toutefois une création ou un remplacement sans condition atomique : un administrateur qui crée exactement le même nom entre la dernière vérification et le dépôt peut encore être remplacé. Aucune garantie de création atomique sans remplacement n’est fournie face à cet administrateur concurrent.

L’assistant récupère la branche par défaut dans un dépôt nu temporaire protégé et y prépare uniquement `.github/workflows/<identifiant-produit>-agent.yml`. Il refuse d’écraser un flux existant. Il pousse une nouvelle branche et ouvre une demande de fusion, dont il vérifie l’état ouvert et le fichier ajouté. La branche courante, l’index et les fichiers du projet ne sont pas modifiés. Avant ces opérations réseau, l’assistant lit l’identité Git de l’utilisateur et les seuls chemins publics `http.sslCAInfo` / `http.sslCAPath` applicables à cette URL depuis les configurations utilisateur ou système. Les opérations du dépôt temporaire ignorent ensuite les configurations Git globales et système, notamment les réécritures d’URL et headers HTTP hérités ; la vérification TLS reste obligatoire. Le helper explicitement construit pour `gh auth git-credential` réutilise l’authentification déjà établie par l’humain.

Les mentions déclenchent le flux pour les propriétaires, membres et collaborateurs. La revue automatique concerne les branches du même dépôt : les demandes venant de copies externes ne reçoivent pas le secret. Le flux n’utilise pas `pull_request_target`, ne contient pas de commande shell construite à partir d’un commentaire et ne transmet que le secret configuré au flux épinglé. Son jeton standard reçoit la lecture du contenu et l’écriture des tickets et demandes de fusion.

Relisez la demande puis fusionnez-la vous-même. Le flux devient actif après cette fusion. Si le dépôt du secret réussit mais qu’une étape suivante échoue, le message précise le secret déjà créé et, le cas échéant, la branche poussée. Aucun objet distant n’est supprimé automatiquement ; un administrateur décide de sa conservation ou de son retrait.
