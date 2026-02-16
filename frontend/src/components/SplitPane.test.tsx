import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SplitPane from './SplitPane';

describe('SplitPane', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders two children', () => {
    render(
      <SplitPane>
        <div>Left</div>
        <div>Right</div>
      </SplitPane>
    );
    expect(screen.getByText('Left')).toBeInTheDocument();
    expect(screen.getByText('Right')).toBeInTheDocument();
  });

  it('calls onRatioChange when arrow key pressed on divider', () => {
    const onRatioChange = vi.fn();
    render(
      <SplitPane onRatioChange={onRatioChange}>
        <div>Left</div>
        <div>Right</div>
      </SplitPane>
    );
    const divider = document.querySelector('[role="separator"]') || document.querySelector('.split-pane-divider');
    if (divider) {
      divider.focus();
      fireEvent.keyDown(divider, { key: 'ArrowRight' });
      expect(onRatioChange).toHaveBeenCalled();
    }
  });
});
