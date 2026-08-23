// copy.js — o que se faz com o texto depois de transcrito: resumir, virar
// legenda de Reels e virar arquivo .srt.
const openai = require('./openai');

const SIS_RESUMO = `Voce resume transcricoes em portugues do Brasil.
Escreva direto, sem enrolacao e sem inventar nada que nao esteja no texto.
Formato da resposta (texto puro, sem markdown de titulo):
RESUMO: um paragrafo de no maximo 4 linhas.
PONTOS:
- de 3 a 7 marcadores com o que realmente importa
ACOES: so se o texto contiver tarefas, prazos ou compromissos; senao omita a secao.`;

async function resumir(texto) {
  return openai.escrever({
    sistema: SIS_RESUMO,
    usuario: `Transcricao:\n\n${texto.slice(0, 90000)}`,
    temperatura: 0.3,
  });
}

const SIS_REELS = `Voce e redator de performance para Instagram Reels, em portugues do Brasil.
Recebe a transcricao de um video e devolve a legenda de publicacao — texto NOVO
e persuasivo, nunca uma copia da transcricao.

Regras duras:
- O gancho precisa ser lido em ate 3 segundos (no maximo 12 palavras) e abrir uma
  lacuna de curiosidade: promessa, contradicao, numero ou erro comum. Nunca comece
  com "voce sabia" nem com saudacao.
- A legenda entrega o valor prometido pelo gancho, em 3 a 6 linhas curtas, com
  quebra de linha entre as ideias. Tom de conversa, segunda pessoa, zero jargao
  corporativo, zero emoji em excesso (no maximo 2 na legenda inteira).
- CTA de uma linha, especifico e coerente com o conteudo (comentar palavra,
  salvar, chamar no direct).
- EXATAMENTE 5 hashtags, minusculas, sem acento e sem numero solto. Elas sao SEO,
  nao decoracao: 1 do segmento amplo, 3 do tema especifico do video, 1 de cauda
  longa (nicho + intencao ou nicho + regiao, se a regiao aparecer no texto).
  Proibido hashtag generica de alcance (viral, fyp, explorar, foryou, tiktok).
  Escreva cada hashtag corretamente, sem erro de digitacao e sem palavra inventada:
  tem que ser termo que gente de verdade digita na busca.
- texto_na_tela e a frase que aparece sobreposta no primeiro segundo do video:
  no maximo 6 palavras, caixa alta opcional.

Responda SOMENTE um JSON com as chaves:
{"segmento": "...", "gancho": "...", "texto_na_tela": "...", "legenda": "...",
 "cta": "...", "hashtags": ["...","...","...","...","..."]}`;

async function reels(texto, ganchosAnteriores = []) {
  // Ao pedir outra versao, os ganchos ja usados entram como proibicao: sem
  // isso o modelo devolve a mesma ideia com outras palavras.
  const evitar = ganchosAnteriores.length
    ? `\n\nJa foram usados estes angulos — use um ANGULO DIFERENTE, nao uma reescrita:\n` +
      ganchosAnteriores.map((g) => `- ${g}`).join('\n')
    : '';
  const r = await openai.escrever({
    sistema: SIS_REELS + evitar,
    usuario: `Transcricao do video:\n\n${texto.slice(0, 60000)}`,
    json: true,
    temperatura: 0.9,
  });
  const d = r.dados || {};
  d.hashtags = (Array.isArray(d.hashtags) ? d.hashtags : [])
    .map((h) => '#' + String(h).replace(/^#/, '').trim().toLowerCase().replace(/\s+/g, ''))
    .filter(Boolean).slice(0, 5);
  return { ...r, dados: d };
}

// Legenda pronta pra colar no Instagram: gancho, corpo, CTA e hashtags.
function montarLegenda(d) {
  return [d.gancho, '', d.legenda, '', d.cta, '', (d.hashtags || []).join(' ')]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const relogio = (s) => {
  const ms = Math.floor((s % 1) * 1000);
  const t  = Math.floor(s);
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

function montarSRT(segmentos) {
  return segmentos.map((s, i) =>
    `${i + 1}\n${relogio(s.inicio)} --> ${relogio(s.fim)}\n${s.texto}\n`).join('\n');
}

module.exports = { resumir, reels, montarLegenda, montarSRT };
