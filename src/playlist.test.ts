import { getAdjacentIndexAfterRemoval, markPlaylistItemPlayed, movePlaylistItem, setCurrentPlaylistItem, type PlaylistItem } from './playlist';

function createItems(): PlaylistItem<string>[] {
  return [
    { id: 'a', source: 'a', name: 'a.mp4', status: 'current' },
    { id: 'b', source: 'b', name: 'b.mp4', status: 'pending' },
    { id: 'c', source: 'c', name: 'c.mp4', status: 'pending' },
  ];
}

describe('playlist helpers', () => {
  it('moves playlist items', () => {
    const moved = movePlaylistItem(createItems(), 0, 2);
    expect(moved.map((item) => item.id)).toEqual(['b', 'c', 'a']);
  });

  it('marks next current and previous as played', () => {
    const updated = setCurrentPlaylistItem(createItems(), 'b');
    expect(updated.map((item) => `${item.id}:${item.status}`)).toEqual([
      'a:played',
      'b:current',
      'c:pending',
    ]);
  });

  it('can switch current item without marking previous as played', () => {
    const updated = setCurrentPlaylistItem(createItems(), 'b', { markPreviousAsPlayed: false });
    expect(updated.map((item) => `${item.id}:${item.status}`)).toEqual([
      'a:pending',
      'b:current',
      'c:pending',
    ]);
  });

  it('marks an item as played', () => {
    const updated = markPlaylistItemPlayed(createItems(), 'a');
    expect(updated[0].status).toBe('played');
  });

  it('finds adjacent item after removal', () => {
    expect(getAdjacentIndexAfterRemoval(1, 2)).toBe(1);
    expect(getAdjacentIndexAfterRemoval(2, 2)).toBe(1);
    expect(getAdjacentIndexAfterRemoval(0, 0)).toBeNull();
  });
});
