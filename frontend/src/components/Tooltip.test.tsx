import { render, screen } from '@testing-library/react';
import Tooltip from './Tooltip';

describe('Tooltip', () => {
  it('renders children', () => {
    render(
      <Tooltip tooltip="Help text">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.getByRole('button', { name: /Hover me/ })).toBeInTheDocument();
  });

  it('shows tooltip text in DOM (tooltip bubble exists)', () => {
    render(
      <Tooltip tooltip="Help text">
        <span>Trigger</span>
      </Tooltip>
    );
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text');
  });
});
