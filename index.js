// transcritor — bot de Telegram que transforma audio e video em texto.
//
// Por que servico proprio, e nao um comando dentro de um bot que ja existe:
// a Bot API admite UM leitor de getUpdates por token. Se outro processo ja faz
// long polling naquele bot, um segundo poller nao "divide" os updates — os dois
// passam a roubar mensagem um do outro. Bot novo ou entao o poller existente
// repassa; nao ha terceira opcao.
//
// Fluxo: manda (ou responde a /trans com) audio/video -> baixa -> ffmpeg
// normaliza pra opus 16k mono -> OpenAI transcreve -> texto no chat +
// relatorio de custo na mensagem seguinte + botoes pra resumo, legenda de
// Reels, .srt e .txt.
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const tg     = require('./lib/telegram');
const media  = require('./lib/media');
const openai = require('./lib/openai');
const copy   = require('./lib/copy');
const link   = require('./lib/link');
const estado = require('./lib/estado');
const precos = require('./lib/precos');
const { EXTS } = require('./lib/formatos');

const DONO      = String(process.env.TG_CHAT_ID || '').trim();
const AUTO      = process.env.AUTO_TRANSCREVER !== '0';   // aceita midia sem /trans antes
const BLOCO_S   = Number(process.env.BLOCO_SEGUNDOS || 1500);
const TETO_OPENAI = 24 * 1024 * 1024;                     // limite real: 25 MB por request
const CFG_ARQ   = path.join(estado.RAIZ, 'config.json');
// Pasta de entrada da pagina de upload (upload.js): arquivo que cai aqui e
// transcrito como se tivesse chegado pelo chat, e a resposta vai pro dono.
const INBOX     = path.join(estado.RAIZ, 'inbox');
const INBOX_EST = path.join(INBOX, '_estado.json');


let offset = 0;
const armado = new Set();      // chats que mandaram /trans e ainda nao mandaram o arquivo
const ocupado = new Set();     // um trabalho por chat de cada vez

const cfg = () => { try { return JSON.parse(fs.readFileSync(CFG_ARQ, 'utf8')); } catch { return {}; } };
const salvarCfg = (o) => fs.writeFileSync(CFG_ARQ, JSON.stringify({ ...cfg(), ...o }, null, 1));
const modeloAtual = () => cfg().modelo || openai.MODELO_RAPIDO;

