describe('volume persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    vi.resetModules();
  });

  it('restores saved volume settings on mount', async () => {
    localStorage.setItem(
      'video-player:volume-settings',
      JSON.stringify({
        volume: 0.35,
        muted: false,
      }),
    );

    await import('./main');

    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element');
    const volumeInput = document.querySelector<HTMLInputElement>('#volume-input');

    expect(mediaElement).not.toBeNull();
    expect(volumeInput).not.toBeNull();
    expect(mediaElement!.volume).toBeCloseTo(0.35);
    expect(mediaElement!.muted).toBe(false);
    expect(volumeInput!.value).toBe('35');
  });

  it('stores volume changes in localStorage', async () => {
    await import('./main');

    const mediaElement = document.querySelector<HTMLVideoElement>('#media-element');
    const volumeInput = document.querySelector<HTMLInputElement>('#volume-input');

    expect(mediaElement).not.toBeNull();
    expect(volumeInput).not.toBeNull();

    volumeInput!.value = '27';
    volumeInput!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(mediaElement!.volume).toBeCloseTo(0.27);
    expect(localStorage.getItem('video-player:volume-settings')).toBe('{"volume":0.27,"muted":false}');
  });
});
