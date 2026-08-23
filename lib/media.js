// media.js — tudo que e ffmpeg. Estrategia: seja o que for que chegue
// (opus, ogg, wav, mp3, m4a, mp4, mkv, mov...), vira sempre a MESMA coisa:
// ogg/opus 16 kHz mono 16 kbps. 1h de fala fica em ~7 MB, bem abaixo do teto
// de 25 MB por request da OpenAI, e o upload voa.
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');

function roda(bin, args, timeoutMs = 600000) {
  return new Promise((ok, falha) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (e, out, err) => {
      if (e) { e.stderr = String(err || '').slice(-2000); return falha(e); }
      ok(String(out));
    });
  });
}

async function inspecionar(arquivo) {
  const saida = await roda('ffprobe', ['-v', 'quiet', '-print_format', 'json',
                                       '-show_format', '-show_streams', arquivo]);
  const j = JSON.parse(saida);
  const audio = (j.streams || []).find((s) => s.codec_type === 'audio');
  const video = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  return {
    duracao: Number(j.format?.duration || audio?.duration || 0),
    bytes:   Number(j.format?.size || 0),
    formato: j.format?.format_name || '?',
    codecAudio: audio?.codec_name || null,
    temAudio: !!audio,
    temVideo: !!video,
  };
}

// Extrai/normaliza o audio. -vn descarta a imagem: e assim que mp4/mkv/mov
// viram transcricao sem passo extra.
async function paraOpus(entrada, saida) {
  await roda('ffmpeg', ['-nostdin', '-y', '-i', entrada,
                        '-vn', '-ac', '1', '-ar', '16000',
                        '-c:a', 'libopus', '-b:a', '16k', '-application', 'voip',
                        saida]);
  return saida;
}

// Rede de seguranca: audio muito longo passa do teto da OpenAI mesmo em opus.
// Fatia por tempo e devolve o deslocamento de cada pedaco — o .srt precisa
// dele pra remontar os tempos corretos.
async function fatiar(arquivo, duracao, blocoS, pasta) {
  fs.mkdirSync(pasta, { recursive: true });
  const pedacos = [];
  for (let i = 0, t = 0; t < duracao; i++, t += blocoS) {
    const destino = path.join(pasta, `parte${String(i).padStart(3, '0')}.ogg`);
    await roda('ffmpeg', ['-nostdin', '-y', '-ss', String(t), '-t', String(blocoS),
                          '-i', arquivo, '-c', 'copy', destino]);
    if (fs.existsSync(destino) && fs.statSync(destino).size > 2000) pedacos.push({ caminho: destino, offset: t });
  }
  return pedacos;
}

const MB = (b) => (b / 1048576).toFixed(1) + ' MB';
function duracaoHumana(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(r).padStart(2, '0')}s` : `${r}s`;
}

module.exports = { inspecionar, paraOpus, fatiar, MB, duracaoHumana };
