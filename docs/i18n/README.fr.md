# OpenChamber Kubernetes Explorer

[English](../../README.md) | [简体中文](README.zh-CN.md) | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | Français | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

Une extension Kubernetes pour OpenChamber. Parcourez les clusters, diagnostiquez les problèmes des charges de travail et effectuez les opérations Kubernetes courantes sans quitter l’espace de travail de votre projet.

## Captures d’écran

Aperçus de l’interface de bureau avec des données fictives. Aucune connexion à un cluster ni aucune opération n’a été effectuée. Cliquez sur une capture pour l’afficher en taille réelle.

| Explorateur de ressources | Détails de la ressource |
| --- | --- |
| [![Arborescence déployée avec l’état des charges de travail et les ressources personnalisées](../screenshots/explorer.png)](../screenshots/explorer.png) | [![Deployment sélectionné à côté de son manifeste YAML](../screenshots/resource-details.png)](../screenshots/resource-details.png) |
| **Terminal du conteneur** | **Redirection de ports** |
| [![Pod et conteneur sélectionnés avec un exemple de sortie du terminal](../screenshots/terminal.png)](../screenshots/terminal.png) | [![Service sélectionné avec la correspondance 8080:80 avant le démarrage de la redirection](../screenshots/port-forward.png)](../screenshots/port-forward.png) |

## Installation

Une fois les fichiers précompilés de l’extension publiés sur la branche par défaut du dépôt :

1. Dans OpenChamber, ouvrez **Paramètres → Extensions**.
2. Collez l’URL du dépôt dans **Dossier, ZIP ou URL**, puis cliquez sur **Ajouter** :

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. Vérifiez et autorisez la capacité de service local demandée, puis ouvrez **Kubernetes** depuis la barre des extensions.

Aucune compilation locale ni installation de dépendances JavaScript n’est nécessaire. Tant que le dépôt est privé, OpenChamber Server doit déjà disposer d’identifiants Git lui permettant de le lire via HTTPS. Vous connecter à GitHub dans votre navigateur ne transmet pas ces identifiants au serveur.

La [version candidate vérifiée dans Docker](../status.md) fournit aussi une archive ZIP précompilée pour l’installation manuelle. L’installation par URL Git n’a pas encore été vérifiée.

## Prérequis

- **OpenChamber 2.5.1**, la version ciblée par cette extension.
- Un **kubeconfig** fonctionnel et accessible à l’utilisateur système qui exécute OpenChamber Server, un accès réseau à l’API Kubernetes et les autorisations nécessaires aux opérations souhaitées.
- **`kubectl`** doit être disponible sur le serveur. **Helm** est requis pour les opérations qui appellent sa CLI. Si le kubeconfig utilise un utilitaire d’authentification externe, celui-ci doit également être disponible sur le serveur. L’extension n’installe aucun de ces outils.

## Fonctionnalités

- Changer de contexte ou d’espace de noms Kubernetes et parcourir les charges de travail, les services et les ressources personnalisées dans une arborescence.
- Examiner les manifestes, lire les journaux des Pods et consulter les événements d’un espace de noms.
- Examiner les modifications des manifestes et les appliquer explicitement à la cible choisie.
- Ouvrir un terminal dans le conteneur choisi ou configurer une redirection de port.
- Parcourir les dépôts, les charts, les releases et l’historique des révisions Helm.

## Ce que l’auteur a testé

L’auteur n’a personnellement testé que quatre usages : déplier les listes de ressources dans l’arborescence, consulter les détails des ressources, utiliser le terminal d’un conteneur et configurer une redirection de port. Si vous avez une question ou rencontrez un problème avec un autre usage, n’hésitez pas à [ouvrir une issue sur GitHub](https://github.com/hlhr202/Openchamber-Kubernetes/issues).

## Confidentialité

- L’extension n’envoie aucune donnée de télémétrie ou d’analyse à ses développeurs. Elle utilise le kubeconfig côté serveur pour se connecter à l’API Kubernetes configurée avec vos autorisations existantes.
- Les données des ressources récupérées, les journaux, la sortie du terminal et les brouillons non enregistrés restent en mémoire et ne sont pas écrits sur disque. L’extension conserve des préférences non sensibles, comme le choix des sources kubeconfig, mais pas leur contenu. Un enregistrement ou un export explicite est une action distincte.
- Les valeurs des Secrets ne s’affichent que sur demande, selon vos autorisations Kubernetes. Les données du cluster ne sont pas envoyées automatiquement au chat ni à un fournisseur de modèles.

Cette déclaration concerne l’extension, et non OpenChamber, Kubernetes ou les outils et services externes que vous utilisez.

## Licence

[MIT](../../LICENSE). Les dépendances incluses conservent leurs licences respectives ; voir `THIRD_PARTY_NOTICES.txt` dans le paquet précompilé.

[Documentation du projet](../README.md) · [Périmètre fonctionnel](../product.md) · [Développement](../development.md)
