import { open, readFile, rename, unlink, mkdir, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
export class Journal {
  constructor(path, identity) {
    this.path = path;
    this.identity = identity;
  }
  async lock(fn) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let lock;
    try {
      lock = await open(`${this.path}.lock`, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await lstat(`${this.path}.lock`)).isSymbolicLink()) throw new Error("journal_symlink");
      const pid = Number(await readFile(`${this.path}.lock`, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("journal_locked");
      try {
        process.kill(pid, 0);
        throw new Error("journal_locked");
      } catch (e) {
        if (e.code !== "ESRCH") throw e;
      }
      // Serialize reclaimers; an interrupted reclamation fails closed.
      const recovery = await open(`${this.path}.reclaim`, "wx", 0o600);
      try {
        if (Number(await readFile(`${this.path}.lock`, "utf8")) !== pid)
          throw new Error("journal_locked");
        await unlink(`${this.path}.lock`);
        lock = await open(`${this.path}.lock`, "wx", 0o600);
      } finally {
        await recovery.close();
        await unlink(`${this.path}.reclaim`);
      }
    }
    try {
      await lock.writeFile(String(process.pid));
      await lock.sync();
      try {
        const info = await lstat(this.path);
        if (info.isSymbolicLink() || !info.isFile()) throw new Error("journal_symlink");
        if (info.size > 67108864) throw new Error("journal_size");
        if (info.mode & 0o077) throw new Error("journal_permissions");
        const source = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await source.stat();
          if (opened.size > 67108864 || !opened.isFile() || opened.mode & 0o077)
            throw new Error("journal_size_or_permissions");
          const bytes = await source.readFile();
          if (bytes.length > 67108864) throw new Error("journal_size");
          this.data = JSON.parse(bytes.toString("utf8"));
        } finally {
          await source.close();
        }
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        this.data = { version: 1, intents: {}, cursor: null };
      }
      if (this.data.version !== 1) throw new Error("journal_version");
      if (this.identity) {
        if (this.data.identity && this.data.identity !== this.identity)
          throw new Error("journal_identity_changed");
        if (!this.data.identity) {
          if (Object.keys(this.data.intents).length) throw new Error("journal_identity_missing");
          this.data.identity = this.identity;
          await this.save();
        }
      }
      return await fn(this);
    } finally {
      await lock.close();
      await unlink(`${this.path}.lock`);
    }
  }
  async save() {
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(tmp, "wx", 0o600);
    try {
      const serialized = JSON.stringify(this.data);
      if (Buffer.byteLength(serialized) > 67108864) throw new Error("journal_size");
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, this.path);
    const dir = await open(dirname(this.path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
