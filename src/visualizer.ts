import type { ButterchurnVisualizer } from 'butterchurn';
import { MediaAudioGraphController } from './audioGraph';
import type { VisualizationSupportState } from './types';

function getAudioContextConstructor():
  | (new () => AudioContext)
  | undefined {
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
}

function unsupportedState(reason: VisualizationSupportState['reason'], message: string): VisualizationSupportState {
  return {
    supported: false,
    reason,
    message,
  };
}

export function detectVisualizationSupport(): VisualizationSupportState {
  const AudioContextConstructor = getAudioContextConstructor();
  if (!AudioContextConstructor) {
    return unsupportedState('audio_graph_failed', 'Visualization is unavailable because the Web Audio API is not supported.');
  }

  try {
    const canvas = document.createElement('canvas');
    const webgl2Context = canvas.getContext('webgl2');
    if (!webgl2Context) {
      return unsupportedState(
        'webgl2_unavailable',
        'Visualization is unavailable because WebGL 2 is not supported in this browser.',
      );
    }
  } catch (error) {
    return unsupportedState(
      'webgl2_unavailable',
      error instanceof Error ? error.message : 'Visualization is unavailable because WebGL 2 support could not be verified.',
    );
  }

  return {
    supported: true,
    reason: 'supported',
    message: 'Visualization is available.',
  };
}

export interface VisualizerAdapter {
  readonly supportState: VisualizationSupportState;
  initialize(): Promise<VisualizationSupportState>;
  attachMediaElement(mediaElement: HTMLMediaElement): Promise<VisualizationSupportState>;
  loadPreset(preset: unknown, blendTimeSec?: number): void;
  resize(): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

export class ButterchurnVisualizerAdapter implements VisualizerAdapter {
  private connectedMediaElement: HTMLMediaElement | null = null;
  private visualizer: ButterchurnVisualizer | null = null;
  private animationFrameId: number | null = null;
  private butterchurnModulePromise: Promise<typeof import('butterchurn')> | null = null;
  supportState: VisualizationSupportState;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly audioGraph: MediaAudioGraphController = new MediaAudioGraphController(),
  ) {
    this.supportState = detectVisualizationSupport();
  }

  async initialize(): Promise<VisualizationSupportState> {
    if (!this.supportState.supported) {
      return this.supportState;
    }

    if (this.visualizer) {
      return this.supportState;
    }

    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      this.supportState = unsupportedState(
        'audio_graph_failed',
        'Visualization is unavailable because the Web Audio API is not supported.',
      );
      return this.supportState;
    }

    try {
      if (!this.visualizer) {
        this.butterchurnModulePromise ??= import('butterchurn');
        const butterchurnModule = await this.butterchurnModulePromise;
        const butterchurn = butterchurnModule.default;
        const audioGraphSupportState = await this.audioGraph.ensureInitialized();
        if (!audioGraphSupportState.supported) {
          this.supportState = unsupportedState('audio_graph_failed', audioGraphSupportState.message);
          return this.supportState;
        }
        const audioContext = this.audioGraph.getAudioContext();
        if (!audioContext) {
          this.supportState = unsupportedState('audio_graph_failed', 'Visualization is unavailable because the audio graph could not be initialized.');
          return this.supportState;
        }
        this.visualizer = butterchurn.createVisualizer(audioContext, this.canvas, {
          width: Math.max(1, this.canvas.clientWidth || this.canvas.width || 1),
          height: Math.max(1, this.canvas.clientHeight || this.canvas.height || 1),
        });
      }

      this.resize();
      this.supportState = {
        supported: true,
        reason: 'supported',
        message: 'Visualization is available.',
      };
    } catch (error) {
      this.supportState = unsupportedState(
        'butterchurn_init_failed',
        error instanceof Error ? error.message : 'Visualization is unavailable because Butterchurn failed to initialize.',
      );
    }

    return this.supportState;
  }

  async attachMediaElement(mediaElement: HTMLMediaElement): Promise<VisualizationSupportState> {
    const supportState = await this.initialize();
    if (!supportState.supported || !this.visualizer) {
      return supportState;
    }

    if (this.connectedMediaElement === mediaElement && this.audioGraph.getSourceNode()) {
      return this.supportState;
    }

    try {
      const audioGraphSupportState = await this.audioGraph.attachMediaElement(mediaElement);
      if (!audioGraphSupportState.supported) {
        this.supportState = unsupportedState('audio_graph_failed', audioGraphSupportState.message);
        return this.supportState;
      }
      const sourceNode = this.audioGraph.getSourceNode();
      if (!sourceNode) {
        this.supportState = unsupportedState('audio_graph_failed', 'Visualization is unavailable because the audio graph source is missing.');
        return this.supportState;
      }
      this.visualizer.connectAudio(sourceNode);
      this.connectedMediaElement = mediaElement;
      this.supportState = {
        supported: true,
        reason: 'supported',
        message: 'Visualization is available.',
      };
    } catch (error) {
      this.supportState = unsupportedState(
        'audio_graph_failed',
        error instanceof Error ? error.message : 'Visualization is unavailable because the audio graph could not be created.',
      );
    }

    return this.supportState;
  }

  loadPreset(preset: unknown, blendTimeSec: number = 2): void {
    if (!this.visualizer) {
      return;
    }
    this.visualizer.loadPreset(preset, blendTimeSec);
  }

  resize(): void {
    if (!this.visualizer) {
      return;
    }

    const width = Math.max(1, Math.floor(this.canvas.clientWidth || this.canvas.width || 1));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight || this.canvas.height || 1));
    this.canvas.width = width;
    this.canvas.height = height;
    this.visualizer.setRendererSize(width, height);
  }

  start(): void {
    if (!this.visualizer || this.animationFrameId !== null) {
      return;
    }

    void this.audioGraph.resume().catch(() => {
      // Resume failures are surfaced through user interaction; the visualizer can remain paused.
    });

    const renderFrame = () => {
      this.visualizer?.render();
      this.animationFrameId = window.requestAnimationFrame(renderFrame);
    };

    this.animationFrameId = window.requestAnimationFrame(renderFrame);
  }

  stop(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  dispose(): void {
    this.stop();
    this.audioGraph.dispose();
    this.visualizer = null;
    this.connectedMediaElement = null;
  }
}
