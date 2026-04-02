export interface AudioGraphSupportState {
  supported: boolean;
  message: string;
}

function unsupportedState(message: string): AudioGraphSupportState {
  return {
    supported: false,
    message,
  };
}

function getAudioContextConstructor():
  | (new () => AudioContext)
  | undefined {
  return window.AudioContext ?? (window as typeof window & { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
}

export class MediaAudioGraphController {
  private audioContext: AudioContext | null = null;
  private mediaSourceNode: MediaElementAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private connectedMediaElement: HTMLMediaElement | null = null;
  private supportState: AudioGraphSupportState = {
    supported: true,
    message: 'Audio graph is available.',
  };

  async ensureInitialized(): Promise<AudioGraphSupportState> {
    const AudioContextConstructor = getAudioContextConstructor();
    if (!AudioContextConstructor) {
      this.supportState = unsupportedState('Volume boost is unavailable because the Web Audio API is not supported.');
      return this.supportState;
    }

    if (this.audioContext && this.gainNode) {
      return this.supportState;
    }

    try {
      if (!this.audioContext) {
        this.audioContext = new AudioContextConstructor();
      }

      if (!this.gainNode) {
        this.gainNode = this.audioContext.createGain();
        this.gainNode.connect(this.audioContext.destination);
      }

      this.supportState = {
        supported: true,
        message: 'Audio graph is available.',
      };
    } catch (error) {
      this.supportState = unsupportedState(
        error instanceof Error ? error.message : 'Volume boost is unavailable because the audio graph could not be created.',
      );
    }

    return this.supportState;
  }

  async attachMediaElement(mediaElement: HTMLMediaElement): Promise<AudioGraphSupportState> {
    const initState = await this.ensureInitialized();
    if (!initState.supported || !this.audioContext || !this.gainNode) {
      return initState;
    }

    if (this.connectedMediaElement === mediaElement && this.audioContext && this.mediaSourceNode && this.gainNode) {
      return this.supportState;
    }

    try {
      if (!this.mediaSourceNode || this.connectedMediaElement !== mediaElement) {
        if (this.mediaSourceNode) {
          this.mediaSourceNode.disconnect();
        }
        this.mediaSourceNode = this.audioContext.createMediaElementSource(mediaElement);
      }

      this.mediaSourceNode.disconnect();
      this.mediaSourceNode.connect(this.gainNode);
      this.connectedMediaElement = mediaElement;
      this.supportState = {
        supported: true,
        message: 'Audio graph is available.',
      };
    } catch (error) {
      this.supportState = unsupportedState(
        error instanceof Error ? error.message : 'Volume boost is unavailable because the audio graph could not be created.',
      );
    }

    return this.supportState;
  }

  getSourceNode(): MediaElementAudioSourceNode | null {
    return this.mediaSourceNode;
  }

  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }

  setGain(value: number): void {
    if (!this.gainNode) {
      return;
    }

    this.gainNode.gain.value = value;
  }

  async resume(): Promise<void> {
    if (!this.audioContext) {
      return;
    }

    await this.audioContext.resume();
  }

  dispose(): void {
    if (this.mediaSourceNode) {
      this.mediaSourceNode.disconnect();
      this.mediaSourceNode = null;
    }

    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => {
        // Ignore close failures during shutdown.
      });
      this.audioContext = null;
    }

    this.connectedMediaElement = null;
  }
}
