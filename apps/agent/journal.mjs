import { open, readFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
export class Journal {
  constructor(path) { this.path = path; }
  async lock(fn) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(`${this.path}.lock`, 'wx', 0o600); }
    catch (error) {
      if(error.code!=='EEXIST')throw error;
      const pid=Number(await readFile(`${this.path}.lock`,'utf8'));
      if(!Number.isSafeInteger(pid)||pid<1)throw new Error('journal_locked');
      try { process.kill(pid,0); throw new Error('journal_locked'); }
      catch(e){if(e.code!=='ESRCH')throw e;}
      // Serialize reclaimers; an interrupted reclamation fails closed.
      const recovery=await open(`${this.path}.reclaim`,'wx',0o600);
      try {
        if(Number(await readFile(`${this.path}.lock`,'utf8'))!==pid)throw new Error('journal_locked');
        await unlink(`${this.path}.lock`);lock=await open(`${this.path}.lock`,'wx',0o600);
      } finally {await recovery.close();await unlink(`${this.path}.reclaim`);}
    }
    try {
      await lock.writeFile(String(process.pid)); await lock.sync();
      try {
        const info = await stat(this.path);
        if (info.mode & 0o077) throw new Error('journal_permissions');
        this.data = JSON.parse(await readFile(this.path, 'utf8'));
      } catch (e) { if (e.code !== 'ENOENT') throw e; this.data = { version: 1, intents: {}, cursor: null }; }
      if (this.data.version !== 1) throw new Error('journal_version');
      return await fn(this);
    } finally { await lock.close(); await unlink(`${this.path}.lock`); }
  }
  async save() {
    const tmp = `${this.path}.${process.pid}.tmp`;
    const file = await open(tmp, 'w', 0o600);
    try { await file.writeFile(JSON.stringify(this.data)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, this.path);
    const dir = await open(dirname(this.path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  }
}
