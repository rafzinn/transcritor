// formatos.js — o que o bot aceita como midia, por extensao. Fonte unica:
// o bot (index.js) e a pagina de upload (upload.js) barram pelo mesmo criterio.
const EXTS = /\.(opus|ogg|oga|wav|mp3|m4a|aac|flac|wma|amr|mp4|mkv|mov|avi|webm|3gp|mpeg|mpg|ts|wmv)$/i;
module.exports = { EXTS };
