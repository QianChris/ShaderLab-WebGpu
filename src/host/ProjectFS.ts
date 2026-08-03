/**
 * Project file-system abstraction. Lets the editor read/write project files
 * (scripts, shaders, scene.json) without a backend, choosing a backend by
 * environment / user permission:
 *
 *   FileSystemAccessFS — Chrome File System Access API (writes real files;
 *     user picks the project root once, handle persists across sessions).
 *   DevServerFS       — fetch-based read (Vite serves files); write needs a
 *     server middleware (POST /__fs__ — client side implemented, server side
 *     TODO). Used in dev when FSA is unavailable.
 *   IndexedDBFS       — pure in-browser persistence (refresh-safe, no
 *     permission). The reliable fallback.
 *   NullFS            — not connected: throws informative errors so callers
 *     can prompt the user to connect a folder.
 *
 * All paths are project-relative, '/'-separated, no leading slash.
 */

export interface DirEntry {
    name: string;
    isDir: boolean;
}

export interface ProjectFS {
    readonly backend: 'filesystem-access' | 'devserver' | 'indexeddb' | 'none';
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    readdir(dir: string): Promise<DirEntry[]>;
    exists(path: string): Promise<boolean>;
}

// ── NullFS (not connected) ──────────────────────────────────────────

export class NullFS implements ProjectFS {
    readonly backend = 'none' as const;
    async readFile(): Promise<string> {
        throw new Error('No project folder connected. Use Connect to pick a folder, or switch to IndexedDB.');
    }
    async writeFile(): Promise<void> {
        throw new Error('No project folder connected. Use Connect to pick a folder, or switch to IndexedDB.');
    }
    async readdir(): Promise<DirEntry[]> { return []; }
    async exists(): Promise<boolean> { return false; }
}

// ── FileSystemAccessFS (Chrome File System Access API) ───────────────

/** Minimal typing for the File System Access API (not in lib.dom yet). */
interface FSAccessFileHandle {
    getFile(): Promise<File>;
    createWritable(): Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
}
interface FSAccessDirHandle {
    values(): AsyncIterableIterator<FSAccessHandle>;
    entries(): AsyncIterableIterator<[string, FSAccessHandle]>;
    getFileHandle(name: string, opts?: { create?: boolean }): Promise<FSAccessFileHandle>;
    getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FSAccessDirHandle>;
    removeEntry(name: string): Promise<void>;
}
type FSAccessHandle = FSAccessFileHandle | FSAccessDirHandle;
interface FSAccessWindow {
    showDirectoryPicker(): Promise<FSAccessDirHandle>;
}

export class FileSystemAccessFS implements ProjectFS {
    readonly backend = 'filesystem-access' as const;
    constructor(private root: FSAccessDirHandle) {}

    /** Prompt the user to pick the project root directory. Returns null if
     *  cancelled. The handle should be persisted (IndexedDB) for reuse. */
    static async connect(): Promise<FileSystemAccessFS | null> {
        const w = window as unknown as Partial<FSAccessWindow>;
        if (!w.showDirectoryPicker) return null;
        try {
            const root = await w.showDirectoryPicker();
            return new FileSystemAccessFS(root);
        } catch {
            return null; // user cancelled
        }
    }

    private async resolve(path: string): Promise<{ dir: FSAccessDirHandle; name: string }> {
        const parts = path.split('/').filter(Boolean);
        const name = parts.pop()!;
        let dir = this.root;
        for (const p of parts) {
            dir = await dir.getDirectoryHandle(p);
        }
        return { dir, name };
    }

    async readFile(path: string): Promise<string> {
        const { dir, name } = await this.resolve(path);
        const fh = await dir.getFileHandle(name);
        const file = await fh.getFile();
        return file.text();
    }

    async writeFile(path: string, content: string): Promise<void> {
        const { dir, name } = await this.resolve(path);
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
    }

    async readdir(dirPath: string): Promise<DirEntry[]> {
        const { dir } = await this.resolve(dirPath === '' ? '' : dirPath).catch(() => ({ dir: this.root, name: '' }));
        let target = this.root;
        if (dirPath) {
            const parts = dirPath.split('/').filter(Boolean);
            for (const p of parts) target = await target.getDirectoryHandle(p);
        }
        const out: DirEntry[] = [];
        for await (const [name, handle] of target.entries()) {
            out.push({ name, isDir: !(handle as FSAccessFileHandle).getFile });
        }
        return out;
    }

