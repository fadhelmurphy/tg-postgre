#!/usr/bin/env bash
# Menyalakan PostgreSQL sementara untuk tes integrasi. Cetak URL admin. Pakai: eval "$(native/scripts/pg-test.sh)"
set -e
BIN=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
DIR=${PGTEST_DIR:-/tmp/tgpg-pgtest}; PORT=${PGTEST_PORT:-54329}
if [ ! -f "$DIR/PG_VERSION" ]; then
  rm -rf "$DIR"; mkdir -p "$DIR"; chown postgres "$DIR" 2>/dev/null || true
  su postgres -c "$BIN/initdb -D $DIR -A trust -U postgres >/dev/null" 2>/dev/null || "$BIN/initdb" -D "$DIR" -A trust -U postgres >/dev/null
fi
if ! "$BIN/pg_isready" -q -h 127.0.0.1 -p "$PORT"; then
  (su postgres -c "$BIN/pg_ctl -D $DIR -o '-p $PORT -k /tmp -c fsync=off -c listen_addresses=127.0.0.1' -l $DIR/log -w start" >/dev/null 2>&1) \
    || "$BIN/pg_ctl" -D "$DIR" -o "-p $PORT -k /tmp -c fsync=off -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
fi
echo "export TGPG_TEST_PG=postgres://postgres@127.0.0.1:$PORT/postgres"
