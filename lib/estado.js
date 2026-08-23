// estado.js — memoria de disco. Guarda cada transcricao (pros botoes ainda
// funcionarem depois de um redeploy) e o gasto acumulado por dia.
const fs   = require('fs');
const path = require('path');

const RAIZ   = process.env.DATA_DIR || '/app/data';
const JOBS   = path.join(RAIZ, 'jobs');
const AUDIOS = path.join(RAIZ, 'audios');
const GASTOS = path.join(RAIZ, 'gastos.json');
const VALIDADE_DIAS = Number(process.env.VALIDADE_DIAS || 14);

fs.mkdirSync(JOBS, { recursive: true });
fs.mkdirSync(AUDIOS, { recursive: true });

const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function salvar(job) {
  fs.writeFileSync(path.join(JOBS, `${job.id}.json`), JSON.stringify(job, null, 1));
  return job;
}

function ler(id) {
  try { return JSON.parse(fs.readFileSync(path.join(JOBS, `${String(id).replace(/[^a-z0-9]/gi, '')}.json`), 'utf8')); }
  catch { return null; }
}

function faxina() {
  const limite = Date.now() - VALIDADE_DIAS * 86400000;
  for (const dir of [JOBS, AUDIOS]) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch {}
    }
  }
}

function anotarGasto(usd, rotulo) {
  let g = {};
  try { g = JSON.parse(fs.readFileSync(GASTOS, 'utf8')); } catch {}
  const dia = new Date().toISOString().slice(0, 10);
  g[dia] = g[dia] || { usd: 0, chamadas: {} };
  g[dia].usd += usd;
  g[dia].chamadas[rotulo] = (g[dia].chamadas[rotulo] || 0) + 1;
  fs.writeFileSync(GASTOS, JSON.stringify(g, null, 1));
  return g;
}

function gastos() {
  let g = {};
  try { g = JSON.parse(fs.readFileSync(GASTOS, 'utf8')); } catch {}
  const hoje = new Date().toISOString().slice(0, 10);
  const mes  = hoje.slice(0, 7);
  let usdHoje = 0, usdMes = 0, usdTotal = 0, chamadasMes = {};
  for (const [dia, v] of Object.entries(g)) {
    usdTotal += v.usd;
    if (dia === hoje) usdHoje = v.usd;
    if (dia.startsWith(mes)) {
      usdMes += v.usd;
      for (const [k, n] of Object.entries(v.chamadas || {})) chamadasMes[k] = (chamadasMes[k] || 0) + n;
    }
  }
  return { usdHoje, usdMes, usdTotal, chamadasMes, dias: Object.keys(g).length };
}

module.exports = { RAIZ, AUDIOS, novoId, salvar, ler, faxina, anotarGasto, gastos };