// ── o que veio na mensagem ────────────────────────────────────────────────
function acharMidia(m) {
  if (m.voice)      return { id: m.voice.file_id,      nome: 'audio-de-voz.ogg', bytes: m.voice.file_size, tipo: 'audio de voz' };
  if (m.audio)      return { id: m.audio.file_id,      nome: m.audio.file_name || 'audio.mp3', bytes: m.audio.file_size, tipo: 'audio' };
  if (m.video_note) return { id: m.video_note.file_id, nome: 'video-redondo.mp4', bytes: m.video_note.file_size, tipo: 'video redondo' };
  if (m.video)      return { id: m.video.file_id,      nome: m.video.file_name || 'video.mp4', bytes: m.video.file_size, tipo: 'video' };
  if (m.animation)  return { id: m.animation.file_id,  nome: m.animation.file_name || 'animacao.mp4', bytes: m.animation.file_size, tipo: 'animacao' };
  if (m.document) {
    const nome = m.document.file_name || 'arquivo';
    const mime = m.document.mime_type || '';
    if (EXTS.test(nome) || /^(audio|video)\//.test(mime))
      return { id: m.document.file_id, nome, bytes: m.document.file_size, tipo: 'arquivo' };
  }
  return null;
}

const AJUDA = `<b>Transcritor</b> — audio e video viram texto.

<b>Como usar</b>
Manda o audio ou o video aqui. So isso. Se preferir avisar antes, manda /trans e depois o arquivo.
Tambem aceito <b>link</b>: cola a URL do Instagram, TikTok, X, Vimeo, YouTube ou de um arquivo direto — por link nao existe o teto de 20 MB.

<b>Aceita</b>
opus, ogg, oga, wav, mp3, m4a, aac, flac, amr — e video mp4, mkv, mov, avi, webm (o audio e extraido na hora, nao precisa converter antes).

<b>Depois de transcrever</b>
Botoes pra: resumo, legenda de Reels com 5 hashtags de SEO, legenda .srt com marcacao de tempo e o texto em .txt.

<b>Comandos</b>
/trans — arma o proximo arquivo
/modelo — escolhe o motor de transcricao
/gastos — quanto ja custou (dia, mes, total)
/ajuda — isto aqui

<b>Limite</b>
20 MB por arquivo enviado aqui — teto do proprio Telegram pra bot, nao meu (com servidor Bot API proprio, 2 GB). Video maior: cola o link, ou usa a pagina de upload se ela estiver no ar.`;

// ── transcricao ───────────────────────────────────────────────────────────
async function transcreverArquivo(caminho, info, comTempos = false) {
  const pedacos = [];
  const custos = [];
  let texto = '', segmentos = [], modelo = '', ms = 0;

  const grande = info.bytes > TETO_OPENAI || info.duracao > BLOCO_S * 1.2;
  const lista = grande
    ? await media.fatiar(caminho, info.duracao, BLOCO_S, path.dirname(caminho))
    : [{ caminho, offset: 0 }];

  for (const p of lista) {
    const r = await openai.transcrever({ arquivo: p.caminho, comTempos, offset: p.offset, modelo: modeloAtual() });
    texto += (texto ? '\n\n' : '') + r.texto;
    segmentos = segmentos.concat(r.segmentos);
    custos.push(r.custo);
    modelo = r.modelo; ms += r.ms;
    pedacos.push(p.caminho);
  }
  const usd = custos.reduce((s, c) => s + c.usd, 0);
  const soma = custos.reduce((a, c) => ({ audio_in: a.audio_in + c.audio_in, text_out: a.text_out + c.text_out }), { audio_in: 0, text_out: 0 });
  return { texto, segmentos, modelo, ms, usd, tokens: soma, partes: lista.length };
}

// Painel do trabalho: dois planos, quatro botoes, nada mais.
//   linha 1 — o que o texto VIRA (custa centavos, gera conteudo novo)
//   linha 2 — em que formato o texto SAI (arquivo pronto pra levar embora)
// Gastos e modelo sao do sistema, nao deste trabalho: viraram comando.
// O rotulo carrega o estado — "(pronto)" significa que reenviar nao cobra de
// novo — e carrega o preco quando a acao gasta de verdade (so o .srt gasta,
// porque exige re-transcricao no whisper-1).
function tecladoJob(job) {
  const prontoSRT = !!job.segmentos?.length;
  const precoSRT  = precos.fmtBRL((job.arquivo.duracao / 60) * 0.006);
  const rotulo = (feito, nome) => (feito ? `${nome} (pronto)` : nome);
  return [
    [{ text: rotulo(!!job.resumo, 'Resumo'), callback_data: `r:${job.id}` },
     { text: rotulo(!!job.reels,  'Reels'),  callback_data: `i:${job.id}` }],
    [{ text: prontoSRT ? 'Legenda .srt (pronto)' : `Legenda .srt · ${precoSRT}`, callback_data: `s:${job.id}` },
     { text: 'Texto .txt', callback_data: `t:${job.id}` }],
  ];
}

// Depois de qualquer acao, o painel se repinta no lugar: sem mensagem nova,
// sem botao que mente sobre o estado.
async function repintar(job) {
  if (job.painel) await tg.editarTeclado(job.chat, job.painel, tecladoJob(job));
}

function relatorio(job) {
  const c = job.custo;
  const g = estado.gastos();
  const L = [];
  L.push('<b>Relatorio</b>');
  L.push(`Arquivo: <code>${tg.esc(job.arquivo.nome)}</code> (${job.arquivo.tipo})`);
  L.push(`Tamanho: ${media.MB(job.arquivo.bytes)} → ${media.MB(job.arquivo.bytesOpus)} em opus 16k mono`);
  L.push(`Duracao: ${media.duracaoHumana(job.arquivo.duracao)}${job.partes > 1 ? ` · ${job.partes} blocos` : ''}`);
  L.push(`Caracteres: ${job.texto.length} · palavras: ${job.texto.split(/\s+/).filter(Boolean).length}`);
  L.push('');
  L.push(`Modelo: <code>${job.modelo}</code>`);
  if (job.tokens.audio_in) L.push(`Tokens: ${job.tokens.audio_in} de audio (entrada) · ${job.tokens.text_out} de texto (saida)`);
  else L.push(`Cobranca por duracao (${(job.arquivo.duracao / 60).toFixed(2)} min)`);
  L.push('');
  L.push(`Tempo: baixar ${(job.ms.baixar / 1000).toFixed(1)}s · converter ${(job.ms.ffmpeg / 1000).toFixed(1)}s · transcrever ${(job.ms.openai / 1000).toFixed(1)}s`);
  L.push(`<b>Custo: ${precos.fmtUSD(c.usd)} (${precos.fmtBRL(c.usd)})</b>`);
  L.push(`<i>acumulado do mes ${precos.fmtUSD(g.usdMes)} · /gastos abre o detalhe</i>`);
  return L.join('\n');
}

async function processar(chat, msg, origem) {
  if (ocupado.has(chat)) { await tg.enviar(chat, 'Ainda estou com o trabalho anterior. Manda esse daqui a pouco.'); return { ok: false, motivo: 'ocupado' }; }
  ocupado.add(chat);
  armado.delete(chat);

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'trans-'));
  const aviso = await tg.enviar(chat, origem.tipo === 'link' ? 'Abrindo o link…'
    : origem.tipo === 'arquivo' ? `Chegou pela web: <code>${tg.esc(origem.info.nome)}</code>` : 'Baixando o arquivo…')
    .catch(() => null);
  const ms = { baixar: 0, ffmpeg: 0, openai: 0 };
  let info = origem.info;
  let saida = { ok: true };

  try {
    let t = Date.now();
    let baixado;
    if (origem.tipo === 'link') {
      // metadados primeiro: da pra avisar o que e antes de gastar banda
      const meta = await link.metadados(origem.url, pasta).catch(() => null);
      if (meta) await tg.editar(chat, aviso.message_id,
        `Baixando de <b>${tg.esc(meta.site)}</b>: ${tg.esc(meta.titulo.slice(0, 80))}${meta.duracao ? ` (${media.duracaoHumana(meta.duracao)})` : ''}…`);
      baixado = await link.baixar(origem.url, pasta);
      info = { nome: (meta?.titulo || baixado.nome).slice(0, 120), tipo: `link · ${meta?.site || 'web'}`, bytes: baixado.bytes };
    } else if (origem.tipo === 'arquivo') {
      // ja esta em disco (pasta de entrada): nada a baixar
      baixado = { caminho: origem.caminho, bytes: info.bytes };
    } else {
      // A mensagem do Telegram ja diz o tamanho — barrar aqui evita gastar uma
      // chamada de API so pra ouvir "file is too big".
      if (info.bytes && info.bytes > tg.LIMITE_DOWNLOAD) {
        const e = new Error('grande'); e.limite = true; e.bytes = info.bytes; throw e;
      }
      baixado = await tg.baixar(info.id, pasta, info.bytes);
    }
    ms.baixar = Date.now() - t;

    if (aviso) await tg.editar(chat, aviso.message_id, 'Preparando o audio…');
    t = Date.now();
    const sonda = await media.inspecionar(baixado.caminho);
    if (!sonda.temAudio) {
      if (aviso) await tg.editar(chat, aviso.message_id, 'Esse arquivo nao tem faixa de audio — nao ha o que transcrever.');
      return { ok: false, motivo: 'sem faixa de audio' };
    }
    const opus = path.join(pasta, 'audio.ogg');
    await media.paraOpus(baixado.caminho, opus);
    ms.ffmpeg = Date.now() - t;
    const bytesOpus = fs.statSync(opus).size;
    // opus 16k e minusculo (~7 MB/hora): vale guardar pra gerar .srt depois
    // sem obrigar o dono a reenviar o arquivo.
    const guardado = path.join(estado.AUDIOS, `${Date.now().toString(36)}.ogg`);
    fs.copyFileSync(opus, guardado);

    if (aviso) await tg.editar(chat, aviso.message_id,
      `Transcrevendo ${media.duracaoHumana(sonda.duracao)} de audio…`);
    await tg.acao(chat);
    const r = await transcreverArquivo(opus, { bytes: bytesOpus, duracao: sonda.duracao });
    ms.openai = r.ms;

    if (!r.texto) {
      if (aviso) await tg.editar(chat, aviso.message_id, 'Nao consegui ouvir fala nenhuma nesse arquivo.');
      return { ok: false, motivo: 'nenhuma fala ouvida' };
    }

    const job = estado.salvar({
      id: estado.novoId(), chat, criado: Date.now(),
      arquivo: { nome: info.nome, tipo: info.tipo, bytes: baixado.bytes, bytesOpus, duracao: sonda.duracao },
      texto: r.texto, segmentos: r.segmentos, modelo: r.modelo, tokens: r.tokens, audio: guardado,
      partes: r.partes, ms, custo: { usd: r.usd },
    });
    estado.anotarGasto(r.usd, 'transcricao');

    if (aviso) await tg.api('deleteMessage', { chat_id: chat, message_id: aviso.message_id }).catch(() => {});

    // Texto longo vira anexo tambem: rolar 6 blocos no celular e ruim.
    const blocos = tg.picotar(r.texto);
    if (blocos.length > 4) {
      await tg.enviarDocumento(chat, Buffer.from(r.texto, 'utf8'), `transcricao-${job.id}.txt`,
        `Transcricao completa (${r.texto.length} caracteres) — mandei em arquivo porque daria ${blocos.length} mensagens.`);
      await tg.enviar(chat, blocos[0], { escapar: true, prefixo: '<b>Comeco da transcricao</b>\n\n' });
    } else {
      await tg.enviar(chat, r.texto, { escapar: true, responder_a: msg?.message_id });
    }
    const painel = await tg.enviar(chat, relatorio(job), { teclado: tecladoJob(job) });
    job.painel = painel.message_id;
    estado.salvar(job);
  } catch (e) {
    const txt = e.limite
      ? `<b>${e.bytes ? media.MB(e.bytes) : 'Esse arquivo'}</b> — o Telegram nao deixa bot baixar mais de ${(tg.LIMITE_DOWNLOAD / 1048576).toFixed(0)} MB. Nao e limite meu nem da OpenAI.\n\n<b>Tres saidas</b>\n1. Cola o <b>link</b> do video (por link nao existe esse teto)\n2. Manda so o <b>audio</b> do video, extraido no celular ou no editor\n3. Manda um <b>trecho</b>`
      : e.amigavel
        ? tg.esc(e.message)
        : `Deu erro: ${tg.esc(String(e.message || e).slice(0, 300))}`;
    // se o proprio aviso nao chegou a existir, manda mensagem nova
    if (aviso?.message_id) await tg.editar(chat, aviso.message_id, txt);
    else await tg.enviar(chat, txt).catch(() => {});
    saida = { ok: false, motivo: String(e.message || e).slice(0, 200) };
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
    ocupado.delete(chat);
  }
  return saida;
}

