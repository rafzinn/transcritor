// openai.js — as duas chamadas que o bot faz: transcrever audio e escrever
// texto. Toda resposta ja volta com o custo calculado, porque o relatorio de
// gasto e parte do produto aqui, nao um extra.
const fs = require('fs');
const path = require('path');
const precos = require('./precos');

function segredo(nome) {
  try { return fs.readFileSync(`/run/secrets/${nome}`, 'utf8').trim(); } catch { return ''; }
}
const CHAVE = segredo('OPENAI_API_KEY') || process.env.OPENAI_API_KEY || '';

// gpt-4o-transcribe erra menos em PT-BR falado; whisper-1 e o unico que
// devolve marcacao de tempo, entao ele e obrigatorio quando o pedido e .srt.
const MODELO_RAPIDO  = process.env.MODELO_TRANSCRICAO || 'gpt-4o-transcribe';
const MODELO_TEMPO   = 'whisper-1';
const MODELO_TEXTO   = process.env.MODELO_TEXTO || 'gpt-4.1-mini';

const PROMPT_VIES = 'Transcricao em portugues do Brasil, com pontuacao e paragrafos naturais.';

async function transcrever({ arquivo, comTempos = false, idioma = 'pt', offset = 0, modelo: escolhido }) {
  // .srt so existe com whisper-1: e o unico que devolve marcacao de tempo.
  const modelo = comTempos ? MODELO_TEMPO : (escolhido || MODELO_RAPIDO);
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(arquivo)]), path.basename(arquivo));
  fd.append('model', modelo);
  if (idioma) fd.append('language', idioma);
  fd.append('prompt', PROMPT_VIES);
  fd.append('response_format', comTempos ? 'verbose_json' : 'json');

  const t0 = Date.now();
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAVE}` },
    body: fd,
    signal: AbortSignal.timeout(600000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j.error?.message || 'falhou'}`);

  const segundos = Number(j.duration || 0);
  const custo = precos.custoTranscricao(modelo, j.usage, segundos);
  return {
    texto: (j.text || '').trim(),
    // offset realinha os tempos quando o audio veio fatiado
    segmentos: (j.segments || []).map((s) => ({ inicio: s.start + offset, fim: s.end + offset, texto: (s.text || '').trim() })),
    modelo, segundos, custo, ms: Date.now() - t0,
  };
}

async function escrever({ sistema, usuario, json = false, modelo = MODELO_TEXTO, temperatura = 0.8 }) {
  const t0 = Date.now();
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${CHAVE}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelo,
      temperature: temperatura,
      messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(180000),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j.error?.message || 'falhou'}`);
  const bruto = j.choices?.[0]?.message?.content || '';
  return {
    texto: bruto.trim(),
    dados: json ? JSON.parse(bruto) : null,
    modelo, custo: precos.custoTexto(modelo, j.usage), ms: Date.now() - t0,
  };
}

module.exports = { transcrever, escrever, MODELO_RAPIDO, MODELO_TEMPO, MODELO_TEXTO, temChave: () => !!CHAVE };
