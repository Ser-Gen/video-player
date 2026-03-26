import { clamp, formatTime, timelineRatioFromClientX, timelineTimeFromRatio } from './uiHelpers';

describe('ui helpers', () => {
  it('formats video time for the transport display', () => {
    expect(formatTime(65)).toBe('01:05');
    expect(formatTime(3661)).toBe('1:01:01');
  });

  it('clamps the timeline hover ratio to the track bounds', () => {
    expect(timelineRatioFromClientX(50, 0, 100)).toBe(0.5);
    expect(timelineRatioFromClientX(-10, 0, 100)).toBe(0);
    expect(timelineRatioFromClientX(150, 0, 100)).toBe(1);
  });

  it('converts timeline ratio into media time', () => {
    expect(timelineTimeFromRatio(0.5, 120)).toBe(60);
    expect(timelineTimeFromRatio(1.5, 120)).toBe(120);
    expect(timelineTimeFromRatio(0.5, null)).toBe(0);
  });

  it('clamps arbitrary numeric values', () => {
    expect(clamp(12, 0, 10)).toBe(10);
    expect(clamp(-5, 0, 10)).toBe(0);
  });
});
