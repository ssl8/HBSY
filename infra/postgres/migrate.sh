#!/bin/sh
set -eu

# Authenticate as hbys_migrator; explicitly SET ROLE to the non-login owner.
# Every migration and its ledger row commit atomically in one transaction.
psql -X -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE hbys_owner;
CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

for file in /migrations/V*.sql; do
    [ -f "$file" ] || continue
    version=$(basename "$file")
    applied=$(psql -X -qAt -v ON_ERROR_STOP=1 -v version="$version" <<'SQL'
SET ROLE hbys_owner;
SELECT 1 FROM public.schema_migrations WHERE version = :'version';
SQL
    )
    if [ "$applied" = "1" ]; then
        echo "Already applied: $version"
        continue
    fi
    echo "Applying $version (atomic transaction)"
    {
        printf 'BEGIN;\nSET LOCAL ROLE hbys_owner;\n'
        cat "$file"
        printf '\nINSERT INTO public.schema_migrations(version) VALUES (%s);\n' "'$(printf "%s" "$version" | sed "s/'/''/g")'"
        printf 'COMMIT;\n'
    } | psql -X -v ON_ERROR_STOP=1
    echo "Applied: $version"
done
