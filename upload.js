// upload.js — entrada alternativa ao Telegram: uma pagina web com area de
// arrastar-e-soltar que grava o arquivo direto em data/inbox. O bot varre
// essa pasta e transcreve como se o arquivo tivesse chegado pelo chat, e a
// resposta cai no mesmo chat do Telegram.
//
// Por que existe: pelo Telegram o arquivo faz dois saltos (celular -> nuvem
// do Telegram -> servidor) e a velocidade e a que o Telegram deixa. Aqui o
// arquivo vai direto pro servidor — numa rede privada (Tailscale, por
// exemplo) a velocidade vira a do link.
//
// SEM AUTENTICACAO PROPRIA: quem alcanca esta porta manda arquivo pro bot.
// Publique so em rede privada ou atras de um proxy que exija identidade —
// o stack.upload.yml ja vem com o middleware de rede privada obrigatorio.
//
// Zero dependencia: http nativo, o corpo do PUT vai em stream pro disco.
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { EXTS } = require('./lib/formatos');

const RAIZ   = process.env.DATA_DIR || '/app/data';
const INBOX  = path.join(RAIZ, 'inbox');
const ESTADO = path.join(INBOX, '_estado.json');
const PORTA  = Number(process.env.UPLOAD_PORT || 8090);
const MAX    = Number(process.env.UPLOAD_MAX_MB || 4000) * 1024 * 1024;
const HTML   = fs.readFileSync(path.join(__dirname, 'web', 'index.html'));

fs.mkdirSync(INBOX, { recursive: true });

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const json = (res, codigo, obj) => {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

// Nome que vai pro disco: so o basename, sem caracteres que o shell ou o
// ffmpeg estranhem, com teto de tamanho. A extensao original fica — e ela
// que o ffprobe usa como dica.
function limparNome(bruto) {
  const base = path.basename(String(bruto || '')).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const limpo = base.replace(/[^\w.\-]+/g, '_').replace(/^[._]+/, '').slice(0, 100);
  return limpo || 'arquivo';
}

// Estado da fila = o que o bot anotou (_estado.json) + o que ainda esta na
// pasta sem anotacao (chegou, o bot ainda nao pegou). Quem esta na pasta e
// ainda "fila" pode ser cancelado; depois disso e com o bot.
function fila() {
  let anot = {};
  try { anot = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch {}
  const naPasta = new Set();
  for (const f of fs.readdirSync(INBOX)) {
    if (f.startsWith('_') || f.endsWith('.part')) continue;
    const [id, ...resto] = f.split('--');
    naPasta.add(id);
    if (!anot[id]) anot[id] = { nome: resto.join('--') || f, estado: 'fila', quando: fs.statSync(path.join(INBOX, f)).mtimeMs };
  }
  return Object.entries(anot)
    .map(([id, v]) => ({ id, ...v, cancelavel: v.estado === 'fila' && naPasta.has(id) }))
    .sort((a, b) => b.quando - a.quando)
    .slice(0, 50);
}

function receber(req, res, url) {
  const nome = limparNome(url.searchParams.get('nome'));
  if (!EXTS.test(nome)) return json(res, 415, { erro: `Formato nao aceito: ${nome}. Manda audio ou video.` });
  const tamanho = Number(req.headers['content-length'] || 0);
  if (tamanho > MAX) return json(res, 413, { erro: `Arquivo de ${(tamanho / 1048576).toFixed(0)} MB passa do teto de ${MAX / 1048576} MB.` });

  const id = novoId();
  const parcial = path.join(INBOX, `${id}.part`);
  const final   = path.join(INBOX, `${id}--${nome}`);
  const saida = fs.createWriteStream(parcial);
  let recebido = 0, morto = false;

  const abortar = (codigo, msg) => {
    if (morto) return;
    morto = true;
    saida.destroy();
    fs.rm(parcial, { force: true }, () => {});
    if (!res.headersSent) json(res, codigo, { erro: msg });
  };

  req.on('data', (c) => { recebido += c.length; if (recebido > MAX) abortar(413, 'Passou do teto durante o envio.'); });
  req.on('aborted', () => abortar(499, 'Envio interrompido.'));
  req.on('error', (e) => abortar(500, e.message));
  saida.on('error', (e) => abortar(500, `Disco: ${e.message}`));
  saida.on('finish', () => {
    if (morto) return;
    if (tamanho && recebido !== tamanho) return abortar(400, `Chegaram ${recebido} de ${tamanho} bytes.`);
    // O rename e atomico: o bot nunca ve um arquivo pela metade.
    fs.rename(parcial, final, (e) => {
      if (e) return abortar(500, e.message);
      json(res, 201, { id, nome, bytes: recebido });
    });
  });
  req.pipe(saida);
}

function cancelar(res, id) {
  const seguro = String(id).replace(/[^a-z0-9]/gi, '');
  const alvo = fs.readdirSync(INBOX).find((f) => f.startsWith(`${seguro}--`));
  if (!alvo) return json(res, 404, { erro: 'Esse item ja saiu da fila.' });
  fs.rmSync(path.join(INBOX, alvo), { force: true });
  json(res, 200, { ok: true });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(HTML);
  }
  if (req.method === 'GET'    && url.pathname === '/api/fila') return json(res, 200, { itens: fila(), maxMB: MAX / 1048576 });
  if (req.method === 'PUT'    && url.pathname === '/api/up')   return receber(req, res, url);
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/fila/')) return cancelar(res, url.pathname.slice(10));
  if (req.method === 'GET'    && url.pathname === '/api/saude') return json(res, 200, { ok: true });
  json(res, 404, { erro: 'nao existe' });
}).listen(PORTA, () => console.log(`[upload] na porta ${PORTA} · inbox=${INBOX} · teto=${MAX / 1048576} MB`));