// ── pasta de entrada (pagina de upload) ───────────────────────────────────
// O upload.js grava `<id>--<nome>` (via .part + rename, nunca pela metade).
// Aqui: um por vez, o mais antigo primeiro, respeitando o mesmo trinco por
// chat que o Telegram usa — se o dono esta no meio de um job pelo chat, a
// fila espera. O estado de cada item vai pro _estado.json, que a pagina le.
function anotarInbox(id, dados) {
  let est = {};
  try { est = JSON.parse(fs.readFileSync(INBOX_EST, 'utf8')); } catch {}
  const limite = Date.now() - 86400000;
  for (const k of Object.keys(est)) if ((est[k].quando || 0) < limite) delete est[k];
  est[id] = { ...(est[id] || {}), ...dados, quando: Date.now() };
  fs.writeFileSync(INBOX_EST, JSON.stringify(est, null, 1));
}

let varrendo = false;
async function varrerInbox() {
  if (varrendo || !DONO) return;
  const chat = Number(DONO);
  if (ocupado.has(chat)) return;
  let nomes;
  try { nomes = fs.readdirSync(INBOX).filter((f) => !f.startsWith('_') && !f.endsWith('.part')).sort(); }
  catch { return; }
  if (!nomes.length) return;
  varrendo = true;
  const f = nomes[0];
  const [id, ...resto] = f.split('--');
  const nome = resto.join('--') || f;
  const caminho = path.join(INBOX, f);
  try {
    const bytes = fs.statSync(caminho).size;
    anotarInbox(id, { nome, estado: 'processando' });
    const r = await processar(chat, null, { tipo: 'arquivo', caminho, info: { nome, tipo: 'upload web', bytes } });
    anotarInbox(id, r.ok ? { estado: 'pronto' } : { estado: 'erro', msg: r.motivo });
  } catch (e) {
    console.error('[inbox]', f, e.message);
    anotarInbox(id, { estado: 'erro', msg: String(e.message || e).slice(0, 200) });
  } finally {
    fs.rmSync(caminho, { force: true });
    varrendo = false;
  }
}

