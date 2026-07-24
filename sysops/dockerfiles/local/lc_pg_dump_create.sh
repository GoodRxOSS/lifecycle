#!/bin/bash
# Copyright 2025 GoodRx, Inc.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.


ENV_FILE="$(pwd)/.env"
DATABASE_DUMP_FILE="lc_pg_db_dump.sql"
FINAL_DUMP_FILE="lc_pg_db_init.sql.gz"
DESTINATION_DIR="$(pwd)/sysops/dockerfiles/local"
FINAL_DUMP_PATH="$DESTINATION_DIR/$FINAL_DUMP_FILE"

# Tables for which you want to exclude data
EXCLUDE_DATA_TABLES=("builds" "configurations" "deployables" "deploys" "pull_requests" "services_disks" "webhooks")

echo "Creating database dump, including data for all tables except specified..."

if [ -f "$FINAL_DUMP_PATH" ]; then
    echo "Removing existing dump file: $FINAL_DUMP_PATH"
    rm "$FINAL_DUMP_PATH"
fi

# Check if the .env file exists in the current working directory
if [ ! -f "$ENV_FILE" ]; then
    echo "Error: .env file not found in the current working directory ($ENV_FILE)."
    exit 1
fi

# Load environment variables
set -a
source "$ENV_FILE"
set +a

# DOCKER_DATABASE_HOST="postgres"

# Define paths for dump files
DUMP_PATH="$DESTINATION_DIR/$DATABASE_DUMP_FILE"
FINAL_DUMP_PATH="$DESTINATION_DIR/$FINAL_DUMP_FILE"

# Construct the exclude-table-data options
EXCLUDE_TABLES=""
for tbl in "${EXCLUDE_DATA_TABLES[@]}"; do
    EXCLUDE_TABLES+="--exclude-table-data=$tbl "
done

# Dump the entire database excluding data for specified tables
# Remove the GRANT statements for the datadog role
PGPASSWORD=$DATABASE_PASSWORD pg_dump -h $DATABASE_HOST -p $DATABASE_PORT -U $DATABASE_USER -d $DATABASE_NAME $EXCLUDE_TABLES \
| sed '/GRANT USAGE ON SCHEMA datadog TO datadog;/d' \
| sed '/GRANT USAGE ON SCHEMA public TO datadog;/d' > "$DUMP_PATH"

echo "CREATE SCHEMA IF NOT EXISTS public;" | cat - "$FINAL_DUMP_PATH" > temp && mv temp "$FINAL_DUMP_PATH" || rm -f temp exit 1

gzip < "$DUMP_PATH" > "$FINAL_DUMP_PATH"
# Clean up and provide feedback
if [ -f "$FINAL_DUMP_PATH" ]; then
    rm "$DUMP_PATH"
    echo "Database dump with specified inclusions and exclusions is completed. It's gzipped here: ${FINAL_DUMP_PATH}"
else
    echo "Error: Failed to create the final dump file."
fi

echo "Database dump is completed. It's gzipped here: ${DESTINATION_DIR}/${FINAL_DUMP_FILE}"
