#!/bin/bash
# Flyway Migration Wrapper
# Usage: ./flyway.sh [command]
# Commands: migrate, info, validate, repair, baseline, clean

# Load environment variables from .env
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Default values
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-8000}
DB_NAME=${DB_NAME:-PS}

# Build JDBC URL
export FLYWAY_URL="jdbc:postgresql://${DB_HOST}:${DB_PORT}/${DB_NAME}"
export FLYWAY_USER="${DB_USER}"
export FLYWAY_PASSWORD="${DB_PASSWORD}"
export FLYWAY_LOCATIONS="filesystem:./db/migrations"

# Check if flyway is installed
if ! command -v flyway &> /dev/null; then
    echo "Flyway not found in PATH"
    echo "Install from: https://flywaydb.org/download"
    echo "Or use Docker:"
    echo "  docker run --rm -v \$(pwd):/flyway/sql flyway/flyway \$@"
    exit 1
fi

# Run flyway with the command
if [ -z "$1" ]; then
    echo "Usage: ./flyway.sh [migrate|info|validate|repair|baseline|clean]"
    exit 1
fi

flyway "$@"
