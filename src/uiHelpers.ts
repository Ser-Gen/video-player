export function formatTime(value: number | null): string {
  if (value === null || Number.isNaN(value)) {
    return '--:--';
  }

  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function timelineRatioFromClientX(clientX: number, rectLeft: number, rectWidth: number): number {
  if (rectWidth <= 0) {
    return 0;
  }

  return clamp((clientX - rectLeft) / rectWidth, 0, 1);
}

export function timelineTimeFromRatio(ratio: number, durationSec: number | null): number {
  if (!durationSec || durationSec <= 0) {
    return 0;
  }

  return clamp(ratio, 0, 1) * durationSec;
}
