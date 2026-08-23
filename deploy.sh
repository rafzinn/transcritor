#!/usr/bin/env bash
# Build + deploy. O proprio "docker stack deploy" interpola ${VAR} a partir do
# ambiente, entao o .env local (fora do repositorio) e o que mantem
# identificadores pessoais longe do versionamento.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "falta o .env — copie de .env.example e preencha"; exit 1; }
set -a; . ./.env; set +a
docker build -t transcritor:latest .
docker stack deploy -c stack.yml transcritor
docker service logs -f transcritor_bot --tail 5
