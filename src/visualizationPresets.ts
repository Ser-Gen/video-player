export interface VisualizationPresetEntry {
  id: string;
  label: string;
  category: string;
  preset: unknown;
}

export interface VisualizationPresetCategory {
  id: string;
  label: string;
  presets: VisualizationPresetEntry[];
}

export function normalizeCategoryLabel(presetName: string): string {
  const dashIndex = presetName.indexOf(' - ');
  const colonIndex = presetName.indexOf(':');
  const splitIndex =
    dashIndex >= 0 && colonIndex >= 0 ? Math.min(dashIndex, colonIndex) : Math.max(dashIndex, colonIndex);
  const label = splitIndex > 0 ? presetName.slice(0, splitIndex).trim() : '';
  return label || 'Other';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildVisualizationPresetCatalog(
  presetMap: Record<string, unknown>,
): {
  presetEntries: VisualizationPresetEntry[];
  presetCategories: VisualizationPresetCategory[];
} {
  const presetEntries = Object.entries(presetMap)
    .map(([label, preset]) => ({
      id: label,
      label,
      category: normalizeCategoryLabel(label),
      preset,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const categoryMap = new Map<string, VisualizationPresetEntry[]>();
  for (const entry of presetEntries) {
    const list = categoryMap.get(entry.category) ?? [];
    list.push(entry);
    categoryMap.set(entry.category, list);
  }

  const presetCategories = Array.from(categoryMap.entries())
    .map(([label, presets]) => ({
      id: slugify(label) || 'other',
      label,
      presets,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  return { presetEntries, presetCategories };
}

export function pickRandomPresetId(
  presetIds: string[],
  currentPresetId: string | null,
  randomValue: number = Math.random(),
): string | null {
  if (presetIds.length === 0) {
    return null;
  }

  if (presetIds.length === 1) {
    return presetIds[0];
  }

  const candidateIds = currentPresetId === null ? presetIds : presetIds.filter((presetId) => presetId !== currentPresetId);
  if (candidateIds.length === 0) {
    return currentPresetId;
  }

  const index = Math.min(candidateIds.length - 1, Math.floor(randomValue * candidateIds.length));
  return candidateIds[index];
}
