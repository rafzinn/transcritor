// link.js — quando em vez de arquivo chega uma URL. yt-dlp da conta de
// Instagram, TikTok, X, Vimeo, Facebook, YouTube e de link direto pra arquivo.
//
// Cookies: alguns sites (YouTube sempre, a partir de IP de datacenter; o
// Instagram as vezes) exigem sessao logada. Basta deixar o arquivo Netscape em
// /opt/transcritor/cookies/<dominio>.txt que ele e usado automaticamente —
// copiado antes para area gravavel porque o yt-dlp reescreve o arquivo.
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');

const COOKIES  = process.env.COOKIES_DIR || '/app/cookies';
const MAX_MB   = Number(process.env.LINK_MAX_MB || 500);
const MAX_SEG  = Number(process.env.LINK_MAX_SEGUNDOS || 10800);   // 3h

const ehURL = (t) => /^https?:\/\/\S+$/i.test(String(t || '').trim());

function arquivoDeCookies(url, pasta) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  const raiz = host.split('.').slice(-2).join('.');
  for (const nome of [`${host}.txt`, `${raiz}.txt`]) {
    const p = path.join(COOKIES, nome);
    if (fs.existsSync(p)) {
      const copia = path.join(pasta, 'cookies.txt');
      fs.copyFileSync(p, copia);        // gravavel: o yt-dlp atualiza o arquivo
      return copia;
    }
  }
  return null;
}

function roda(args, timeoutMs) {
  return new Promise((ok, falha) => {
    execFile('yt-dlp', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => {
      if (e) { e.stderr = String(err || ''); return falha(e); }
      ok(String(out));
    });
  });
}

// Traduz o erro cru do yt-dlp pra algo que se leia no Telegram.
function explicar(stderr) {
  const s = String(stderr || '');
  if (/Sign in to confirm|not a bot|cookies/i.test(s))
    return 'Esse site esta exigindo login para baixar a partir do servidor. Precisa de cookies frescos — exporta a sessao do navegador e me avisa que eu instalo.';
  if (/login required|requires authentication|private/i.test(s))
    return 'Conteudo privado ou que exige login. So publico funciona sem cookies.';
  if (/Unsupported URL/i.test(s))
    return 'Nao sei baixar desse site. Manda o arquivo direto que eu transcrevo.';
  if (/File is larger|max-filesize/i.test(s))
    return `Passa de ${MAX_MB} MB. Manda um trecho ou so o audio.`;
  if (/does not pass filter/i.test(s))
    return `Video mais longo que o teto de ${(MAX_SEG / 3600).toFixed(0)}h.`;
  if (/HTTP Error 4\d\d/i.test(s))
    return `O site recusou o download (${(s.match(/HTTP Error \d+/) || ['erro'])[0]}). Costuma ser bloqueio ao IP do servidor.`;
  const ultimoErro = s.split('\n').filter((l) => /ERROR/.test(l)).slice(-1)[0];
  return 'Nao consegui baixar desse link: ' + (ultimoErro ? ultimoErro.slice(0, 200) : 'erro desconhecido');
}

async function metadados(url, pasta) {
  const ck = arquivoDeCookies(url, pasta);
  const args = ['--no-warnings', '--no-playlist', '--skip-download', '--dump-single-json'];
  if (ck) args.push('--cookies', ck);
  args.push(url);
  const j = JSON.parse(await roda(args, 120000));
  return { titulo: j.title || 'video', duracao: Number(j.duration || 0), site: j.extractor_key || '?',
           autor: j.uploader || j.channel || '' };
}

// Baixa so a trilha de audio: e o que interessa e economiza banda e tempo.
async function baixar(url, pasta) {
  const ck = arquivoDeCookies(url, pasta);
  const saida = path.join(pasta, 'baixado.%(ext)s');
  const args = ['--no-warnings', '--no-playlist', '--restrict-filenames',
                '-f', 'ba/bestaudio/best',
                '--max-filesize', `${MAX_MB}M`,
                // dois --match-filter sao avaliados como OR: passa se couber na
                // duracao OU se o site nao informar duracao nenhuma
                '--match-filter', `duration<${MAX_SEG}`,
                '--match-filter', '!duration',
                '-o', saida];
  if (ck) args.push('--cookies', ck);
  args.push(url);
  try {
    await roda(args, 900000);
  } catch (e) {
    const err = new Error(explicar(e.stderr || e.message));
    err.amigavel = true;
    throw err;
  }
  const achado = fs.readdirSync(pasta).find((f) => f.startsWith('baixado.'));
  if (!achado) { const e = new Error(explicar('sem arquivo')); e.amigavel = true; throw e; }
  const caminho = path.join(pasta, achado);
  return { caminho, bytes: fs.statSync(caminho).size, nome: achado };
}

module.exports = { ehURL, baixar, metadados, explicar, MAX_MB, MAX_SEG };
