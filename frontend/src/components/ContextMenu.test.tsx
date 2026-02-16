import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ContextMenu from './ContextMenu';

describe('ContextMenu', () => {
  it('renders at given position and calls onDelete when delete clicked', () => {
    const onClose = vi.fn();
    const onDelete = vi.fn();
    render(
      <ContextMenu x={100} y={200} onClose={onClose} onDelete={onDelete} />
    );
    const deleteItem = screen.getByText('מחק נקודה');
    fireEvent.click(deleteItem);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onEdit when edit option clicked when onEdit provided', () => {
    const onClose = vi.fn();
    const onEdit = vi.fn();
    render(
      <ContextMenu x={0} y={0} onClose={onClose} onDelete={() => {}} onEdit={onEdit} />
    );
    fireEvent.click(screen.getByText('ערוך / הזז נקודה'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <ContextMenu x={0} y={0} onClose={onClose} onDelete={() => {}} />
    );
    vi.advanceTimersByTime(20);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