// ── botoes ────────────────────────────────────────────────────────────────
function mostrarGastos(chat) {
  const g = estado.gastos();
  const linhas = Object.entries(g.chamadasMes).map(([k, n]) => `· ${k}: ${n}`).join('\n') || '· nada ainda';
  return tg.enviar(chat, `<b>Gastos</b>\nHoje: ${precos.fmtUSD(g.usdHoje)} (${precos.fmtBRL(g.usdHoje)})\n` +
    `Mes: ${precos.fmtUSD(g.usdMes)} (${precos.fmtBRL(g.usdMes)})\nTotal: ${precos.fmtUSD(g.usdTotal)} (${precos.fmtBRL(g.usdTotal)})\n\n` +
    `Chamadas no mes:\n${linhas}\n\n<i>cambio de referencia: R$ ${precos.USD_BRL.toFixed(2)}</i>`);
}

async function botao(q) {
  const chat = q.message.chat.id;
  const [acao, id] = String(q.data || '').split(':');

  if (acao === 'm') {
    salvarCfg({ modelo: id });
    await tg.responderBotao(q.id, 'Motor trocado');
    return tg.enviar(chat, `Motor de transcricao agora: <code>${tg.esc(id)}</code>`);
  }

  // Acoes do TRABALHO
  const job = estado.ler(id);
  if (!job) return tg.responderBotao(q.id, 'Essa transcricao ja expirou. Manda o arquivo de novo.', true);

  const guardado = (acao === 'r' && job.resumo) || (acao === 'i' && job.reels) ||
                   (acao === 's' && job.segmentos?.length) || acao === 't';
  await tg.responderBotao(q.id, guardado ? 'Ja tinha isso pronto' : 'Trabalhando…');
  await tg.acao(chat);

  try {
    // ── exportar: nunca custa ─────────────────────────────────────────────
    if (acao === 't') {
      return tg.enviarDocumento(chat, Buffer.from(job.texto, 'utf8'), `transcricao-${job.id}.txt`,
        `Transcricao de <code>${tg.esc(job.arquivo.nome)}</code>`);
    }

    if (acao === 's') {
      if (!job.segmentos?.length) {
        if (!job.audio || !fs.existsSync(job.audio))
          return tg.enviar(chat, 'O audio desse trabalho ja foi apagado. Reenvia o arquivo que eu gero a legenda.');
        await tg.enviar(chat, 'Marcacao de tempo so sai do whisper-1 — transcrevendo de novo por ele.');
        const w = await transcreverArquivo(job.audio, { bytes: job.arquivo.bytesOpus, duracao: job.arquivo.duracao }, true);
        estado.anotarGasto(w.usd, 'srt');
        job.segmentos = w.segmentos;
        estado.salvar(job);
        await repintar(job);
      }
      const srt = copy.montarSRT(job.segmentos);
      return tg.enviarDocumento(chat, Buffer.from(srt, 'utf8'), `legenda-${job.id}.srt`,
        `Legenda com marcacao de tempo · ${job.segmentos.length} blocos`);
    }

    // ── transformar: custa uma vez so. Reclicar reentrega o guardado ──────
    if (acao === 'r') {
      if (!job.resumo) {
        const r = await copy.resumir(job.texto);
        estado.anotarGasto(r.custo.usd, 'resumo');
        job.resumo = { texto: r.texto, modelo: r.modelo, usd: r.custo.usd };
        estado.salvar(job);
        await repintar(job);
      }
      const r = job.resumo;
      return tg.enviar(chat, r.texto, { escapar: true, prefixo: '<b>Resumo</b>\n\n',
        sufixo: `\n\n<i>${r.modelo} · ${precos.fmtUSD(r.usd)} (${precos.fmtBRL(r.usd)})</i>` });
    }

    if (acao === 'i' || acao === 'n') {
      const outra = acao === 'n';
      if (outra || !job.reels) {
        const anteriores = (job.reelsVersoes || []).map((v) => v.gancho).filter(Boolean);
        const r = await copy.reels(job.texto, anteriores);
        estado.anotarGasto(r.custo.usd, outra ? 'reels-variacao' : 'reels');
        job.reels = { ...r.dados, modelo: r.modelo, usd: r.custo.usd };
        job.reelsVersoes = [...(job.reelsVersoes || []), job.reels];
        estado.salvar(job);
        await repintar(job);
      }
      const d = job.reels;
      const n = (job.reelsVersoes || []).length;
      await tg.enviar(chat,
        `<b>Reels</b>${n > 1 ? ` · versao ${n}` : ''} · segmento: <b>${tg.esc(d.segmento || '?')}</b>\n\n` +
        `<b>Gancho (ate 3s)</b>\n${tg.esc(d.gancho || '')}\n\n` +
        `<b>Texto na tela</b>\n${tg.esc(d.texto_na_tela || '')}\n\n` +
        `<i>A legenda pronta vem abaixo — toca nela pra copiar.</i>`);
      return tg.enviar(chat,
        `<code>${tg.esc(copy.montarLegenda(d))}</code>\n\n<i>${d.modelo} · ${precos.fmtUSD(d.usd)} (${precos.fmtBRL(d.usd)})</i>`,
        { teclado: [[{ text: 'Outro angulo', callback_data: `n:${job.id}` }]] });
    }
  } catch (e) {
    return tg.enviar(chat, `Deu erro: ${tg.esc(String(e.message || e).slice(0, 300))}`);
  }
}

