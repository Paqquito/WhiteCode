# Canal de politique du profil macOS

## Format de déploiement

Le domaine est **`MANAGED_POLICY_DOMAIN`**, dérivé du `PRODUCT_BUNDLE_ID` de l'identité compilée. Aucun paramètre utilisateur, option ou variable d'environnement ne le remplace. Le domaine et les chemins de fichiers restent propres à la distribution.

La préférence **`Policy`** contient une **chaîne JSON ou JSONC**, limitée à **1 Mio de données UTF-8**. Un dictionnaire de préférences, un nombre ou une chaîne contenant un caractère nul sont refusés.

L'administrateur place cette clé dans les préférences **imposées** de son profil. Voici un fragment de la charge utile `com.apple.ManagedClient.preferences`, à intégrer à un profil possédant ses propres identifiants et à déployer par l'administration du poste. Remplacer `DOMAINE_COMPILE` par le domaine de la distribution :

```xml
<key>PayloadContent</key>
<dict>
  <key>DOMAINE_COMPILE</key>
  <dict>
    <key>Forced</key>
    <array>
      <dict>
        <key>mcx_preference_settings</key>
        <dict>
          <key>Policy</key>
          <string>{"permissions":{"disableUnrestrictedMode":true},"ui":{"history":{"maxEntries":500}}}</string>
        </dict>
      </dict>
    </array>
  </dict>
</dict>
```

Les sections `Set-Once` et les préférences ordinaires de l'utilisateur ne fournissent pas ce canal géré. Le produit ne pose ni ne retire de profil et ne change aucun droit système.

## Lecture, priorité et suspension

Le lecteur utilise Core Foundation depuis `src/platform/`, par le chemin système absolu du framework. Il synchronise les préférences avant chaque contrôle, vérifie leur caractère imposé avant et après la copie, puis contrôle le type, la taille et l'encodage. Aucun shell ni lecteur direct de fichier de préférences n'intervient. Une erreur de liaison, de synchronisation ou de lecture devient une erreur de politique ; une source détectée puis devenue invérifiable ne provoque jamais de repli silencieux vers le fichier.

Le profil suit le fichier `policy.json` dans la portée `managed`. Les scalaires du profil sont prioritaires ; les listes et objets suivent les règles de fusion des paramètres. Les valeurs effectives restent imposées par l'organisation et en lecture seule dans `/preferences`. `config validate --json` et `/diagnose` exposent le domaine et les problèmes du canal sans réparation automatique.

La validation sémantique est commune au fichier, au registre et au profil : politique obligatoire validée comme ensemble, préférence facultative invalide écartée avec avertissement. Le profil reste indépendant de l'ancrage du fichier ; un ancrage limité aux sessions distantes ne retire pas les restrictions globales du profil.

Les préférences facultatives se rechargent avant la requête suivante. Une modification, disparition ou corruption des contrôles obligatoires suspend la session jusqu'au redémarrage. La garde est réévaluée après une réponse de modèle et après une approbation, avant l'effet de l'outil. Pour maintenir la politique obligatoire après redémarrage, configurez une [inscription](inscription.md).
