// precos.js — fonte unica dos precos. Se a OpenAI mexer na tabela, mexe AQUI
// e em lugar nenhum mais. Valores em USD por 1 milhao de tokens (conferidos
// em 2026-08-23); whisper-1 e o unico que cobra por minuto de audio.
const TABELA = {
  'gpt-4o-transcribe':      { audio_in: 6.00, text_in: 2.50, text_out: 10.00 },
  'gpt-4o-mini-transcribe': { audio_in: 3.00, text_in: 1.25, text_out:  5.00 },
  'whisper-1':              { por_minuto: 0.006 },
  'gpt-4.1':                { text_in: 2.00, text_out: 8.00 },
  'gpt-4.1-mini':           { text_in: 0.40, text_out: 1.60 },
  'gpt-4o':                 { text_in: 2.50, text_out: 10.00 },
  'gpt-4o-mini':            { text_in: 0.15, text_out: 0.60 },
};

const USD_BRL = Number(process.env.USD_BRL || 5.40);

// A API de transcricao devolve usage em dois formatos: por token (modelos
// gpt-4o-*) ou por duracao (whisper-1). Normaliza os dois no mesmo objeto.
function custoTranscricao(modelo, usage, segundos) {
  const p = TABELA[modelo] || {};
  if (p.por_minuto) {
    const min = Math.max(segundos, 1) / 60;
    return { usd: min * p.por_minuto, base: `${min.toFixed(2)} min x US$ ${p.por_minuto}/min`,
             audio_in: 0, text_in: 0, text_out: 0 };
  }
  const det   = usage?.input_token_details || {};
  const audio = det.audio_tokens ?? usage?.input_tokens ?? 0;
  const texto = det.text_tokens  ?? 0;
  const saida = usage?.output_tokens ?? 0;
  const usd = (audio / 1e6) * (p.audio_in || 0)
            + (texto / 1e6) * (p.text_in  || 0)
            + (saida / 1e6) * (p.text_out || 0);
  return { usd, base: `${audio} tok audio + ${saida} tok texto`,
           audio_in: audio, text_in: texto, text_out: saida };
}

function custoTexto(modelo, usage) {
  const p = TABELA[modelo] || {};
  const ent = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const sai = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const cache = usage?.prompt_tokens_details?.cached_tokens || 0;
  const usd = ((ent - cache) / 1e6) * (p.text_in || 0)
            + (cache / 1e6) * (p.text_in || 0) * 0.25   // cache hit = 25% do preco
            + (sai / 1e6) * (p.text_out || 0);
  return { usd, text_in: ent, text_out: sai, cache };
}

const brl = (usd) => usd * USD_BRL;
const fmtUSD = (v) => 'US$ ' + (v < 0.01 ? v.toFixed(5) : v.toFixed(4));
const fmtBRL = (v) => 'R$ ' + brl(v).toFixed(v * USD_BRL < 0.01 ? 5 : 4).replace('.', ',');

module.exports = { TABELA, USD_BRL, custoTranscricao, custoTexto, brl, fmtUSD, fmtBRL };
