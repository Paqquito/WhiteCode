# Installation native et mises à jour

La construction fournit `install.ps1` pour Windows et `install.sh` pour macOS et Linux. Ils détectent système et architecture, récupèrent un exécutable autonome sur le service de distribution de l’identité, puis contrôlent sa taille et son empreinte avant de l’exécuter. Aucune installation préalable de Bun n’est nécessaire. Sous Alpine, `curl`, les autorités de certification et `libstdc++` doivent être présents. L’identité WhiteCode utilise des adresses d’exemple. Pour utiliser ces scripts, la distribution doit fournir un service de téléchargement.

Depuis un exemplaire du produit, utiliser `installation update`, éventuellement `--channel stable`, `--channel latest` ou `--version 1.2.3`. `--check` consulte uniquement le manifeste et ne crée aucun fichier d’installation. `--json` fournit versions actuelle, disponible et installée. `installation show` indique aussi la cible native, dont la variante musl ou glibc sous Linux. `/native-install` permet de migrer depuis une installation existante et donne les consignes PATH et de retrait de l’ancien gestionnaire. Les gestionnaires restent responsables de leurs propres mises à jour.

Les versions se trouvent dans `<configuration>/installation/versions/<version>`. Le lanceur est dans le sous-dossier `bin` : lien atomique sur les systèmes POSIX, fichier `.cmd` remplacé atomiquement sous Windows. Ajouter ce dossier au PATH selon les consignes affichées. Aucune modification silencieuse du profil du shell ni aucun droit d’administrateur ne sont nécessaires. Une session garde son exécutable ; le prochain lancement utilise la version activée.

La maintenance démarre après trente secondes, attend une minute sans saisie et se répète toutes les heures. Elle garde au moins les deux versions les plus récentes, le lanceur actif et toutes les versions retenues par un verrou d’usage. Les verrous noyau empêchent deux processus de télécharger la même version simultanément. `--force` recontrôle un nouveau téléchargement ; un exécutable identique reste immuable, un contenu différent pour la même version est refusé.

Les réglages `updates.automatic.enabled`, `updates.channel`, `updates.minimumAllowedVersion` et `maintenance.keepVersions` pilotent ces opérations. Le canal et les restrictions gérés priment. La variable de l’identité `NO_AUTO_UPDATES` désactive les installations automatiques, mais conserve le contrôle du minimum. Le maximum des minimums géré, publié et déjà mémorisé est appliqué, y compris sans réseau. Sans premier manifeste reçu, seul le minimum connu localement peut être contrôlé ; un avertissement explique l’échec réseau.

Le premier lancement interactif configuré vérifie sans identifiant l’accessibilité des services et les droits d’écriture de la configuration. Ces sondes sont bornées à trois secondes et ne bloquent pas l’accueil en cas d’échec. Elles donnent les variables de mandataire et d’autorité de certification à vérifier. Le diagnostic signale également plusieurs exemplaires trouvés sur le PATH.

## Contrat de publication

Le service HTTPS de l’identité expose `v1/stable.json`, `v1/latest.json` et `v1/<version>.json` :

```json
{"schemaVersion":1,"version":"1.2.3","minimumAllowedVersion":"1.0.0","notes":"Notes de version","artifacts":{"windows-x64":{"url":"artifacts/program.exe","sha256":"empreinte SHA-256 minuscule de 64 caractères","size":12345,"signature":"platform"}}}
```

Les cibles sont `windows-x64`, `windows-arm64`, `macos-x64`, `macos-arm64`, `linux-x64-glibc`, `linux-arm64-glibc`, `linux-x64-musl` et `linux-arm64-musl`. Les artefacts restent sur la même origine HTTPS, sans redirection, identifiant ou chaîne de requête. Taille maximale : 512 Mio ; manifeste JSON : 128 Kio. `signature: "platform"` exige une signature Authenticode valide sous Windows ou la vérification système sous macOS ; une valeur inconnue est refusée. Les builds de développement non signés emploient uniquement l’empreinte. La signature de production et l’hébergement restent à organiser.

Pour le script POSIX, publier aussi `v1/<cible>-<plateforme>.txt`, quatre lignes terminées par un saut de ligne : version, empreinte, taille décimale et URL HTTPS absolue de l’artefact. Cette représentation évite d’exiger un interpréteur JSON supplémentaire. Le script ne vérifie pas encore la signature macOS, qui reste contrôlée lors de l’installation finale si le manifeste JSON l’exige. PowerShell contrôle la signature avant le premier démarrage si elle est déclarée.

Les versions dont le numéro majeur est supérieur ou égal à 900000 sont réservées et refusées.
