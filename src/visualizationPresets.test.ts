import { buildVisualizationPresetCatalog, pickRandomPresetId } from './visualizationPresets';

describe('visualization preset catalog', () => {
  it('groups presets into categories derived from their names', () => {
    const catalog = buildVisualizationPresetCatalog({
      'Author A - Pulse': {},
      'Author A - Wave': {},
      'Artist B: Bloom': {},
      Standalone: {},
    });

    expect(catalog.presetCategories.map((category) => category.label)).toEqual(['Artist B', 'Author A', 'Other']);
    expect(catalog.presetCategories.find((category) => category.label === 'Author A')?.presets.map((preset) => preset.id)).toEqual([
      'Author A - Pulse',
      'Author A - Wave',
    ]);
    expect(catalog.presetCategories.find((category) => category.label === 'Other')?.presets.map((preset) => preset.id)).toEqual([
      'Standalone',
    ]);
  });

  it('picks a random preset without repeating the current one when alternatives exist', () => {
    const presetIds = ['one', 'two', 'three'];

    expect(pickRandomPresetId(presetIds, 'one', 0)).toBe('two');
    expect(pickRandomPresetId(presetIds, 'one', 0.99)).toBe('three');
  });
});
