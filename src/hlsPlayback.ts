import Hls from 'hls.js';

export interface HlsClient {
  attachMedia(media: HTMLMediaElement): void;
  loadSource(url: string): void;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface HlsClientFactory {
  create(): HlsClient;
  isSupported(): boolean;
}

class HlsJsClient implements HlsClient {
  constructor(private readonly instance: Hls) {}

  attachMedia(media: HTMLMediaElement): void {
    this.instance.attachMedia(media);
  }

  loadSource(url: string): void {
    this.instance.loadSource(url);
  }

  destroy(): void {
    this.instance.destroy();
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    this.instance.on(event as never, listener as never);
  }
}

export const defaultHlsClientFactory: HlsClientFactory = {
  create(): HlsClient {
    return new HlsJsClient(new Hls());
  },
  isSupported(): boolean {
    return Hls.isSupported();
  },
};

export const HLS_MEDIA_ATTACHED_EVENT = Hls.Events.MEDIA_ATTACHED;
export const HLS_ERROR_EVENT = Hls.Events.ERROR;
