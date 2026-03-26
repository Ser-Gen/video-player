import type { PlaylistItemStatus } from './types';

export interface PlaylistItem<TFile = File> {
  id: string;
  file: TFile;
  name: string;
  status: PlaylistItemStatus;
}

type PlaylistStatusCarrier = {
  id: string;
  status: PlaylistItemStatus;
};

export function movePlaylistItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items.slice();
  }

  const next = items.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function setCurrentPlaylistItem<T extends PlaylistStatusCarrier>(
  items: T[],
  currentId: string,
  options?: { markPreviousAsPlayed?: boolean },
): T[] {
  const previousCurrentId = items.find((item) => item.status === 'current')?.id ?? null;

  return items.map((item) => {
    if (item.id === currentId) {
      return { ...item, status: 'current' };
    }

    if (
      item.id === previousCurrentId &&
      item.id !== currentId &&
      options?.markPreviousAsPlayed !== false
    ) {
      return { ...item, status: 'played' };
    }

    if (item.status === 'current') {
      return { ...item, status: 'pending' };
    }

    return item;
  });
}

export function markPlaylistItemPlayed<T extends PlaylistStatusCarrier>(items: T[], itemId: string): T[] {
  return items.map((item) => (item.id === itemId ? { ...item, status: 'played' } : item));
}

export function getAdjacentIndexAfterRemoval(removedIndex: number, nextLength: number): number | null {
  if (nextLength <= 0) {
    return null;
  }

  if (removedIndex < nextLength) {
    return removedIndex;
  }

  return nextLength - 1;
}
