# Configurer les services d’une organisation

La connexion au compte est distincte de la clé d’API du fournisseur. `auth login --company` et `/login company` lancent un parcours humain dans le navigateur ; `WHITECODE_NO_BROWSER=1` pour WhiteCode permet de coller l’URL complète de retour dans un champ masqué. Le produit ne saisit aucun mot de passe. `auth show [--json] [--refresh]` et `/status` affichent le compte, l’organisation, les rôles et l’expiration, sans offre ni droit d’accès aux modèles. `auth logout --company` supprime les jetons du compte après confirmation et conserve les clés de modèles.

La distribution doit renseigner `SERVICE_WEB_APP`, `SERVICE_OAUTH_AUTHORIZE`, `SERVICE_OAUTH_TOKEN` et `OAUTH_CLIENT_ID`. Tous les services du compte exigent HTTPS ; ils partagent le mandataire, les autorités et le certificat client configurés. Aucun jeton du compte ne rejoint un fournisseur de modèles. Les jetons restent dans une entrée native du trousseau distincte ; aucun fichier de repli. `auth.forceOrganization`, en portée gérée uniquement, refuse une connexion à une autre organisation en supprimant ses identifiants. Le profil non secret est rafraîchi après connexion, au démarrage et toutes les quinze minutes. Une indisponibilité du profil ne bloque pas les appels par clé.

Sous `SERVICE_WEB_APP`, `api/account/profile` renvoie `{ account, organization: { id, name }, roles }`. Sous `SERVICE_CONSOLE`, les ressources suivantes sont utilisées :

| Ressource | Contrat |
|---|---|
| `api/settings/snapshot` | GET : `{ revision, values }`, avec clés de préférence plates ; POST : `{ baseRevision, values }`, réponse identique ou `{ conflict: true }`. La révision initiale est `0`. |
| `api/metrics/preferences` | `{ organizationId, eligible, optOut }` ; absence, erreur ou réponse invalide suspendent la collecte sans autorisation encore valide. |
| `api/metrics/batches` | POST de compteurs agrégés : requêtes, jetons, outils, erreurs et durée. Aucun nom de modèle, contenu, chemin, compte ou identifiant de session. |
| `api/memory/snapshot?repository=<empreinte>` | `{ organizationId, repository, entries: [{ file, content, sha256, revision }] }` ; au plus 64 entrées, réponse entière limitée à 256 Kio. |
| `api/memory/entries` | POST : organisation, empreinte du dépôt, fichier, contenu, SHA-256 et révision connue ; réponse `{ accepted: true, revision }`. Un refus conserve l’envoi local. |

Les schémas sont vérifiés à la frontière du service. Les URL ne redirigent pas ; les réponses sont bornées. Les opérations de paramètres sont liées au compte et à l’organisation observés au début ; mémoire et métriques sont liées à leur organisation. Une substitution d’identité en cours d’opération est refusée. Les renouvellements sont sérialisés entre processus ; la génération d’identité reste stable lors d’un renouvellement, la version du jeton change. Une déconnexion invalide aussi les connexions encore en attente du navigateur.

`config push` envoie seulement les préférences utilisateur choisies par `settingsSync.include`. La liste conservatrice couvre les réglages d’interface, la langue et le modèle sélectionné ; commandes, variables d’environnement, identifiants, en-têtes et secrets détectés sont exclus. Un conflit propose `--resolve local`, `--resolve remote` ou `--resolve diff`. `config pull` conserve les autres paramètres et affiche la commande permettant de restaurer sa sauvegarde exacte. `settingsSync.autoUpload` est faux par défaut. Sans console configurée, push/pull sont retirés de l’aide.

La mémoire d’équipe exige un compte, une console et un dépôt ayant une adresse distante. Seule l’empreinte SHA-256 de l’adresse nettoyée est envoyée. L’outil `team_memory` distingue explicitement cet espace de la mémoire personnelle ; son écriture suit les permissions ordinaires. Les secrets sont bloqués avant envoi. Téléchargement au démarrage, synchronisation toutes les minutes et file de 64 noms en attente au plus ; une modification locale concurrente est conservée dans un fichier de conflit avant adoption de la version distante. L’administrateur peut imposer `memory.team.enabled=false`.

Les métriques d’organisation n’exportent que des agrégats bornés, toutes les minutes et à la fermeture. `WHITECODE_NO_TELEMETRY` pour WhiteCode, `telemetry.enabled=false`, le refus géré `telemetry.organizationMetrics=false` et le refus distant se cumulent. L’autorisation distante est conservée cinq minutes en mémoire ; sans autorisation connue, aucune collecte concernée. Une mémoire de compteur bornée permet un nouvel essai après échec, sans file persistante illimitée.

## Sessions distantes et politique hors ligne

Configurez `SERVICE_REMOTE_SESSIONS` dans l’identité pour le relais des sessions. Le réglage `remote.controlAtStartup` détermine le rattachement au démarrage. La commande `/remote-access off` coupe le relais. Pour appliquer des limites lorsque le poste est hors ligne, déployez [l’autorisation administrative du cache](cache.md).

## Configurer le service et le travailleur hébergés

Le serveur reçoit un fichier privé contenant `directory`, `encryptionKeyFile`, `accountsFile`, `workerToken`, `publicBaseUrl`, `currency`, `providers`, `environments` et, si nécessaire, `hostname`, `port`, `tls.certFile`, `tls.keyFile`. Chaque fournisseur a un identifiant explicitement configuré, son adresse et une entrée du catalogue de modèles. Chaque environnement déclare son fournisseur et ses outils ; cette version refuse les connecteurs hébergés non installés. Aucun fournisseur ni modèle n’est choisi par défaut.

Le registre `accountsFile` contient des entrées `account`, `organizationId`, `administrator`, `tokenHash` (SHA-256 du jeton opaque délivré par le frontal de compte de la distribution), `repositories` (liste exacte d’adresses autorisées). Il est relu à chaque autorisation et échéance pour prendre en compte un départ de l’organisation. Il ne remplace pas le parcours humain de connexion existant.

Le travailleur reçoit un fichier root privé contenant `root`, `serviceUrl`, `workerToken`, `prefix`, `productBinary` et `isolation: { firstUid, lastUid }`. `productBinary` désigne le binaire natif Linux installé, accessible en lecture/exécution aux identités de session et non modifiable par elles. Le superviseur et le serveur doivent être installés dans un emplacement root non modifiable par les sessions. Aucune valeur réelle de ces secrets ne doit entrer dans le dépôt.

HTTP sans TLS est limité à la boucle locale ; une écoute publique exige un certificat. Les adresses de fournisseur sont configurées par l’opérateur, sans identifiants dans l’adresse ni redirection suivie. Les jetons du contrôle et les clés de fournisseur sont distincts. Le frontal de connexion au compte et l’émission des jetons restent des ports du service de la distribution ; le présent exécutable ne crée pas un émetteur OAuth supplémentaire.

Les chemins du contrat sont `/console/keys/deposit`, `/console/keys/list`, `/console/keys/usage`, `/console/keys/revoke`, `/console/organization`, `/sessions/key-status`, `/sessions/create`, `/sessions/<id>/status`, `/sessions/<id>/events?after=<séquence>`, `/sessions/<id>/stop` et `/triggers/{create,list,get,update,delete,run}`. Les écritures utilisent POST JSON avec authentification Bearer. Les créations de session et de déclencheur exigent une clé d’idempotence ; la réutiliser avec un contenu différent est refusée. Une exécution immédiate répétée constitue une nouvelle action, à confirmer par le client.
