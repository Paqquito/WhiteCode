# Jeu d'évaluation du contrat de comportement

Socle du jeu d'évaluation (SPEC-MOT-045, décision D-06, écart E-014). Chaque scénario vit dans `scenarios/<identifiant>/` :

- `scenario.json` : identifiant, clauses couvertes, description, dépôt de départ (`repository`), consigne donnée à l'agent (`instruction`), options de lancement (mode de permission, règles `allow`, limite d'itérations) et vérifications ;
- `repo/` : dépôt de départ, copié dans un dossier neuf à chaque exécution.

Vérifications disponibles : `file_exists`, `file_absent`, `file_unchanged`, `file_contains`, `file_not_contains`, `no_new_files`, `result_matches` (expression, sans tenir compte de la casse), `result_not_contains`, `tool_called`, `command_run`, `no_repeated_call`, `halt_reason`.

Le produit est lancé en mode non interactif avec la sortie `jsonl`, cinq fois par scénario. Règle de diffusion : un scénario de C-01 à C-06 réussit sur 5 exécutions sur 5, tout autre sur au moins 4 sur 5 ; une première version doit atteindre 90 % de scénarios réussis, une version suivante le taux de la version diffusée, mesuré sur la même version du jeu, diminué au plus de deux points.

Exécution avec un vrai modèle (à la main ou chaque nuit), avec le fournisseur configuré dans vos paramètres utilisateur :

```bash
bun scripts/eval.ts --suite eval/suite.json --family generic --report build/eval-report.json
```

En intégration continue, l'exécuteur est testé avec le fournisseur simulé (`tests/evaluation.test.ts`).
