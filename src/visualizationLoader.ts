import { buildVisualizationPresetCatalog, type VisualizationPresetCategory, type VisualizationPresetEntry } from './visualizationPresets';

export interface VisualizationPresetCatalog {
  presetEntries: VisualizationPresetEntry[];
  presetCategories: VisualizationPresetCategory[];
}

export async function loadVisualizationPresetCatalog(): Promise<VisualizationPresetCatalog> {
  const module = await import('butterchurn-presets');
  const presetLibrary = module.default;
  return buildVisualizationPresetCatalog(presetLibrary.getPresets());
}
