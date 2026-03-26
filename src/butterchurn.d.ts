declare module 'butterchurn' {
  export interface ButterchurnVisualizer {
    connectAudio(audioNode: AudioNode): void;
    loadPreset(preset: unknown, blendTimeSec: number): void;
    render(): void;
    setRendererSize(width: number, height: number): void;
  }

  const butterchurn: {
    createVisualizer(
      audioContext: AudioContext,
      canvas: HTMLCanvasElement,
      options: {
        width: number;
        height: number;
      },
    ): ButterchurnVisualizer;
  };

  export default butterchurn;
}

declare module 'butterchurn-presets' {
  const butterchurnPresets: {
    getPresets(): Record<string, unknown>;
  };

  export default butterchurnPresets;
}

declare module 'butterchurn/lib/isSupported.min' {
  const isButterchurnSupported: () => boolean;
  export default isButterchurnSupported;
}
