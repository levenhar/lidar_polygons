/**
 * Shared IndexedDB helper for the LiDAR Mission Planner.
 * All object stores are created here so a single DB version bump covers everything.
 */

export const DB_NAME = 'lidar_mission_planner';
export const DB_VERSION = 2;

export const STORE_DIRECTORY_HANDLES = 'directory_handles';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_DIRECTORY_HANDLES)) {
        db.createObjectStore(STORE_DIRECTORY_HANDLES);
      }
    };
  });
}
