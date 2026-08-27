# Prestō — Backend API

Backend Node.js/Express pour la marketplace de prestataires locaux : comptes, recherche géo, réservations, paiement (Stripe Connect), vérification d'identité (Stripe Identity), chat et suivi en direct (Socket.IO).

C'est un **squelette prêt à compléter**, pas un produit fini : la logique métier centrale est là et fonctionne, mais un développeur doit encore ajouter la gestion d'erreurs exhaustive, les tests, la pagination, le rate-limiting, etc. avant une mise en production réelle.

## 1. Installer

```bash
npm install
cp .env.example .env   # puis remplir les vraies valeurs (Stripe, base de données...)
```

Vous aurez besoin de :
- Une base **PostgreSQL** avec l'extension **PostGIS** activée (Supabase, Neon, Amazon RDS avec PostGIS, ou Postgres local).
- Un compte **Stripe** (mode test pour commencer) → clé API sur https://dashboard.stripe.com/apikeys
- Un compte **Twilio** si vous voulez les SMS (optionnel pour démarrer).

## 2. Créer les tables

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

## 3. Lancer en local

```bash
npm run dev
# API disponible sur http://localhost:4000
```

## 4. Webhook Stripe (indispensable)

Le paiement et la vérification d'identité sont confirmés de façon **asynchrone** par Stripe via webhook (`/api/payments/webhook`) — c'est ce qui met à jour le statut de la réservation et le badge "identité vérifiée" en base. En local, utilisez le CLI Stripe :

```bash
stripe listen --forward-to localhost:4000/api/payments/webhook
```

En production, configurez l'URL du webhook dans le dashboard Stripe.

## 5. Endpoints principaux (et l'écran du prototype qui les utilise)

| Endpoint | Écran correspondant dans le prototype |
|---|---|
| `POST /api/auth/signup` / `/login` | Création de compte / connexion (à ajouter à l'app) |
| `GET /api/providers?lat=&lng=&category=&onlyAvailable=` | Écran d'accueil (tableau de disponibilités) + liste filtrée |
| `GET /api/providers/:id` | Fiche prestataire |
| `PATCH /api/providers/me/availability` | Toggle "disponible maintenant" côté app prestataire |
| `POST /api/providers/me/stripe-onboarding-link` | Écran d'inscription prestataire → redirige vers Stripe pour être payé |
| `POST /api/auth/identity-verification-session` | Déclenche la vérification d'identité réelle (scan pièce + selfie) |
| `POST /api/bookings` | Bouton "Réserver" |
| `POST /api/payments/create-intent` | Étape de paiement juste après la création de la réservation |
| `PATCH /api/bookings/:id/status` | Le prestataire fait avancer confirmé → en route → arrivé → terminé |
| `POST /api/bookings/:id/location` | Ping GPS envoyé par l'app prestataire pendant "en route" |
| `GET/POST /api/bookings/:id/messages` | Écran de chat |
| Socket.IO `booking:status`, `booking:location`, `message:new` | Mises à jour en direct sur l'écran de suivi et le chat |

## 6. Déploiement

- **API** : Railway, Render, Fly.io ou AWS (ECS/Elastic Beanstalk) — toutes gèrent bien Node.js + Postgres.
- **Base de données** : Supabase ou Neon (Postgres managé avec PostGIS déjà activable) simplifient beaucoup le démarrage.
- Pensez à passer `CORS_ORIGIN` et les clés Stripe en **mode production** (`sk_live_...`) uniquement une fois les tests terminés en mode test (`sk_test_...`).

## 7. Ce qu'il reste à faire avant un vrai lancement commercial

- Rate limiting et validation plus stricte sur toutes les routes.
- Gestion des remboursements/litiges (annulation côté client, no-show prestataire).
- File d'attente (Redis/BullMQ) pour les notifications SMS/push au lieu d'appels synchrones.
- Tests automatisés (au minimum sur la création de réservation et le calcul de prix/commission).
- Politique de rétention et suppression des données personnelles (RGPD).
