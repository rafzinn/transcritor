# Operação

## Deploy

```bash
./deploy.sh          # build + stack deploy + logs
```

O script carrega o `.env` e deixa o próprio `docker stack deploy` interpolar as
variáveis. Nunca suba com mais de uma réplica do serviço `bot`: dois pollers no
mesmo token disputam os updates.

Rollback para a imagem anterior:

```bash
docker service update --rollback transcritor_bot
```

## Servidor Bot API próprio

Sobe o teto de arquivo de 20 MB para 2 GB.

**1. Credenciais.** Em `my.telegram.org` → *API development tools*, crie uma
aplicação. Guarde `api_id` (número) e `api_hash` (32 caracteres) — são
credenciais da **conta**, não do bot.

```bash
printf '%s' "12345678"  | docker secret create tg_api_id   -
printf '%s' "0a1b..."   | docker secret create tg_api_hash -
```

**2. Migração.** O bot precisa sair do servidor oficial. A partir daí ele só
existe no seu:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/logOut"   # → {"ok":true}
./deploy.sh
```

**3. Conferência.**

```bash
docker exec $(docker ps -q -f name=transcritor_bot.) node -e "
  const tg=require('/app/lib/telegram');
  console.log(tg.API, tg.LOCAL, (tg.LIMITE_DOWNLOAD/1048576)+' MB');
  tg.api('getMe',{},1).then(m=>console.log('ok @'+m.username));"
```

Esperado: base apontando para o serviço local, `true`, o teto configurado e o
`getMe` respondendo.

**Para voltar ao servidor oficial:** chame `logOut` no servidor local, remova
`TG_API_BASE` e faça o deploy de novo.

## Rotação de segredo

Segredo do Swarm é imutável: rotacionar é criar outro e apontar o serviço.

```bash
printf '%s' "NOVO_TOKEN" | docker secret create tg_bot_token_v2 -
docker service update \
  --secret-rm tg_bot_token \
  --secret-add source=tg_bot_token_v2,target=TG_BOT_TOKEN \
  transcritor_bot
docker secret rm tg_bot_token
```

Token do bot revogado no `@BotFather` (`/revoke`) invalida o anterior na hora — o
bot fica fora do ar entre a revogação e este comando.

## Diagnóstico

| Sintoma | Onde olhar |
|---|---|
| Bot mudo | `docker service logs transcritor_bot --tail 50`. `Logged out` = migrou de servidor e a base não foi atualizada; `Conflict` = existe outro poller no mesmo token |
| "file is too big" | Está na API pública. Confira `TG_API_BASE` e se o `logOut` foi feito |
| Erro na transcrição | Chave da OpenAI (`/run/secrets/OPENAI_API_KEY`), ou arquivo sem faixa de áudio |
| Botão diz "expirou" | O job passou de `VALIDADE_DIAS` e a faxina apagou |
| Disco crescendo | `du -sh /var/lib/docker/volumes/transcritor_telegram-files/_data` — deveria ficar em poucos KB; se cresce, o `unlink` pós-cópia parou de rodar |

Teste de fumaça, sem Telegram nenhum — valida `ffmpeg`, OpenAI, montagem de
`.srt` e os dois geradores de texto:

```bash
OPENAI_API_KEY=sk-... node scripts/smoke.js
```

## Manutenção

- **Faxina** roda sozinha a cada 6 h e apaga jobs e áudios acima de
  `VALIDADE_DIAS`.
- **Cookies** expiram. Quando um site voltar a pedir login, reexporte a sessão
  para `cookies/<dominio>.txt` (formato Netscape). Não é preciso reiniciar.
- **Preços** mudam. A tabela está em `lib/precos.js`, e é o único lugar a mexer.
