import type { VisualizationSettings } from './types';

export const VISUALIZATION_STORAGE_KEY = 'video-player:visualization-settings';

export function defaultVisualizationSettings(): VisualizationSettings {
  return {
    visualizationEnabledForVideo: false,
    selectedPresetId: null,
    autoCycleIntervalSec: 60,
  };
}

export function readStoredVisualizationSettings(): VisualizationSettings {
  const defaults = defaultVisualizationSettings();

  try {
    const rawValue = window.localStorage.getItem(VISUALIZATION_STORAGE_KEY);
    if (!rawValue) {
      return defaults;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<VisualizationSettings>;
    const autoCycleIntervalSec =
      parsedValue.autoCycleIntervalSec === 30 ||
      parsedValue.autoCycleIntervalSec === 60 ||
      parsedValue.autoCycleIntervalSec === 120 ||
      parsedValue.autoCycleIntervalSec === 300 ||
      parsedValue.autoCycleIntervalSec === null
        ? parsedValue.autoCycleIntervalSec
        : defaults.autoCycleIntervalSec;

    return {
      visualizationEnabledForVideo:
        typeof parsedValue.visualizationEnabledForVideo === 'boolean'
          ? parsedValue.visualizationEnabledForVideo
          : defaults.visualizationEnabledForVideo,
      selectedPresetId: typeof parsedValue.selectedPresetId === 'string' ? parsedValue.selectedPresetId : null,
      autoCycleIntervalSec,
    };
  } catch {
    return defaults;
  }
}

export function writeStoredVisualizationSettings(settings: VisualizationSettings): void {
  try {
    window.localStorage.setItem(VISUALIZATION_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage failures so the UI keeps working in restricted contexts.
  }
}
