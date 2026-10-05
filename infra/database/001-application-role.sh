#!/bin/sh
set -eu

# This runs once for a new volume. The application never uses the administrator login.
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ON_ERROR_STOP=1 --set=app_password="$POSTGRES_APP_PASSWORD" <<'SQL'
CREATE ROLE chess_room LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER DATABASE chess_room OWNER TO chess_room;
REVOKE ALL ON DATABASE chess_room FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE chess_room TO chess_room;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO chess_room;
SQL
