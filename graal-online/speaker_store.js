'use strict';
const fs = require('node:fs');
const path = require('node:path');

module.exports = function createSpeakerStore(pool, filename, report = () => {}) {
  let pending = null;
  let writing = false;
  let closed = false;

  async function load() {
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { }
    const result = await pool.query({ text: "SELECT v, updated_at FROM graal_kv WHERE k = 'speakers'", query_timeout: 10000 });
    const database = result.rows[0]?.v;
    return Number(disk?.savedAt || 0) > Number(database?.savedAt || 0) ? disk : (database || disk || { boxes: [] });
  }

  async function drain() {
    if (writing || closed) return;
    writing = true;
    while (pending && !closed) {
      const data = pending;
      pending = null;
      try {
        await pool.query({
          text: "INSERT INTO graal_kv (k,v,updated_at) VALUES ('speakers',$1::jsonb,$2) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v,updated_at=EXCLUDED.updated_at WHERE graal_kv.updated_at <= EXCLUDED.updated_at",
          values: [JSON.stringify(data), data.savedAt], query_timeout: 10000
        });
      } catch {
        pending = pending || data;
        report('As caixas estão ativas. O salvamento no banco será repetido.');
        await new Promise(resolve => { const timer = setTimeout(resolve, 3000); timer.unref(); });
      }
    }
    writing = false;
  }

  function save(data) {
    const copy = JSON.parse(JSON.stringify(data));
    pending = copy;
    try {
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename + '.tmp', JSON.stringify(copy), { mode: 0o600 });
      fs.renameSync(filename + '.tmp', filename);
    } catch { report('O backup local das caixas precisa ser verificado.'); }
    void drain();
  }

  return { load, save, close() { closed = true; } };
};
