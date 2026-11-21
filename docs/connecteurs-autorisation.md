# Connecteurs : autorisation et administration

Déclarez un serveur HTTPS avec `connector add docs --scope user --transport http -- https://adresse-du-serveur/mcp`. `connector list --json` inspecte les déclarations sans connexion ; l’état `pending` signifie qu’aucune sonde n’a été faite. `connector validate docs --json` initialise réellement le serveur et découvre ses outils, ressources et invites. Les commentaires JSONC restent conservés lors des modifications.

Dans une session interactive, `/connectors sign-in docs` lance l’autorisation après votre confirmation. Le modèle peut aussi proposer l’outil `connector_sign_in`, qui déclenche le même dialogue humain. Saisissez vos identifiants uniquement dans le navigateur du service. Le retour d’autorisation passe par une adresse sur la boucle locale, avec PKCE S256 et contrôle de l’état. Si le navigateur ne s’ouvre pas, copiez l’adresse affichée, puis collez l’URL complète du retour dans le tampon masqué. La variable propre `NO_BROWSER` active ce parcours manuel. Aucune clé ou réponse de formulaire n’entre dans l’historique destiné au modèle.

Le serveur doit publier ses métadonnées selon la [spécification d’autorisation MCP](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization). Sans enregistrement dynamique, déclarez `oauth.clientId`. Un éventuel `clientSecret` doit être une référence `${VARIABLE}` ; aucun secret littéral n’est accepté dans ce champ. Le trousseau système doit être disponible. Les jetons sont isolés par profil et connecteur ; leur renouvellement n’exige pas de nouvel échange humain. `/connectors sign-out docs` retire uniquement l’autorisation de ce serveur. `/connectors disable docs` persiste une désactivation propre au projet ; `/connectors enable docs` le reconnecte.

`headersCommand` reçoit un objet JSON avec le nom et l’URL du serveur sur son entrée standard et renvoie un objet d’en-têtes textuels. Les en-têtes dynamiques priment sur les statiques ; le jeton OAuth prime sur leur champ Authorization. `mcp.headersCommandTtl` règle leur cache, `mcp.headersCommandTimeout` leur délai. La sortie est bornée et aucune erreur ne publie le texte du programme. Les règles de permissions et la confiance du projet s’appliquent avant le démarrage de ces programmes.

Une demande de formulaire identifie le connecteur, recueille les champs dans un tampon masqué, refuse les valeurs invalides localement et demande une revue avant envoi. Les valeurs par défaut fournies par le serveur ne sont jamais préremplies. En automatisé, une demande sans réponse de crochet valide reçoit `cancel`. Les formulaires suivent la [spécification d’élicitation MCP](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation). Les objets imbriqués et les schémas non pris en charge sont refusés. Les saisies restent des données du serveur et ne peuvent accorder des permissions supplémentaires.

## Utiliser le fournisseur d’identité de l’organisation

L'objet `mcp.identityProvider` est accepté uniquement dans la portée gérée. Ses valeurs sont masquées dans les diagnostics. Adaptez cet exemple à votre fournisseur d’identité.

```json
{
  "mcp": {
    "identityProvider": {
      "issuer": "https://identity.example.test/organization",
      "clientId": "organization-client",
      "clientSecret": "${ORGANIZATION_CLIENT_SECRET}",
      "allowOAuthFallback": false,
      "connectors": [
        {
          "name": "documentation",
          "resource": "https://resources.example.test/documentation",
          "authorizationServer": "https://authorization.example.test/organization",
          "clientId": "documentation-client",
          "clientSecret": "${DOCUMENTATION_CLIENT_SECRET}",
          "scopes": ["documentation.read"]
        }
      ]
    }
  }
}
```

`callbackPort` est facultatif ; sinon le récepteur local utilise un port libre. Les clients doivent être enregistrés avec les adresses de retour locales appropriées. La correspondance entre le client du fournisseur et le client de la ressource doit être préalablement configurée côté fournisseur d'identité. Le produit n'invente aucun paramètre de protocole pour créer cette correspondance.
