# Agrégateur de presse — PWA

Application web installable sur iPhone : lecture des flux RSS du panel, tri manuel (orientation + usage, domaines multiples), export de notes `.md` pour Obsidian.


## Installer sur l'iPhone

1. Ouvrir l'adresse dans **Safari**.
2. Bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.
3. Ouvrir l'application depuis l'icône **Presse**.
4. Onglet **Réglages** → Proxy : saisir `https://nom.compte.workers.dev/?url=` → **Enregistrer** → **Tester**.

## Utilisation

- **À trier** : « Actualiser » charge les flux activés des domaines actifs. « Rejeter » classe en un geste ; « Trier » ouvre la fiche : domaines (plusieurs possibles), orientation (neutre / orienté + sens), usage (rejeter / archiver / thèse à approfondir / thèse retenue), résumé dans vos mots, thèses séparées par `;`.
- **Classés** : revoir et modifier (un tri reste révisable).
- **Export** : partage des notes `.md` (ou archive ZIP) → « Enregistrer dans Fichiers » → dossier du coffre Obsidian. Les rejetés ne sont pas exportés. Une note modifiée repasse en « non exportée ».
- **Réglages** : proxy, domaines actifs, mots-clés exclus, durée de conservation, activation flux par flux (les flux « à confirmer » sont désactivés par défaut), ajout de flux personnels, état du dernier chargement de chaque flux.

## Format des notes

Une note source par article, nommée `AAAA-MM-JJ Titre.md` :

```yaml
---
type: source
titre: "…"
media: "Le Monde"
rubrique: "International"
date: 2026-11-08
url: "https://…"
domaines: [relations-internationales, economie]
orientation: neutre
sens: ""
usage: these-a-approfondir
theses: ["[[Fragmentation des chaînes de valeur]]"]
tri: 2026-11-08
tags: [source/presse]
---
```

Le corps contient votre résumé et les liens `[[thèse]]`. Le chapeau fourni par le flux n'est pas exporté.

## Limites connues

- Données stockées dans l'application (stockage local de Safari, environ 5 Mo). Utiliser **Export → Sauvegarde** régulièrement. Supprimer l'application de l'écran d'accueil efface ses données.
- Pas d'actualisation en arrière-plan : les flux sont chargés à l'ouverture, sur demande.
- Certains sites peuvent refuser les requêtes provenant de serveurs Cloudflare ou d'un proxy public ; l'erreur est alors affichée dans Réglages, flux par flux.
- Les flux n'ont pas été testés à travers le proxy lors de la conception (pas d'accès réseau dans l'environnement de développement).
