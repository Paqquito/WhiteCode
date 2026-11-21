# Protection du fichier de politique système

La lecture de `policy.json` vérifie les droits du fichier et de tous ses parents. Le chemin reste celui de l'identité compilée ; aucun paramètre utilisateur, argument ou environnement ne remplace cette vérification.

Une politique obligatoire modifiable par un utilisateur non autorisé est refusée dans son ensemble. Sans périmètre déclaré, les fonctions d'agent échouent en code 4 avant modèle, extension, crochet ou réseau. L'aide et le diagnostic local minimal restent accessibles ; `config validate --scope managed` expose l'erreur en code 2. Avec un ancrage limité au distant, les fonctions locales restent accessibles, mais aucune préférence provenant du fichier refusé n'est appliquée.

Une source lisible qui ne contient que des préférences facultatives reste effective lorsqu'elle est modifiable, avec un avertissement au démarrage et dans `/diagnose`, `diagnostic validate` et `config validate`. Une protection invérifiable, un fichier détecté puis devenu illisible ou une lecture instable ne sont jamais assimilés à une absence bénigne.

## Déploiement

L'administrateur protège le fichier, ses dossiers parents et la distribution du programme. Un attribut « lecture seule » ne suffit pas : le propriétaire ou un utilisateur disposant de droits sur le parent peut souvent modifier les droits, supprimer le fichier ou le remplacer.

Sous Windows, le jeton administrateur actif est autorisé. Pour un autre jeton, le lecteur interroge les droits effectifs d'écriture, d'ajout, de suppression et de changement des droits ou du propriétaire. Sur les parents, il vérifie aussi le droit de supprimer un enfant. Ces ouvertures natives utilisent exclusivement des objets existants ; elles ne modifient ni fichier ni ACL. Les échecs autres qu'un refus d'accès rendent la protection invérifiable.

Sous Linux et macOS, le fichier et ses parents doivent appartenir à l'administrateur système (UID 0). Le fichier doit être ordinaire ; les écritures de groupe et des autres utilisateurs sont refusées. Les dossiers appartenant à UID 0 et portant le bit de protection des suppressions (`sticky`) peuvent abriter des enfants également détenus par UID 0. Pour un processus non administrateur, les droits d'écriture effectifs sont également interrogés. Une installation classique utilise un fichier de mode `0644` et des dossiers de mode `0755`, sans droits supplémentaires d'écriture pour l'utilisateur.

Les liens symboliques et les jonctions dans ce chemin sont refusés. Le déploiement doit employer un chemin physique protégé. Sous Windows, ce lecteur prend en charge les chemins absolus sur un lecteur local ; les chemins réseau et les objets spéciaux sont refusés. Le format et l'emplacement du registre sont décrits dans [registre-windows.md](registre-windows.md).

## Changements pendant une session

Les droits sont revérifiés avant les actions et lors du rechargement, même si le contenu et sa date de modification sont inchangés. Une perte de protection rend immédiatement indisponibles les actions encadrées. Une lecture compare le fichier ouvert et le chemin avant et après la lecture ; un remplacement ou une modification détectée est refusé. Le contenu est limité à 1 Mio, sans lecture illimitée d'un flux.

La réparation des droits reste administrative : le diagnostic ne réécrit pas le fichier géré et ne modifie pas automatiquement ses permissions. Une fois la source rétablie, redémarrer pour recomposer une session avec la version autorisée. L'ancrage de distribution continue de vérifier l'empreinte des octets indépendamment des droits.
