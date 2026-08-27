-- Prestō marketplace schema
-- Run against a PostgreSQL database with the PostGIS extension available.

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------
-- Users (both clients and providers share this table; role decides UI)
-- ---------------------------------------------------------------
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role              TEXT NOT NULL CHECK (role IN ('client', 'provider', 'admin')),
  email             TEXT UNIQUE NOT NULL,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  preferred_lang    TEXT NOT NULL DEFAULT 'en' CHECK (preferred_lang IN ('en','es','fr','pt','de')),
  wallet_credit_cents INTEGER NOT NULL DEFAULT 0, -- credited automatically on no-show refunds
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Service categories (seed data — extend freely)
-- ---------------------------------------------------------------
CREATE TABLE service_categories (
  id                TEXT PRIMARY KEY,       -- e.g. 'handyman', 'furniture', 'dog', 'garden', 'delivery', 'cleaning'
  label_fr          TEXT NOT NULL,
  label_en          TEXT NOT NULL,
  label_es          TEXT NOT NULL,
  label_pt          TEXT NOT NULL,
  label_de          TEXT NOT NULL
);

INSERT INTO service_categories (id, label_fr, label_en, label_es, label_pt, label_de) VALUES
  ('handyman',  'Bricolage',        'Handyman',           'Bricolaje',        'Reparos',            'Handwerker'),
  ('furniture', 'Montage meubles',  'Furniture assembly',  'Montaje de muebles','Montagem de móveis', 'Möbelmontage'),
  ('dog',       'Promenade chien',  'Dog walking',         'Paseo de perros',  'Passeio com cães',   'Hundespaziergang'),
  ('garden',    'Jardinage',        'Gardening help',      'Jardinería',       'Jardinagem',          'Gartenhilfe'),
  ('delivery',  'Livraison locale', 'Local delivery',      'Entrega local',    'Entrega local',       'Lokale Lieferung'),
  ('cleaning',  'Ménage',           'Cleaning',            'Limpieza',         'Limpeza',              'Reinigung'),
  ('roofing',   'Couverture',       'Roofing',             'Techado',          'Telhado',              'Dacharbeiten');

-- ---------------------------------------------------------------
-- Provider profiles
-- ---------------------------------------------------------------
CREATE TABLE provider_profiles (
  user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  category_id             TEXT NOT NULL REFERENCES service_categories(id),
  base_price_cents        INTEGER NOT NULL,          -- price shown before booking, in cents
  currency                TEXT NOT NULL DEFAULT 'USD', -- launching in the US first; expand per-country later
  bio                     TEXT,
  years_experience        INTEGER DEFAULT 0,
  service_radius_km       NUMERIC DEFAULT 10,
  location                GEOGRAPHY(POINT, 4326),     -- current/base location, PostGIS
  us_state                TEXT,                        -- 2-letter US state code, e.g. 'NY' — resolved server-side via a geocoder
  is_available_now        BOOLEAN NOT NULL DEFAULT false,
  availability_updated_at TIMESTAMPTZ,
  identity_status         TEXT NOT NULL DEFAULT 'unverified'
                             CHECK (identity_status IN ('unverified','pending','verified','rejected')),
  stripe_account_id       TEXT,                       -- Stripe Connect connected account id
  stripe_account_ready    BOOLEAN NOT NULL DEFAULT false, -- payouts_enabled from Stripe
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_location_idx ON provider_profiles USING GIST (location);
CREATE INDEX provider_category_idx ON provider_profiles (category_id);

-- ---------------------------------------------------------------
-- Reviews (aggregate rating is computed, not stored redundantly here;
-- add a materialized view or trigger-maintained column if read load is high)
-- ---------------------------------------------------------------
CREATE TABLE reviews (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id   UUID NOT NULL,
  provider_id  UUID NOT NULL REFERENCES users(id),
  client_id    UUID NOT NULL REFERENCES users(id),
  rating       SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------
CREATE TABLE bookings (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id             UUID NOT NULL REFERENCES users(id),
  provider_id           UUID NOT NULL REFERENCES users(id),
  category_id           TEXT NOT NULL REFERENCES service_categories(id),
  address_text          TEXT NOT NULL,
  location               GEOGRAPHY(POINT, 4326),
  base_price_cents      INTEGER NOT NULL,     -- snapshot of price at booking time (price shown before booking)
  service_fee_cents     INTEGER NOT NULL,
  total_price_cents     INTEGER NOT NULL,
  currency              TEXT NOT NULL DEFAULT 'USD', -- launching in the US first; expand per-country later
  status                TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','confirmed','on_the_way','arrived','completed','cancelled','cancelled_no_show')),
  price_locked          BOOLEAN NOT NULL DEFAULT true, -- price shown at booking is contractual; see price_adjustment_* below
  no_show_grace_at      TIMESTAMPTZ,                     -- if still 'confirmed' past this time, client can report a no-show for auto-refund
  price_adjustment_status TEXT CHECK (price_adjustment_status IN ('none','pending','accepted','declined')) DEFAULT 'none',
  price_adjustment_cents  INTEGER,                        -- extra amount the provider is requesting, must be client-approved
  price_adjustment_reason TEXT,
  stripe_payment_intent_id TEXT,
  stripe_transfer_id       TEXT,               -- transfer to provider's connected account once completed
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bookings_client_idx ON bookings (client_id);
CREATE INDEX bookings_provider_idx ON bookings (provider_id);

-- ---------------------------------------------------------------
-- Chat
-- ---------------------------------------------------------------
CREATE TABLE conversations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES users(id),
  content         TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX messages_conversation_idx ON messages (conversation_id, sent_at);

-- ---------------------------------------------------------------
-- Live location pings while a booking is active (rotate/prune old rows,
-- or move this to Redis if write volume gets high)
-- ---------------------------------------------------------------
CREATE TABLE provider_location_pings (
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  location     GEOGRAPHY(POINT, 4326) NOT NULL,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ping_booking_idx ON provider_location_pings (booking_id, recorded_at DESC);
