/**
 * IndexedDB storage for auto-save state.
 * Stores file handle, enabled flag, and a project JSON snapshot for crash recovery.
 */

import { openDB, STORE_AUTO_SAVE } from './idbHelper';

const KEY = 'auto_save_state';

export interface AutoSaveState {
  enabled: boolean;
  fileName: string;
  fileHandle: FileSystemFileHandle | null;
  projectSnapshot: string;   // full JSON for crash recovery
  savedAt: string;            // ISO timestamp
}

export async function storeAutoSaveState(state: AutoSaveState): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_AUTO_SAVE], 'readwrite');
    const store = tx.objectStore(STORE_AUTO_SAVE);
    await new Promise<void>((resolve, reject) => {
      const req = store.put(state, KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn('Failed to store auto-save state:', error);
  }
}

export async function getAutoSaveState(): Promise<AutoSaveState | null> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_AUTO_SAVE], 'readonly');
    const store = tx.objectStore(STORE_AUTO_SAVE);
    return await new Promise<AutoSaveState | null>((resolve, reject) => {
      const req = store.get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn('Failed to read auto-save state:', error);
    return null;
  }
}

export async function clearAutoSaveState(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_AUTO_SAVE], 'readwrite');
    const store = tx.objectStore(STORE_AUTO_SAVE);
    await new Promise<void>((resolve, reject) => {
      const req = store.delete(KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn('Failed to clear auto-save state:', error);
  }
}

export async function updateAutoSaveSnapshot(json: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_AUTO_SAVE], 'readwrite');
    const store = tx.objectStore(STORE_AUTO_SAVE);
    const existing = await new Promise<AutoSaveState | null>((resolve, reject) => {
      const req = store.get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!existing) return;
    existing.projectSnapshot = json;
    existing.savedAt = new Date().toISOString();
    await new Promise<void>((resolve, reject) => {
      const req = store.put(existing, KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn('Failed to update auto-save snapshot:', error);
  }
}
