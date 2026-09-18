FROM node:20-alpine
# ffmpeg: extrai audio de mp4/mkv, normaliza tudo pra opus 16k mono
# (1h de fala ~ 7 MB, entao o teto de 25 MB da OpenAI praticamente nunca aperta)
# yt-dlp: transcricao a partir de link, que nao tem o teto de 20 MB do Telegram.
RUN apk add --no-cache ffmpeg python3 py3-pip \
 && pip install --no-cache-dir --break-system-packages -U yt-dlp
WORKDIR /app
COPY package.json ./
COPY index.js ./
COPY lib ./lib
# pagina de upload (servico opcional, mesma imagem, outro comando)
COPY upload.js ./
COPY web ./web
CMD ["node", "index.js"]
