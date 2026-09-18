#!/usr/bin/env bash
# Build + deploy. O proprio "docker stack deploy" interpola ${VAR} a partir do
# ambiente, entao o .env local (fora do repositorio) e o que mantem
# identificadores pessoais longe do versionamento.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "falta o .env — copie de .env.example e preencha"; exit 1; }
set -a; . ./.env; set +a
# Tag unica por build: com "latest" fixo o Swarm nao percebe imagem nova e
# deixa o bot rodando o codigo antigo. A tag entra nos stacks via ${TRANSCRITOR_TAG}.
export TRANSCRITOR_TAG="$(date +%Y%m%d-%H%M%S)"
docker build -t transcritor:latest -t "transcritor:$TRANSCRITOR_TAG" .
ARQS=(-c stack.yml)
# a pagina de upload so entra se o .env disser onde publica-la
[ -n "${UPLOAD_HOST:-}" ] && ARQS+=(-c stack.upload.yml)
docker stack deploy "${ARQS[@]}" transcritor
# tags de builds anteriores: some com tudo menos latest e a atual
docker images transcritor --format '{{.Tag}}' | grep -v -e '^latest$' -e "^$TRANSCRITOR_TAG$" | xargs -r -I{} docker rmi -f transcritor:{} >/dev/null
docker service logs -f transcritor_bot --tail 5