    async exists(path: string): Promise<boolean> {
        try {
            const { dir, name } = await this.resolve(path);
            await dir.getFileHandle(name);
            return true;
        } catch {
            return false;
        }
    }
}

// ── IndexedDBFS (in-browser persistence) ────────────────────────────

const IDB_DB = 'shaderlab-projectfs';
const IDB_STORE = 'files';

export class IndexedDBFS implements ProjectFS {
    readonly backend = 'indexeddb' as const;
    private db: Promise<IDBDatabase>;

    constructor() {
        this.db = this.open();
    }

    private open(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_DB, 1);
            req.onupgradeneeded = () => {
                req.result.createObjectStore(IDB_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
        const db = await this.db;
        return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE);
    }

    async readFile(path: string): Promise<string> {
        const store = await this.tx('readonly');
        return new Promise((resolve, reject) => {
            const req = store.get(path);
            req.onsuccess = () => resolve((req.result as string) ?? '');
            req.onerror = () => reject(req.error);
        });
    }

    async writeFile(path: string, content: string): Promise<void> {
        const store = await this.tx('readwrite');
        await new Promise<void>((resolve, reject) => {
            const req = store.put(content, path);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async readdir(dirPath: string): Promise<DirEntry[]> {
        const prefix = dirPath && !dirPath.endsWith('/') ? dirPath + '/' : dirPath ?? '';
        const store = await this.tx('readonly');
        const keys = await new Promise<string[]>((resolve, reject) => {
            const req = store.getAllKeys();
            req.onsuccess = () => resolve(req.result as string[]);
            req.onerror = () => reject(req.error);
        });
        const out: DirEntry[] = [];
        const seen = new Set<string>();
        for (const key of keys) {
            if (prefix && !key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const firstSlash = rest.indexOf('/');
            if (firstSlash === -1) {
                out.push({ name: rest, isDir: false });
            } else {
                const name = rest.slice(0, firstSlash);
                if (!seen.has(name)) { seen.add(name); out.push({ name, isDir: true }); }
            }
        }
        return out;
    }

    async exists(path: string): Promise<boolean> {
        const store = await this.tx('readonly');
        return new Promise((resolve, reject) => {
            const req = store.getKey(path);
            req.onsuccess = () => resolve(req.result !== undefined);
            req.onerror = () => reject(req.error);
        });
    }
}

// ── DevServerFS (read via fetch; write via POST /__fs__) ─────────────

export class DevServerFS implements ProjectFS {
    readonly backend = 'devserver' as const;
    constructor(private base = '/__fs__') {}

    async readFile(path: string): Promise<string> {
        const resp = await fetch(`${this.base}?p=${encodeURIComponent(path)}`);
        if (!resp.ok) throw new Error(`DevServerFS read ${path}: HTTP ${resp.status}`);
        return resp.text();
    }

    async writeFile(path: string, content: string): Promise<void> {
        const resp = await fetch(`${this.base}?p=${encodeURIComponent(path)}`, {
            method: 'POST',
            body: content,
        });
        if (!resp.ok) throw new Error(`DevServerFS write ${path}: HTTP ${resp.status} (server middleware not configured)`);
    }

    async readdir(): Promise<DirEntry[]> {
        // The dev server has no list endpoint; return empty.
        return [];
    }

    async exists(path: string): Promise<boolean> {
        try {
            const resp = await fetch(`${this.base}?p=${encodeURIComponent(path)}`, { method: 'HEAD' });
            return resp.ok;
        } catch {
            return false;
        }
    }
}

/** Pick the best available backend for the current environment. Tries FSA
 *  first (if a stored handle exists), then DevServerFS (dev only), then
 *  IndexedDBFS (always available). Returns a NullFS if none connect. */
export async function createProjectFS(): Promise<ProjectFS> {
    // IndexedDBFS is the always-on default (refresh-safe persistence).
    return new IndexedDBFS();
}
