#!/usr/bin/env node
// Teste de fumaça: exercita o caminho inteiro SEM Telegram nenhum.
// Gera uma amostra falada por TTS, embute num mp4, e verifica que audio e video
// chegam ao mesmo texto — depois legenda, resumo e Reels.
//
//   OPENAI_API_KEY=sk-... node scripts/smoke.js
//
// Custa alguns centavos de dolar por execucao.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
const media  = require('../lib/media');
const openai = require('../lib/openai');
const copy   = require('../lib/copy');
const precos = require('../lib/precos');

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-arq-'));
const FALA = 'Fala, pessoal! Aqui e o Rafael da barbearia Corte Nobre, em Copacabana. ' +
  'Muita gente acha que degrade bom depende so da maquina, mas o segredo esta na transicao ' +
  'feita com o pente aberto antes de qualquer navalha.';

let falhas = 0;
const ok  = (t, extra = '') => console.log(`  ok    ${t}${extra ? ' — ' + extra : ''}`);
const nok = (t, e) => { falhas++; console.log(`  FALHA ${t} — ${e}`); };

async function etapa(titulo, fn) {
  try { const r = await fn(); ok(titulo, r || ''); return r; }
  catch (e) { nok(titulo, e.message); return null; }
}

(async () => {
  console.log('\ntranscritor · teste de fumaca\n');

  if (!openai.temChave()) { console.error('defina OPENAI_API_KEY'); process.exit(1); }

  await etapa('ffmpeg e ffprobe disponiveis', () => {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  });

  await etapa('TTS gera a amostra', async () => {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: FALA, response_format: 'mp3' }),
    });
    if (!r.ok) throw new Error((await r.text()).slice(0, 120));
    fs.writeFileSync(`${D}/amostra.mp3`, Buffer.from(await r.arrayBuffer()));
    return media.MB(fs.statSync(`${D}/amostra.mp3`).size);
  });

  await etapa('mp4 com video + audio', () => {
    execFileSync('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=10',
      '-i', `${D}/amostra.mp3`, '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-c:a', 'aac', `${D}/amostra.mp4`], { stdio: 'ignore' });
  });

  const textos = {};
  for (const arq of ['amostra.mp3', 'amostra.mp4']) {
    await etapa(`transcreve ${arq}`, async () => {
      const sonda = await media.inspecionar(`${D}/${arq}`);
      if (!sonda.temAudio) throw new Error('ffprobe nao viu faixa de audio');
      await media.paraOpus(`${D}/${arq}`, `${D}/${arq}.ogg`);
      const bytes = fs.statSync(`${D}/${arq}.ogg`).size;
      const t = await openai.transcrever({ arquivo: `${D}/${arq}.ogg` });
      if (!/barbearia/i.test(t.texto)) throw new Error('texto nao bate com a amostra');
      textos[arq] = t.texto;
      return `${media.MB(sonda.bytes)} -> ${media.MB(bytes)} · ${precos.fmtUSD(t.custo.usd)}`;
    });
  }

  await etapa('video e audio chegam ao mesmo texto', () => {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z ]/g, '').trim();
    if (norm(textos['amostra.mp3']).slice(0, 60) !== norm(textos['amostra.mp4']).slice(0, 60))
      throw new Error('divergiram');
  });

  await etapa('fatiamento preserva o deslocamento', async () => {
    const pedacos = await media.fatiar(`${D}/amostra.mp3.ogg`, 20, 10, `${D}/f`);
    if (pedacos.length < 2) throw new Error('nao fatiou');
    if (pedacos[1].offset !== 10) throw new Error('offset errado');
    return `${pedacos.length} pedacos`;
  });

  await etapa('legenda .srt com marcacao de tempo', async () => {
    const w = await openai.transcrever({ arquivo: `${D}/amostra.mp3.ogg`, comTempos: true });
    if (!w.segmentos.length) throw new Error('sem segmentos');
    const srt = copy.montarSRT(w.segmentos);
    if (!/\d\d:\d\d:\d\d,\d\d\d --> /.test(srt)) throw new Error('formato invalido');
    return `${w.segmentos.length} blocos · ${precos.fmtUSD(w.custo.usd)}`;
  });

  await etapa('resumo', async () => {
    const r = await copy.resumir(textos['amostra.mp3']);
    if (!/RESUMO/i.test(r.texto)) throw new Error('sem a secao RESUMO');
    return precos.fmtUSD(r.custo.usd);
  });

  await etapa('legenda de Reels', async () => {
    const r = await copy.reels(textos['amostra.mp3']);
    const d = r.dados;
    if (!d.gancho || !d.legenda) throw new Error('faltou gancho ou legenda');
    if (d.hashtags.length !== 5) throw new Error(`${d.hashtags.length} hashtags, deviam ser 5`);
    if (d.gancho.split(/\s+/).length > 12) throw new Error('gancho passa de 12 palavras');
    return `segmento "${d.segmento}" · ${precos.fmtUSD(r.custo.usd)}`;
  });

  fs.rmSync(D, { recursive: true, force: true });
  console.log(falhas ? `\n${falhas} falha(s)\n` : '\ntudo certo\n');
  process.exit(falhas ? 1 : 0);
})();
