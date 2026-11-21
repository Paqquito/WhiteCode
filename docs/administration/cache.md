# Cache de politique autorisé hors ligne

WhiteCode vérifie la copie locale d’une politique distante à partir de l’autorisation déployée par l’administrateur. Si la politique contient du code ou modifie l’environnement, le [consentement de l’utilisateur](consentement.md) est aussi nécessaire.

L'administrateur provisionne l'autorisation et les octets en cache hors bande. Les sources locales obligatoires de l'inscription ou de la distribution restent requises indépendamment de cette copie.

## Formats et emplacements

La copie `remote-policy-cache.json` se trouve dans le dossier de configuration utilisateur calculé au lancement. Ce transport peut appartenir à l'utilisateur : son autorité vient de l'empreinte indépendante de tous ses octets. Un cache sans autorisation administrative n'est pas appliqué et n'invente aucune obligation sur une installation personnelle.

L'enveloppe est du JSON strict, sans clé dupliquée, commentaire ni champ supplémentaire :

```json
{
  "schemaVersion": 1,
  "organizationId": "organisation-exemple",
  "perimeter": "all",
  "settings": "{\"permissions\":{\"denyRules\":[\"read_file(/confidentiel.txt)\"]},\"ui\":{\"history\":{\"maxEntries\":777}}}"
}
```

`settings` est une chaîne JSON/JSONC validée selon les règles des paramètres gérés. Les clés du catalogue mises en œuvre et admises en portée gérée sont prises en charge, avec accord pour les contenus sensibles. Une catégorie inconnue hors de `ui.`, `permissions.` et `policy.` fait refuser la version entière. Une règle obligatoire invalide invalide également l'ensemble ; une préférence facultative invalide conserve le comportement de validation partielle.

L'autorisation `cache-authorization.json` se trouve à côté du `policy.json` système de l'identité compilée, dans `MANAGED_DIR_WINDOWS`, `MANAGED_DIR_MACOS` ou `MANAGED_DIR_LINUX`. Son fichier et tous ses parents doivent satisfaire [les protections natives](protection.md). Le programme ne crée pas cette autorisation, ne change pas ses droits et ne réalise aucune élévation.

```json
{
  "schemaVersion": 1,
  "organizationId": "organisation-exemple",
  "perimeter": "all",
  "cacheSha256": "REMPLACER_PAR_LES_64_CARACTERES_HEXADECIMAUX_MINUSCULES_CALCULES",
  "offlineAllowed": true,
  "validFrom": "2026-10-09T11:00:00.000Z",
  "validUntil": "2026-10-09T13:00:00.000Z",
  "revoked": false
}
```

L'empreinte illustrée est volontairement invalide et les dates sont des exemples à remplacer par les bornes décidées pour le déploiement. Les huit champs sont obligatoires, sans ajout ni doublon. L'organisation respecte le format de l'[inscription administrative](inscription.md). Si une inscription ou un ancrage compilé existe, l'organisation doit être identique. L'autorisation de cache ne retire aucune autre source requise et ne remplace pas l'empreinte du fichier système.

Le périmètre vaut `all` pour toutes les capacités d'agent, ou `remote` pour les capacités distantes définies par [l’ancrage de distribution](ancrage.md). Il doit être identique dans les deux documents. Une autorisation détectée mais malformée, modifiable ou invérifiable impose un refus global, même si elle prétend déclarer `remote`.

Les bornes sont des instants UTC canoniques avec millisecondes et `Z`. `validFrom` est inclus ; `validUntil` est exclu et doit être postérieur. `offlineAllowed` doit valoir explicitement `true`. `revoked: true` retire immédiatement l'autorisation. L'absence d'un champ, une heure invérifiable ou une période invalide ne devient pas une permission de continuer.

## Provisionnement et vérification

1. L'administrateur prépare les octets exacts de l'enveloppe et calcule leur SHA-256, par exemple :

   ```powershell
   (Get-FileHash -LiteralPath './remote-policy-cache.json' -Algorithm SHA256).Hash.ToLowerInvariant()
   ```

2. Il remplit l'autorisation avec cette empreinte, l'organisation, le périmètre et les conditions de validité, puis la déploie dans le dossier système protégé.
3. Il fait placer les octets autorisés sous `remote-policy-cache.json` dans le dossier utilisateur. Une remise en forme ou un changement des fins de ligne modifie l'empreinte et exige une nouvelle autorisation.
4. L'utilisateur redémarre, puis vérifie `/preferences`, `/diagnose` et `config validate --scope managed --json`. La copie distante valide a la priorité sur les préférences du fichier système, du registre ou du profil. Les invariants de fusion des restrictions restent actifs.

La copie et l'autorisation sont limitées chacune à 1 Mio et doivent être des fichiers ordinaires sans lien. Les objets ouverts sont contrôlés avant et après lecture. La copie utilisateur ne fournit jamais sa propre preuve de confiance ; l'autorisation est relue avant de rendre ses paramètres disponibles.

## Perte d'autorisation et récupération

Une copie d'une autre organisation ou d'un autre périmètre, altérée, absente, expirée ou révoquée est rejetée. Les capacités encadrées sont bloquées en code 4 avant modèle, crochet, extension ou ouverture réseau. Les fonctions locales restent disponibles si l'autorité valide désigne seulement `remote`, sans appliquer de nouvelles préférences d'une copie rejetée.

La vérification est renouvelée avant les actions, y compris après une réponse du modèle ou une attente d'approbation, même sans changement du fichier. Une réparation ne reprend pas la session suspendue : l'administrateur vérifie ou renouvelle l'autorisation, remet les octets autorisés en place, puis l'utilisateur redémarre. Le programme ne poursuit pas avec une ancienne copie qui aurait perdu son autorisation.

L'aide et le diagnostic local minimal restent accessibles. `config validate` expose les erreurs en code 2. `config recover-policy` vérifie uniquement la politique du fichier système ; la remise en place du cache suit la procédure administrative ci-dessus.
