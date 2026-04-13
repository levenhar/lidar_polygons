import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('MapPanel', () => {
  describe('AOI selection overlay', () => {
    const source = readFileSync(resolve(__dirname, 'MapPanel.tsx'), 'utf-8');

    it('renders aoi-selection-overlay exactly once to prevent duplicate popups', () => {
      const matches = source.match(/aoi-selection-overlay/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });

    it('contains only one isAoiSelectionMode AOI overlay block', () => {
      // Count the occurrences of the AOI overlay wrapper condition.
      // Multiple occurrences cause stacked popups that block the load button.
      const matches = source.match(/isAoiSelectionMode && \(\s*\n\s*<div className="aoi-selection-overlay"/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });

    it('contains only one Clipping Progress Overlay block', () => {
      const matches = source.match(/Clipping Progress Overlay/g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });
  });
});
