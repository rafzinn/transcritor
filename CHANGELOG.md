# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/),
versionamento conforme [SemVer](https://semver.org/lang/pt-BR/).

## Não lançado

### Adicionado

- **Página web de upload** (`upload.js` + `web/index.html`, serviço opcional em
  `stack.upload.yml`): área de arrastar-e-soltar que grava o arquivo direto em
  `data/inbox`, com progresso, velocidade e fila. O bot varre a pasta, transcreve
  como se o arquivo tivesse vindo pelo chat e responde no mesmo chat. Existe
  porque pelo Telegram o arquivo faz dois saltos (celular → nuvem → servidor)
  na velocidade que o Telegram deixa; numa rede privada o envio direto anda na
  velocidade do link. Sem login — só atrás de middleware que restrinja a origem.
- `lib/formatos.js`: a lista de extensões aceitas virou fonte única, usada pelo
  bot e pela página.

### Segurança

- Os dois serviços passam a viver numa rede overlay exclusiva da stack, em vez
  de uma rede compartilhada: nenhum outro container da máquina alcança o
  `bot-api`. Como efeito colateral bem-vindo, a instalação deixou de exigir uma
  rede externa criada de antemão.
- Chat não autorizado é ignorado em silêncio, e não mais respondido — responder
  confirma a existência do bot a quem sonda.

### Corrigido

- `deploy.sh` não reciclava o bot: com a tag `latest` fixa o Swarm não vê
  imagem nova. Cada build ganha uma tag própria, interpolada nos stacks.
- O workflow de CI não iniciava: um `: ` dentro de escalar simples tornava o
  YAML inválido e o GitHub falhava antes de criar qualquer job. O passo agora
  valida o `stack.yml` de fato.

## [1.0.0] — 2026-08-23

Primeira versão em produção.

### Adicionado

- **Transcrição de áudio e vídeo** por `gpt-4o-transcribe`. Aceita qualquer
  entrada que o `ffmpeg` leia — `opus`, `ogg`, `wav`, `mp3`, `m4a`, `aac`,
  `flac`, `amr` — e vídeo `mp4`, `mkv`, `mov`, `avi`, `webm`, de onde o áudio é
  extraído automaticamente.
- **Transcrição por link** com `yt-dlp`: Instagram, TikTok, X, Vimeo, Facebook,
  YouTube e link direto de arquivo. Cookies opcionais por domínio.
- **Servidor Bot API próprio** (`telegram-bot-api --local`) como segundo serviço
  da stack: o teto por arquivo sai de 20 MB e vai a 2 GB, e o arquivo passa a
  chegar como caminho em disco pelo volume compartilhado, sem download HTTP.
- **Painel de quatro botões** ancorado no relatório: `Resumo`, `Reels`,
  `Legenda .srt` e `Texto .txt`. Reclicar reentrega o resultado guardado sem
  cobrar de novo, e o rótulo passa a `(pronto)`.
- **Legenda de Reels** com segmento identificado, gancho de até 3 segundos,
  texto de tela, copy persuasiva e 5 hashtags de SEO. `Outro ângulo` gera uma
  variação, com os ganchos anteriores proibidos no prompt.
- **Legenda `.srt`** com marcação de tempo via `whisper-1`, reaproveitando o
  áudio já normalizado — o arquivo original nunca precisa ser reenviado.
- **Relatório de custo em toda resposta**: tokens, tempo por etapa, valor em USD
  e BRL. Acumulado do dia e do mês em `/gastos`.
- **Fatiamento automático** acima de 25 minutos, com o deslocamento de cada
  pedaço somado de volta nos tempos da legenda.
- Comandos `/trans`, `/modelo`, `/gastos`, `/ajuda`, `/id`.
- Teste de fumaça (`scripts/smoke.js`) que exercita ffmpeg, transcrição de áudio
  e de vídeo, fatiamento, `.srt`, resumo e Reels sem depender do Telegram.
- CI que checa sintaxe, constrói a imagem e falha se algum padrão de segredo
  aparecer no versionamento.
- Documentação de arquitetura, decisões e operação, com diagramas.

### Segurança

- Segredos apenas por `docker secret`, lidos de `/run/secrets/` — nunca em
  variável de ambiente, que apareceria em `docker service inspect`.
- Um único chat autorizado, verificado tanto em mensagem quanto em clique de
  botão.
- Nenhuma porta publicada: os dois serviços conversam pela rede interna.
- Identificadores locais (chat, rede, nomes de secrets) ficam em `.env` fora do
  versionamento, interpolado pelo próprio `docker stack deploy`.

### Notas de operação

- `replicas: 1` e `update_config.order: stop-first` são obrigatórios: a Bot API
  admite um único leitor de `getUpdates` por token.
- O `telegram-bot-api --local` não apaga o que baixa; o bot faz o `unlink` logo
  após copiar o arquivo.
- `TELEGRAM_STAT` com qualquer valor não vazio — inclusive `0` — liga a porta de
  estatísticas. A variável precisa ficar ausente.
- YouTube, a partir de IP de datacenter, exige cookies de sessão válidos.

[1.0.0]: https://github.com/rafzinn/transcritor/releases/tag/v1.0.0
