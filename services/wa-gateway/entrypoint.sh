#!/bin/sh
# Forward the host's local Supabase ports into this container's loopback so
# http://127.0.0.1:56021 (the URL baked into the client bundle and shared by
# the server) resolves the same way inside and outside Docker.
# SUPABASE_FORWARD_PORTS defaults to the Supabase CLI ports of this project.
set -e
for port in ${SUPABASE_FORWARD_PORTS:-56021 56022}; do
  socat TCP-LISTEN:"$port",bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:"$port" &
done
exec "$@"
