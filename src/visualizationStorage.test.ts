import { defaultVisualizationSettings, readStoredVisualizationSettings, VISUALIZATION_STORAGE_KEY, writeStoredVisualizationSettings } from './visualizationStorage';

describe('visualization storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when no value is stored', () => {
    expect(readStoredVisualizationSettings()).toEqual(defaultVisualizationSettings());
  });

  it('writes and restores visualization settings', () => {
    writeStoredVisualizationSettings({
      visualizationEnabledForVideo: true,
      selectedPresetId: 'Preset A',
      autoCycleIntervalSec: 120,
    });

    expect(localStorage.getItem(VISUALIZATION_STORAGE_KEY)).toBe(
      '{"visualizationEnabledForVideo":true,"selectedPresetId":"Preset A","autoCycleIntervalSec":120}',
    );
    expect(readStoredVisualizationSettings()).toEqual({
      visualizationEnabledForVideo: true,
      selectedPresetId: 'Preset A',
      autoCycleIntervalSec: 120,
    });
  });
});
