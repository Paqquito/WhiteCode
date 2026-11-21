# Connecteurs HTTP et SSE

Un connecteur distant peut utiliser HTTP ou SSE. Si le serveur demande une authentification, ouvrez `/connectors` et suivez les [instructions d’autorisation](connecteurs-autorisation.md).

Dans le fichier utilisateur `connectors.json` du dossier de configuration de votre identité, déclarer un serveur :

```json
{
  "servers": {
    "service-interne": {
      "transport": "http",
      "url": "https://service.example.invalid/mcp",
      "timeout": 10000
    }
  }
}
```

Remplacer l’URL par celle du service choisi. `timeout` est en millisecondes et concerne la connexion et les requêtes de ce connecteur. Pour un service demandant un en-tête statique, ajouter `"headers": { "Authorization": "Bearer ${CONNECTOR_TOKEN}" }` et fournir soi-même cette variable dans le terminal de lancement. Conserver le jeton hors du fichier et du dépôt. Aucun jeton ni serveur n’est fourni par le produit. `headersCommand` est refusé explicitement dans cette version.

Démarrer une session avec `--wait-for-mcp`, puis consulter `/connectors`, appeler un outil publié et vérifier son résultat. Les déclarations de projet conservent leur approbation préalable. Une déclaration modifiée est prise en compte à la session suivante. Une variable manquante donne une erreur de configuration.

Pour un ancien serveur à événements séparés, utiliser `"transport": "sse"` avec l’adresse de son canal SSE. Les réponses fragmentées UTF-8 et les événements multilignes sont acceptés. Si un flux coupé fournit un identifiant d’événement, le client tente de le reprendre sans renvoyer le POST de l’outil ; sinon il applique la reconnexion existante. La session HTTP est fermée à la sortie lorsque le serveur la propose.

HTTPS est obligatoire à distance. HTTP est accepté uniquement pour `localhost`, `127.0.0.1` et `[::1]`. Les identifiants et fragments d’URL sont refusés. En-têtes et redirections restent dans la même origine : hôte, schéma et port. Proxy, autorités et certificat client sont ceux des paramètres réseau du produit, avec vérification TLS conservée. Une erreur n’affiche pas le corps du serveur ni les paramètres d’URL.

Les textes des résultats, descriptions et titres masquent les valeurs des en-têtes déclarés, les identifiants de session et les paramètres d’URL connus. Les discriminants du protocole et les contrats de routage/schéma restent intacts ; les données de `structuredContent`, clés comprises, sont masquées. Le remplacement parcourt le texte d’origine une seule fois ; résultat limité à 8 Mio après masquage.

Protocole de référence : [transport HTTP courant](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), [cycle de vie](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), [transport SSE historique](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports).
