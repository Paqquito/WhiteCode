# Inscription administrative et récupération de politique

L'administrateur déploie un fichier protégé `enrollment.json`, à côté du `policy.json` système désigné par l'identité compilée. Cette inscription conserve l'obligation lorsque la politique est absente, y compris après un redémarrage ou avant sa première réception. Elle ne demande aucune clé de service de modèle.

## Préparer l'inscription

L'administrateur choisit l'identifiant de l'organisation et les octets exacts de sa politique locale autorisée, puis calcule leur SHA-256. Exemple de calcul sur une copie locale, en lecture seule :

```powershell
(Get-FileHash -LiteralPath './politique-autorisee.json' -Algorithm SHA256).Hash.ToLowerInvariant()
```

Le document d'inscription est du JSON strict, sans commentaires, sans clé dupliquée et sans autre champ :

```json
{
  "schemaVersion": 1,
  "organizationId": "organisation-exemple",
  "policySha256": "REMPLACER_PAR_LES_64_CARACTERES_HEXADECIMAUX_MINUSCULES_CALCULES"
}
```

La valeur illustrée de `policySha256` est à remplacer avant déploiement ; elle est volontairement invalide. L'identifiant commence par une lettre ou un chiffre ASCII, suivi de lettres, chiffres, points, tirets ou traits de soulignement, dans une limite de 128 caractères. L'empreinte autorise les octets exacts : un commentaire, un changement de fins de ligne ou une remise en forme de la politique la modifie.

L'emplacement est le dossier `MANAGED_DIR_WINDOWS`, `MANAGED_DIR_MACOS` ou `MANAGED_DIR_LINUX` de la distribution. Aucun paramètre utilisateur, variable d'environnement ou argument ne remplace cet emplacement ou l'autorité. L'administrateur protège le fichier d'inscription et tous ses parents selon [protection.md](protection.md), puis peut installer les octets autorisés sous `policy.json`. Le programme ne crée pas l'inscription, ne change pas les ACL et ne réalise aucune élévation.

Une distribution personnelle peut ainsi recevoir une inscription administrative sans recompilation. Si la distribution contient déjà `policyAnchor`, l'organisation et l'empreinte doivent être identiques, et cet ancrage doit omettre `perimeter`. Toute contradiction bloque ; un ancrage distant ne peut pas être remplacé par cette inscription. Le périmètre de ce format est inconnu : l'absence d'une version valide bloque toutes les fonctions d'agent.

## Premier lancement et suppression de la politique

Avec l'inscription valide mais sans politique autorisée, le lancement d'une session échoue en code 4 avant le modèle, les extensions, les crochets ou l'ouverture d'un service réseau. L'aide reste disponible en code 0. `/diagnose` et `diagnostic validate` affichent le diagnostic minimal local en code 4 ; `config validate --scope managed --json` expose les erreurs en code 2. La configuration utilisateur ou du projet ne retire pas l'obligation.

Une inscription malformée, modifiable, illisible, ambiguë ou dont la protection est invérifiable bloque également. Les fichiers ordinaires, la limite de 1 Mio, l'absence de liens et la stabilité de la lecture sont contrôlés. Une installation personnelle sans inscription détectée ni autre ancrage n'invente aucune obligation.

## Récupérer une version autorisée

Obtenir auprès de l'administrateur une copie des octets autorisés, puis lancer, avec l'exécutable de la distribution :

```powershell
& './dist/whitecode.exe' config recover-policy './politique-autorisee.json' --json
```

La vérification fonctionne lorsque les fonctions d'agent sont bloquées. Elle exige une autorité indépendante valide, compare l'empreinte exacte et valide l'ensemble des règles obligatoires. Elle ne considère ni l'emplacement ni le propriétaire de la copie candidate comme une autorité et n'applique aucun paramètre de cette copie.

En cas de réussite, le code est 0 et le rapport contient `verified: true`, `requiresAdministrativeInstall: true`, l'organisation, l'empreinte et `destination`. Aucun fichier système n'est modifié. Faire remettre les octets vérifiés à cette destination par l'administrateur, avec les protections requises, puis redémarrer. Une copie altérée ou invalide, une inscription refusée ou l'absence d'autorité produit le code 4 ; un argument manquant produit le code 2.

Le changement ou la suppression de l'inscription pendant une session suspend les actions suivantes, y compris après une réponse ou une approbation en attente. Remettre l'inscription d'origine ne reprend pas la session suspendue : redémarrer pour recomposer les contrôles. Seule sa mise en forme peut changer sans modifier l'autorité. Une nouvelle empreinte doit être autorisée administrativement ; si un ancrage compilé est aussi présent, il doit rester cohérent.

## Autres modes de déploiement

- [Ancrer la politique dans une distribution](ancrage.md)
- [Déployer une politique par le registre Windows](registre-windows.md) ou [par un profil macOS](profil-macos.md)
- [Autoriser le cache hors ligne](cache.md) et [configurer le consentement](consentement.md)
- [Configurer les services d’une organisation](services.md)
