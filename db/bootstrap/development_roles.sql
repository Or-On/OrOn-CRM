-- Local-development role bootstrap. Schema changes remain Alembic-owned.
-- Passwords are fictional localhost-only values mirrored in .env.example.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_web') THEN
    CREATE ROLE platform_web LOGIN PASSWORD 'platform-web-dev-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_messaging') THEN
    CREATE ROLE platform_messaging NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_voice') THEN
    CREATE ROLE platform_voice LOGIN PASSWORD 'platform-voice-dev-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  ELSE
    ALTER ROLE platform_voice LOGIN PASSWORD 'platform-voice-dev-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_worker') THEN
    CREATE ROLE platform_worker NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_readonly') THEN
    CREATE ROLE platform_readonly NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
