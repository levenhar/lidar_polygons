import { render, screen, act, fireEvent } from '@testing-library/react';
import SuccessNotification from './SuccessNotification';

describe('SuccessNotification', () => {
  it('returns null when not open', () => {
    const { container } = render(
      <SuccessNotification isOpen={false} message="Done" onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows message when open', () => {
    render(
      <SuccessNotification isOpen={true} message="Saved successfully" onClose={() => {}} />
    );
    expect(screen.getByText('Saved successfully')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    render(
      <SuccessNotification isOpen={true} message="Done" onClose={onClose} />
    );
    fireEvent.click(screen.getByRole('button', { name: /×/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose after autoCloseDelay with fake timers', () => {
    const onClose = vi.fn();
    vi.useFakeTimers();
    render(
      <SuccessNotification isOpen={true} message="Done" onClose={onClose} autoCloseDelay={3000} />
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
