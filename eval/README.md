# Évaluer un modèle avec WhiteCode

Les scénarios de [la suite](suite.json) mesurent le comportement de l’assistant sur des dépôts d’essai. Configurez le fournisseur et le modèle à évaluer, puis lancez la commande depuis la racine du moteur.

```sh
bun scripts/eval.ts --suite eval/suite.json --family generic --report build/eval-report.json
```

Chaque scénario contient une consigne, des autorisations, des vérifications et un dossier `repo/`. L’évaluation travaille sur une copie neuve à chaque essai. L’exécuteur répète chaque scénario cinq fois avec le fournisseur configuré. Le rapport JSON rassemble les résultats. Les tests de l’exécuteur utilisent un fournisseur simulé.
