# Adoption des paramètres sensibles en cache

Avec le [cache autorisé](cache.md), l’accord est demandé avant l’activation de nouveaux paramètres sensibles. L'autorisation administrative conserve l'organisation, le périmètre, l'intégrité, la période de validité et la révocation. Elle ne remplace pas l'accord personnel sur les contenus capables d'exécuter du code ou de modifier son environnement.

## Accord avant les effets

Une session interactive ordinaire présente les contenus exacts ajoutés, modifiés ou supprimés avant de composer le fournisseur, les crochets ou les extensions. Les déclarations de crochets, les variables d'environnement, les chemins exécutables et les contrôles d'activation ou d'accès des crochets, connecteurs et extensions sont sensibles. Les délais, tailles de sortie et descriptions de connecteurs restent des réglages sans dialogue. Une suppression de contrôle est présentée car elle peut rendre effectives des valeurs des autres portées ou des valeurs par défaut.

Le dialogue exige un terminal d'au moins 92 colonnes et huit lignes. Il faut atteindre la dernière page avant d'accepter ; chaque page et redimensionnement réarme la garde de 350 ms. Le collage encadré, même réparti entre plusieurs arrivées espacées, ne fournit aucune touche d'accord. Échap, `n`, interruption ou fermeture refusent. Un changement ou une révocation pendant la lecture invalide la réponse. L'autorité et la validité sont revérifiées après la lecture de toutes les sources.

Un refus global termine en code 4, sans appliquer la nouvelle politique ni continuer avec l'ancienne. Si l'autorité encadre seulement le distant, le lancement interactif ordinaire permet également de lire son dialogue : le refus conserve les fonctions locales et bloque les entrées distantes. Une mise à jour de l'autorité pendant une session suspend les capacités encadrées ; l'utilisateur redémarre pour lire la nouvelle proposition. Les changements prennent effet après redémarrage.

## Conservation de l'accord

L'accord au terminal vaut pour l'objet de cache de l'exécution courante. Le reçu `remote-policy-consent-receipt.json` dans le dossier utilisateur contient seulement les empreintes qualifiées, sans commandes, variables d'environnement ni identifiants secrets. Le programme **ne lit jamais ce reçu ni un champ de l'état utilisateur pour accorder une autorisation** : un agent sans restriction peut modifier ces emplacements.

Pour conserver l'accord entre les démarrages, l'administrateur doit vérifier indépendamment que le compte natif a accepté ces contenus précis, puis attester les empreintes dans un fichier système protégé. **Copier ou protéger un reçu sans cette vérification ne suffit pas à établir l'accord humain.** Le programme ne réalise aucune élévation, installation d'attestation ou modification des droits.

Le document d'attestation est le JSON strict du reçu : cinq champs obligatoires `schemaVersion: 1`, `principal`, `organizationId`, `perimeter`, `fingerprints`. Aucun doublon, champ supplémentaire ou valeur booléenne d'empreinte n'est admis. Les empreintes SHA-256 distinguent une valeur présente d'une suppression. Le compte est qualifié par le SID du jeton du processus Windows ou l'UID natif POSIX ; les variables de profil, le projet et les options ne fournissent pas son identité. Seule l'empreinte du compte est enregistrée.

L'emplacement est à côté de `policy.json` : `cache-consent.<empreinte-de-portee>.json`. L'empreinte de portée est le SHA-256 du JSON canonique du tableau `[principal, organizationId, perimeter]`, sans préfixe. Le reçu fournit ces trois champs. Les fichiers de différentes organisations, comptes ou périmètres ne se remplacent pas. Le fichier et tous ses parents doivent satisfaire la protection native ; **l'agent courant ne doit pas pouvoir écrire ou remplacer cette attestation, même avec un jeton administrateur**. Un fichier modifiable, illisible ou malformé est refusé. Un administrateur qui prépare le déploiement doit lancer l'agent avec les droits ordinaires du membre pour utiliser l'attestation.

Après attestation, une version hors ligne encore autorisée et dont les contenus sensibles correspondent s'applique sans nouveau dialogue, y compris après une modification de réglages non sensibles. Un contenu modifié, ajouté ou retiré exige un nouvel accord. Un accord n'autorise ni une autre organisation, ni un autre périmètre, ni une version que l'autorité aurait retirée. La disparition ou modification de l'attestation pendant une session provoque la garde de suspension existante.
