# Canal de politique du registre Windows

## Emplacement et format

L'administrateur déploie une valeur nommée **`Policy`**, de type **`REG_SZ`**, contenant un objet JSON ou JSONC. Elle se trouve sous **`HKLM\<MANAGED_REGISTRY_KEY>`**, dans la **vue 64 bits**. Le chemin provient de l'identité compilée ; aucune option ni variable de session ne le remplace. Les séparateurs consécutifs du chemin dérivé sont normalisés.

La valeur par défaut, `HKCU`, la vue 32 bits et les chaînes `REG_EXPAND_SZ` ne fournissent pas cette politique. Aucune variable d'environnement n'est interprétée. La taille maximale est de 1 Mio de données UTF-16, terminaison comprise.

Exemple de contenu à déployer par l'administrateur à l'emplacement propre à sa distribution :

```json
{
  "permissions": { "disableUnrestrictedMode": true },
  "ui": { "history": { "maxEntries": 500 } }
}
```

## Application et protection

Le registre est lu après le fichier système `policy.json`, dans la portée `managed`. Il remplace les valeurs scalaires en conflit ; les listes et objets suivent les règles de fusion des paramètres. La provenance expose les sources. La valeur effective reste imposée par l'organisation et en lecture seule dans `/preferences`.

L'ancrage de distribution continue d'authentifier le fichier qu'il désigne. Le registre est un canal système indépendant : ses restrictions ont un périmètre global. Un ancrage de fichier limité au distant ne rend pas bénigne une politique obligatoire de registre invalide.

Une clé ou valeur absente signifie l'absence de ce canal dans une installation personnelle. Un refus d'accès, un type incompatible, un contenu malformé ou une erreur du lecteur est signalé et ne provoque pas de repli silencieux vers le fichier. Sans moyen de garantir la politique, les fonctions d'agent sont bloquées en code 4 ; l'aide et le diagnostic minimal restent disponibles.

Le lecteur utilise le jeton Windows effectif. Un administrateur autorisé peut modifier la source. Pour un utilisateur non administrateur, il contrôle les droits permettant de modifier la valeur, créer des sous-clés, supprimer la clé ou modifier ses droits et son propriétaire, y compris sur les ancêtres. Une politique obligatoire modifiable est rejetée ; une source contenant seulement des préférences produit un avertissement demandant sa protection. Ces contrôles ne modifient aucune clé.

Le registre est relu avant les opérations contrôlées, sans cache temporel. Les changements de préférences sont adoptés avant la requête suivante. Une modification ou disparition des contrôles obligatoires suspend la session jusqu'au redémarrage. Pour rendre la politique obligatoire après redémarrage, configurez une [inscription administrative](inscription.md).

`config validate --json` et `/diagnose` présentent le canal, sans écriture ni correction automatique de cette source administrée.
