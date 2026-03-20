/**
 * Storage for directory handles using IndexedDB
 * Allows persisting directory access across page refreshes
 */

import { openDB, STORE_DIRECTORY_HANDLES } from './idbHelper';

const STORE_NAME = STORE_DIRECTORY_HANDLES;
const KEY_NAME = 'export_directory';

interface StoredDirectory {
  label: string; // Display name like "Desktop" or folder name
  handle: FileSystemDirectoryHandle; // The actual directory handle
}

/**
 * Store directory handle
 * @param directoryHandle Directory handle to store
 * @param label Display label for the directory
 */
export async function storeDirectoryHandle(
  directoryHandle: FileSystemDirectoryHandle,
  label: string
): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Store the handle (it's serializable in modern browsers)
    const data: StoredDirectory = {
      label,
      handle: directoryHandle
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.put(data, KEY_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('Failed to store directory handle:', error);
    // Non-critical, continue without persistence
  }
}

/**
 * Retrieve stored directory handle
 * @returns Stored directory handle and label, or null if not found/invalid
 */
export async function getStoredDirectoryHandle(): Promise<StoredDirectory | null> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const data = await new Promise<StoredDirectory | null>((resolve, reject) => {
      const request = store.get(KEY_NAME);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });

    if (!data || !data.handle) {
      return null;
    }

    // Verify the handle is still valid by checking permission
    try {
      // queryPermission may not be in TypeScript types but exists at runtime
      const handle = data.handle as any;
      if (handle.queryPermission) {
        const permission = await handle.queryPermission({ mode: 'readwrite' });
        if (permission === 'granted') {
          return data;
        }
        // Permission lost, clear stored handle
        await clearStoredDirectoryHandle();
        return null;
      }
      // If queryPermission doesn't exist, assume permission is still valid
      return data;
    } catch (error) {
      // Handle invalid, clear it
      await clearStoredDirectoryHandle();
      return null;
    }
  } catch (error) {
    console.warn('Failed to retrieve directory handle:', error);
    return null;
  }
}

/**
 * Clear stored directory handle
 */
export async function clearStoredDirectoryHandle(): Promise<void> {
  try {
    const db = await openDB();
    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    await new Promise<void>((resolve, reject) => {
      const request = store.delete(KEY_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.warn('Failed to clear directory handle:', error);
  }
}

/**
 * Get display label for a directory handle
 * @param directoryHandle Directory handle
 * @returns Display label (folder name or "Desktop"/"Documents" if applicable)
 */
export async function getDirectoryLabel(directoryHandle: FileSystemDirectoryHandle): Promise<string> {
  try {
    // Try to get the name property (available in some browsers)
    if ('name' in directoryHandle && directoryHandle.name) {
      return directoryHandle.name;
    }
    // Fallback: try to get from the handle's path (not always available)
    // For now, use a generic label
    return 'Selected Folder';
  } catch (error) {
    return 'Selected Folder';
  }
}

