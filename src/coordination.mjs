import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';

export const LOCK_NAME = 'run.lock';

export class StateBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateBusyError';
    this.code = 'STATE_BUSY';
  }
}

export function requestKey(requestId) {
  return createHash('sha256').update(String(requestId)).digest('hex').slice(0, 16);
}

export function recordPath(stateDir, requestId) {
  return path.join(stateDir, 'coordinations', requestKey(requestId) + '.json');
}

export function journalPath(stateDir) {
  return path.join(stateDir, 'journal.jsonl');
}

export function resultPath(stateDir) {
  return path.join(stateDir, 'result.json');
}

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return { corrupt: true, path: file };
    throw error;
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // 某些文件系统不支持对目录 fsync；原子重命名仍然是唯一可见性边界。
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function atomicWrite(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * 同一条业务请求同一时刻只允许一个执行者。锁只是防止并发重复操作；
 * 真正的恢复依据始终是门户回读与 journal 里已落盘的事实。
 */
export async function acquireStateLock(stateDir, requestId) {
  await mkdir(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, LOCK_NAME);
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const payload = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    requestId,
    token,
    startedAt,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    try {
      handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      return {
        file: lockFile,
        token,
        async release() {
          const current = await readJson(lockFile);
          if (current?.token === token) await unlink(lockFile).catch(() => {});
        },
      };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      const current = await readJson(lockFile);
      if (current && !current.corrupt && lockIsAlive(current)) {
        throw new StateBusyError(`同一状态目录已有执行在运行（pid ${current.pid}，请求 ${current.requestId}）`);
      }
      const staleFile = `${lockFile}.stale-${Date.now()}-${attempt}`;
      try {
        await rename(lockFile, staleFile);
      } catch (renameError) {
        if (renameError.code === 'ENOENT') continue;
        throw renameError;
      }
      await unlink(staleFile).catch(() => {});
    }
  }
  throw new StateBusyError('无法取得状态目录执行锁');
}

function lockIsAlive(lock) {
  const pid = Number(lock.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const age = Date.now() - Date.parse(lock.startedAt ?? '');
  if (lock.hostname !== os.hostname()) {
    // 无法跨主机探测存活，只把明显过期的锁视为遗留。
    return Number.isFinite(age) ? age < 10 * 60 * 1000 : true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function createJournal(stateDir, requestId) {
  await mkdir(stateDir, { recursive: true });
  const file = journalPath(stateDir);
  const handle = await open(file, 'a', 0o600);
  return {
    file,
    async append(event, detail = {}) {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        requestId,
        event,
        ...detail,
      }) + '\n';
      await handle.write(line);
      // 在下一步页面动作之前把意图与观察刷到磁盘，进程被强杀后仍可追溯。
      await handle.sync();
    },
    async close() {
      await handle.close();
    },
  };
}

export async function loadRecord(stateDir, requestId) {
  return readJson(recordPath(stateDir, requestId));
}

export async function saveRecord(stateDir, record) {
  await atomicWrite(recordPath(stateDir, record.requestId), JSON.stringify(record, null, 2));
}

export async function loadResult(stateDir) {
  return readJson(resultPath(stateDir));
}

export async function saveResult(stateDir, result) {
  await atomicWrite(resultPath(stateDir), JSON.stringify(result, null, 2));
}