// ── mensagens ─────────────────────────────────────────────────────────────
async function mensagem(m) {
  const chat = m.chat.id;
  const texto = (m.text || m.caption || '').trim();

  if (DONO && String(chat) !== DONO) {
    console.log('[bloqueado] chat', chat, m.from?.username || '');
    return;   // silencio proposital: responder confirmaria o bot a quem sonda
  }

  if (/^\/(start|ajuda|help)/i.test(texto)) return tg.enviar(chat, AJUDA);
  if (/^\/id/i.test(texto))     return tg.enviar(chat, `chat id: <code>${chat}</code>`);
  if (/^\/gastos/i.test(texto)) return mostrarGastos(chat);
  if (/^\/modelo/i.test(texto)) {
    return tg.enviar(chat, `Motor atual: <code>${tg.esc(modeloAtual())}</code>\n\n<b>gpt-4o-transcribe</b> — melhor em portugues falado (padrao)\n<b>gpt-4o-mini-transcribe</b> — metade do preco\n<b>whisper-1</b> — o unico com marcacao de tempo pro .srt`,
      { teclado: [
        [{ text: 'gpt-4o-transcribe', callback_data: 'm:gpt-4o-transcribe' }],
        [{ text: 'gpt-4o-mini-transcribe', callback_data: 'm:gpt-4o-mini-transcribe' }],
        [{ text: 'whisper-1 (com tempos)', callback_data: 'm:whisper-1' }],
      ] });
  }
  if (/^\/trans/i.test(texto) && !acharMidia(m)) {
    armado.add(chat);
    return tg.enviar(chat, 'Pode mandar o audio ou o video.');
  }

  const midia = acharMidia(m);
  if (midia) {
    if (!AUTO && !armado.has(chat) && !/^\/trans/i.test(texto))
      return tg.enviar(chat, 'Manda /trans antes do arquivo.');
    if (/\/srt/i.test(texto)) salvarCfg({ modelo: 'whisper-1' });   // ja sai com tempos
    return processar(chat, m, { tipo: 'telegram', info: midia });
  }

  const url = (texto.match(/https?:\/\/\S+/) || [])[0];
  if (url) return processar(chat, m, { tipo: 'link', url });

  if (texto) return tg.enviar(chat, 'Manda um audio, um video ou cola um link que eu transcrevo. /ajuda mostra o resto.');
}

