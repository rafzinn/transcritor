# Decisões

Registro do que foi escolhido, por quê, e o que foi descartado. Cada decisão tem
a evidência que a sustenta — quase todas foram medidas, não supostas.

---

## 1. Serviço próprio, e não um comando dentro de um bot existente

**Contexto.** Já havia bots de Telegram rodando na mesma infraestrutura. A
tentação era acrescentar um `/trans` a um deles.

**Decisão.** Bot novo, serviço isolado.

**Por quê.** A Bot API admite **um** leitor de `getUpdates` por token. Um segundo
processo no mesmo bot não divide os updates: os dois passam a roubar mensagem um
do outro, de forma intermitente. Se o token já tem dono, as opções reais são bot
novo — ou o poller existente repassar o trabalho. Não existe terceira.

**Consequência.** Um container a mais, e nenhum risco a serviço em produção.

---

## 2. Normalizar tudo para opus 16 kbps mono, sempre

**Decisão.** Qualquer entrada — `wav`, `mp3`, `m4a`, `mp4`, `mkv`, `mov` — vira
`ogg/opus` 16 kHz mono 16 kbps antes de chegar à OpenAI.

**Por quê.** Resolve três problemas com um comando: normaliza formato, extrai o
áudio de vídeo (`-vn`) e derruba o tamanho o bastante para o teto de 25 MB por
request nunca ser atingido. Fala é banda estreita; 16 kHz mono não custa
qualidade perceptível de transcrição.

**Evidência.** Vídeo de 29,7 MB → **0,17 MB**. Uma hora de fala fica em ~7 MB.

**Descartado.** Mandar o arquivo original quando "já estava em formato aceito" —
economizaria 1,3 s de conversão e traria de volta o problema de tamanho, o de
faixa dupla e o de codec exótico. Um caminho só é mais fácil de manter que dois.

---

## 3. `gpt-4o-transcribe` como padrão, `whisper-1` apenas para `.srt`

**Decisão.** Transcrição padrão no `gpt-4o-transcribe`; o `.srt` re-transcreve no
`whisper-1`.

**Por quê.** O `gpt-4o-transcribe` erra menos em português falado, mas **não
devolve marcação de tempo**. O `whisper-1` devolve `segments` com início e fim —
sem ele não existe legenda sincronizada.

**Consequência.** A legenda `.srt` custa uma segunda passada. Isso é dito ao
usuário no próprio rótulo do botão, com o valor calculado da duração real, e o
áudio normalizado fica guardado para que ninguém precise reenviar o arquivo.

---

## 4. Servidor Bot API próprio

**Contexto.** A API pública recusa `getFile` acima de 20 MB — cerca de um minuto
e meio de vídeo de celular. Um vídeo real de 29,7 MB bateu nesse teto.

**Decisão.** Subir `telegram-bot-api --local` como segundo serviço.

**Por quê.** O teto vai a 2 GB, e o servidor passa a entregar o **caminho do
arquivo em disco** em vez de uma URL. Com o volume compartilhado entre os dois
containers, a etapa de download desaparece.

**Custo da decisão.** Exige `api_id`/`api_hash` de `my.telegram.org` e um
`logOut` do bot no servidor oficial — depois disso, aquele bot só vive no
servidor próprio. É reversível (`logOut` no local devolve ao oficial), mas não é
gratuito: outro container, ~1 GB de RAM reservada e um volume que cresce.

**Armadilha encontrada.** O `entrypoint` da imagem liga a porta de estatísticas
com **qualquer** valor não vazio. `TELEGRAM_STAT=0` a ativaria. A variável tem
que ficar ausente.

---

## 5. O bot apaga o que o servidor local baixa

**Decisão.** Depois de copiar o arquivo do volume, `unlink` no original.

**Por quê.** O `telegram-bot-api --local` não limpa o que baixa — é
responsabilidade do bot. Sem isso, cada vídeo enviado ficaria no volume para
sempre, e o sintoma só apareceria como disco cheio semanas depois.

---

## 6. Custo é parte do produto, não telemetria

**Decisão.** Toda resposta que gasta traz tokens, tempo por etapa e valor em USD
e BRL. O acumulado do mês fica a um comando de distância.

**Por quê.** Um bot que chama LLM sem mostrar custo é uma torneira aberta. Ver
`R$ 0,048` embaixo de cada transcrição muda a forma como se usa a ferramenta.

**Implementação.** `openai.js` nunca devolve resposta sem custo calculado, e a
tabela de preços mora em um arquivo só.

---

## 7. Botão pertence ao objeto; comando pertence ao sistema

**Contexto.** A primeira versão tinha cinco botões, e um deles era `Gastos`.

**Decisão.** O painel só tem ações daquela transcrição: duas que transformam o
texto, duas que exportam. Gastos e troca de modelo viraram comandos.

**Por quê.** `Gastos` não é propriedade de uma transcrição — é do sistema.
Misturar os dois planos é o que faz um menu parecer gaveta.

**Regras derivadas.** Reclicar não cobra de novo (o resultado fica no job); o
rótulo carrega o preço quando a ação gasta de verdade; o painel se repinta no
lugar; nível 2 só existe onde acrescenta — `Resumo` é terminal, `Reels` ganha
`Outro ângulo`.

---

## 8. Long polling, e não webhook

**Decisão.** `getUpdates` com `timeout=25`.

**Por quê.** Webhook exigiria rota pública, certificado e mais um segredo, para
um bot de uso pessoal. Polling não expõe superfície nenhuma. O custo é uma
conexão HTTP aberta em espera — irrelevante nesta escala.

---

## 9. Sem banco de dados

**Decisão.** JSON em disco para jobs, áudios e contabilidade.

**Por quê.** O volume é de uma pessoa. Um Postgres aqui seria mais coisa para
manter, atualizar e fazer backup, em troca de nada.

**Limite assumido.** Não há transação nem índice. Se um dia isto virar
multiusuário, esta é a primeira decisão a cair — e o contrato do job já está
documentado justamente para essa migração ser mecânica.

---

## 10. Escapar HTML **depois** de picotar

**Decisão.** O texto longo é cortado cru e cada bloco é escapado depois.

**Por quê.** Escapar antes e cortar depois parte entidades ao meio: um `&amp;`
virando `&am` faz o Telegram rejeitar a mensagem inteira com "can't parse
entities". O sintoma aparece só em transcrição longa com caractere especial —
raro o bastante para passar despercebido em teste manual.

---

## 11. YouTube depende de cookies, e isso está documentado como limite

**Medição (23/08/2026, de um IP de datacenter).** Sem cookies, o YouTube responde
"Sign in to confirm you're not a bot" mesmo com o `yt-dlp` mais recente. Com
cookies de três meses atrás, passa a checagem e falha com HTTP 403 no download.

**Decisão.** Suportar cookies por domínio em `cookies/<dominio>.txt`, e traduzir
o erro para uma instrução acionável em vez de esconder o problema.

**Por quê.** Fingir que funciona é pior que dizer o que falta. Os demais sites
suportados pelo `yt-dlp` não têm esse bloqueio.
