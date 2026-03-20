import 'fake-indexeddb/auto';
import { storeAutoSaveState, getAutoSaveState, clearAutoSaveState, updateAutoSaveSnapshot, AutoSaveState } from './autoSaveStorage';

describe('autoSaveStorage', () => {
  const sampleState: AutoSaveState = {
    enabled: true,
    fileName: 'test_project.nehorai',
    fileHandle: null,
    projectSnapshot: '{"routes":[]}',
    savedAt: '2026-03-20T10:00:00.000Z'
  };

  beforeEach(async () => {
    // Clear between tests
    await clearAutoSaveState();
  });

  describe('storeAutoSaveState', () => {
    it('should store state and retrieve it', async () => {
      await storeAutoSaveState(sampleState);
      const result = await getAutoSaveState();
      expect(result).toEqual(sampleState);
    });
  });

  describe('getAutoSaveState', () => {
    it('should return null when no state is stored', async () => {
      const result = await getAutoSaveState();
      expect(result).toBeNull();
    });
  });

  describe('clearAutoSaveState', () => {
    it('should remove stored state', async () => {
      await storeAutoSaveState(sampleState);
      await clearAutoSaveState();
      const result = await getAutoSaveState();
      expect(result).toBeNull();
    });
  });

  describe('updateAutoSaveSnapshot', () => {
    it('should update only snapshot and savedAt', async () => {
      await storeAutoSaveState(sampleState);
      const newJson = '{"routes":[{"id":"r1"}]}';
      await updateAutoSaveSnapshot(newJson);
      const result = await getAutoSaveState();
      expect(result).not.toBeNull();
      expect(result!.projectSnapshot).toBe(newJson);
      expect(result!.savedAt).not.toBe(sampleState.savedAt);
      // Other fields unchanged
      expect(result!.enabled).toBe(true);
      expect(result!.fileName).toBe('test_project.nehorai');
    });

    it('should do nothing when no state exists', async () => {
      await updateAutoSaveSnapshot('{}');
      const result = await getAutoSaveState();
      expect(result).toBeNull();
    });
  });
});
