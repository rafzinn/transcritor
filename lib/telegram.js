// telegram.js — cliente cru da Bot API. Sem dependencia externa: Node 20 ja
// tem fetch/FormData/Blob.
const fs   = require('fs');
const path = require('path');
const dns  = require('dns');

// Em varios provedores a rota IPv6 nao alcanca api.telegram.org: o connect
// fica pendurado ~25s e so entao cai pro IPv4, o que faz CADA chamada parecer
// travada. Prender a resolucao em IPv4 custa nada e evita o sintoma.
dns.setDefaultResultOrder('ipv4first');

function segredo(nome) {
  try { return fs.readFileSync(`/run/secrets/${nome}`, 'utf8').trim(); } catch { return ''; }
}
const TOKEN = segredo('TG_BOT_TOKEN') || process.env.TG_BOT_TOKEN || '';

// Com servidor Bot API proprio (TG_API_BASE apontando pra ele) o teto sobe de
// 20 MB pra 2 GB e o arquivo chega como caminho em disco, sem download HTTP.
const API   = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const LOCAL = !/api\.telegram\.org/.test(API);
const BASE  = () => `${API}/bot${TOKEN}`;

// Com servidor proprio o Telegram nao impoe teto de DOWNLOAD nenhum: o
// "limite" vira o que o cliente conseguiu enviar (2 GB, ou 4 GB no Premium).
// O teto aqui e so uma trava de sanidade contra disco e tempo de processamento.
const LIMITE_DOWNLOAD = (LOCAL ? Number(process.env.TG_MAX_MB || 4000) : 20) * 1024 * 1024;

async function api(metodo, payload = {}, tentativas = 3) {
  let erro;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(`${BASE()}/${metodo}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      if (j.ok) return j.result;
      // 429: o Telegram diz quantos segundos esperar
      if (j.error_code === 429) {
        await new Promise((s) => setTimeout(s, ((j.parameters?.retry_after || 3) + 1) * 1000));
        continue;
      }
      throw new Error(`${metodo}: ${j.description || 'erro'}`);
    } catch (e) {
      erro = e;
      if (i < tentativas - 1) await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
  throw erro;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// O sendMessage corta em 4096; 3800 deixa folga pro cabecalho de bloco.
function picotar(txt, tam = 3800) {
  const blocos = [];
  let resto = String(txt);
  while (resto.length > tam) {
    let corte = resto.lastIndexOf('\n', tam);
    if (corte < tam * 0.5) corte = resto.lastIndexOf(' ', tam);
    if (corte < tam * 0.5) corte = tam;
    blocos.push(resto.slice(0, corte));
    resto = resto.slice(corte).replace(/^\s+/, '');
  }
  if (resto) blocos.push(resto);
  return blocos;
}

// opts.escapar: o texto entra CRU e cada bloco e escapado depois de cortado.
// Escapar antes de picotar parte entidades ao meio ("&amp;" virando "&am") e o
// Telegram rejeita a mensagem inteira com "can't parse entities".
// opts.prefixo/sufixo: HTML que emoldura o primeiro e o ultimo bloco.
async function enviar(chat, texto, opts = {}) {
  const blocos = picotar(String(texto), opts.escapar ? 3600 : 3800);
  let ultima;
  for (let i = 0; i < blocos.length; i++) {
    const derradeiro = i === blocos.length - 1;
    const corpo = (opts.escapar ? esc(blocos[i]) : blocos[i]);
    ultima = await api('sendMessage', {
      chat_id: chat,
      text: (i === 0 && opts.prefixo ? opts.prefixo : '') + corpo +
            (derradeiro ? (opts.sufixo || '') : '\n\n…'),
      parse_mode: opts.plano ? undefined : 'HTML',
      disable_web_page_preview: true,
      link_preview_options: { is_disabled: true },
      ...(derradeiro && opts.teclado ? { reply_markup: { inline_keyboard: opts.teclado } } : {}),
      ...(opts.responder_a && i === 0 ? { reply_to_message_id: opts.responder_a } : {}),
    });
  }
  return ultima;
}

async function editar(chat, message_id, texto, teclado) {
  return api('editMessageText', {
    chat_id: chat, message_id, text: texto, parse_mode: 'HTML',
    ...(teclado ? { reply_markup: { inline_keyboard: teclado } } : {}),
  }).catch(() => null);
}

// Repinta so os botoes de uma mensagem ja enviada — e assim que o painel
// reflete o que ja foi gerado sem virar uma cascata de mensagens novas.
async function editarTeclado(chat, message_id, teclado) {
  return api('editMessageReplyMarkup', { chat_id: chat, message_id,
                                         reply_markup: { inline_keyboard: teclado } }).catch(() => null);
}

async function enviarDocumento(chat, arquivo, nome, legenda) {
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  const dados = Buffer.isBuffer(arquivo) ? arquivo : fs.readFileSync(arquivo);
  fd.append('document', new Blob([dados]), nome);
  if (legenda) { fd.append('caption', legenda.slice(0, 1000)); fd.append('parse_mode', 'HTML'); }
  const r = await fetch(`${BASE()}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
  const j = await r.json();
  if (!j.ok) throw new Error('sendDocument: ' + j.description);
  return j.result;
}

async function acao(chat, tipo = 'typing') {
  return api('sendChatAction', { chat_id: chat, action: tipo }).catch(() => null);
}

async function responderBotao(id, texto = '', alerta = false) {
  return api('answerCallbackQuery', { callback_query_id: id, text: texto.slice(0, 200), show_alert: alerta }).catch(() => null);
}

// Baixa o arquivo do Telegram para destino local. Devolve {caminho, bytes}.
async function baixar(file_id, destino, bytesConhecidos = 0) {
  let f;
  try {
    f = await api('getFile', { file_id });
  } catch (e) {
    if (/too big/i.test(e.message)) { e.limite = true; e.bytes = bytesConhecidos; }
    throw e;
  }
  if (f.file_size && f.file_size > LIMITE_DOWNLOAD) {
    const e = new Error('grande'); e.limite = true; e.bytes = f.file_size; throw e;
  }
  // No servidor local o file_path ja e o caminho absoluto do arquivo: se o
  // volume estiver montado aqui, e so copiar — nada trafega por HTTP.
  if (LOCAL && f.file_path?.startsWith('/')) {
    const origem = process.env.TG_FILES_DIR
      ? path.join(process.env.TG_FILES_DIR, f.file_path.replace(/^.*?\/var\/lib\/telegram-bot-api\//, ''))
      : f.file_path;
    if (fs.existsSync(origem)) {
      const destinoLocal = path.join(destino, path.basename(origem));
      fs.copyFileSync(origem, destinoLocal);
      // O servidor local NAO limpa o que baixa — quem apaga e o bot. Sem isso,
      // cada video enviado fica ocupando disco para sempre.
      try { fs.unlinkSync(origem); } catch {}
      return { caminho: destinoLocal, bytes: fs.statSync(destinoLocal).size };
    }
  }
  const url = `${API}/file/bot${TOKEN}/${f.file_path}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error('download HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const nome = path.basename(f.file_path);
  const caminho = path.join(destino, nome);
  fs.writeFileSync(caminho, buf);
  return { caminho, bytes: buf.length };
}

module.exports = { api, esc, enviar, editar, editarTeclado, enviarDocumento, acao, responderBotao, baixar,
                   picotar, LIMITE_DOWNLOAD, LOCAL, API, temToken: () => !!TOKEN };