// ── laco ──────────────────────────────────────────────────────────────────
async function laco() {
  for (;;) {
    try {
      const updates = await tg.api('getUpdates', {
        offset, timeout: 25, allowed_updates: ['message', 'callback_query'],
      }, 1);
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await mensagem(u.message);
          else if (u.callback_query) {
            const chat = u.callback_query.message?.chat?.id;
            if (DONO && String(chat) !== DONO) continue;
            await botao(u.callback_query);
          }
        } catch (e) { console.error('[update]', e.message); }
      }
    } catch (e) {
      console.error('[getUpdates]', e.message);
      await new Promise((s) => setTimeout(s, 5000));
    }
  }
}

if (!tg.temToken())    { console.error('FALTA o secret TG_BOT_TOKEN'); process.exit(1); }
if (!openai.temChave()) { console.error('FALTA o secret OPENAI_API_KEY'); process.exit(1); }

// Se sobrou webhook de teste, o getUpdates devolve 409 pra sempre.
tg.api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
estado.faxina();
setInterval(() => estado.faxina(), 6 * 3600 * 1000);
fs.mkdirSync(INBOX, { recursive: true });
setInterval(varrerInbox, 2000);
console.log(`[transcritor] no ar · dono=${DONO || 'QUALQUER UM (defina TG_CHAT_ID)'} · motor=${modeloAtual()}`);
laco();
